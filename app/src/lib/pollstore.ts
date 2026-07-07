// A tiny module-level polling store: one poll per query, shared across every
// component that subscribes (N subscribers ⇒ 1 request). On failure it keeps the
// last-good data rendered and retries with exponential backoff + jitter, so a
// rate-limited RPC (HTTP 429) never blanks the UI. Polling pauses while the tab is
// hidden and refreshes once on return. Pure TS (no React) so it is unit-testable.

export interface StoreState<T> {
  data: T | null;          // last-good value (survives failures)
  error: string | null;    // last error message (for the cold-start panel)
  stale: boolean;          // last poll failed but we still have data
  lastUpdated: number | null; // epoch ms of the last SUCCESS
  loading: boolean;        // a fetch is in flight
}

/** Exponential backoff with symmetric jitter: base·2^attempt, capped, ± jitter.
 * Deterministic when `rng` is injected — the schedule is unit-tested. */
export function backoffDelay(
  attempt: number,
  opts: { base?: number; cap?: number; jitter?: number } = {},
  rng: () => number = Math.random,
): number {
  const base = opts.base ?? 2000, cap = opts.cap ?? 60000, jitter = opts.jitter ?? 0.25;
  const raw = Math.min(cap, base * 2 ** Math.max(0, attempt));
  const delta = raw * jitter * (rng() * 2 - 1);   // ± jitter·raw
  return Math.max(0, Math.round(raw + delta));
}

const isHidden = (): boolean => typeof document !== "undefined" && document.visibilityState === "hidden";

const EMPTY = Object.freeze({ data: null, error: null, stale: false, lastUpdated: null, loading: false });

export class PollStore<T> {
  private st: StoreState<T> = EMPTY as StoreState<T>;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private inflight = false;
  private started = false;
  private frozen = false;
  private onVis = () => { if (!isHidden()) this.poll(); };
  private fetcher: () => Promise<T>;
  private intervalMs: number;
  private rng: () => number;

  constructor(fetcher: () => Promise<T>, intervalMs: number, rng: () => number = Math.random) {
    this.fetcher = fetcher;
    this.intervalMs = intervalMs;
    this.rng = rng;
  }

  /** Current immutable snapshot (stable ref between changes — safe for
   * useSyncExternalStore). */
  getState = (): StoreState<T> => this.st;

  /** Subscribe; the first subscriber starts polling, the last one stops it. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  };

  /** Force an immediate poll (used after a mutating tx). */
  refreshNow(): void { this.poll(); }

  /** Hydrate last-good data without a fetch (used by the dev harness to seed a
   * known state, and available for cache warming). */
  seed(data: T): void { this.set({ data, error: null, stale: false, lastUpdated: Date.now() }); }

  /** Dev/harness helpers: force the degraded state and stop polling, so the
   * stale-not-blank and cold-start UI states can be captured deterministically. */
  markError(error: string): void { this.set({ error, stale: this.st.data !== null }); }
  freeze(): void { this.frozen = true; if (this.timer) { clearTimeout(this.timer); this.timer = null; } }

  private start() {
    if (this.started) return;
    this.started = true;
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onVis);
    this.poll();
  }

  private stop() {
    this.started = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVis);
  }

  private set(patch: Partial<StoreState<T>>) {
    this.st = { ...this.st, ...patch };
    for (const l of this.listeners) l();
  }

  private schedule(ms: number) {
    if (this.timer) clearTimeout(this.timer);
    if (this.listeners.size === 0) return;   // nobody watching → don't reschedule
    this.timer = setTimeout(() => this.poll(), ms);
  }

  private async poll() {
    if (this.frozen || this.inflight) return; // frozen (harness) or dedup concurrent polls
    if (isHidden()) {                        // paused; visibility handler resumes
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      return;
    }
    this.inflight = true;
    this.set({ loading: true });
    try {
      const data = await this.fetcher();
      this.attempt = 0;                      // reset backoff on success
      this.set({ data, error: null, stale: false, lastUpdated: Date.now(), loading: false });
      this.schedule(this.intervalMs);
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      // keep last-good data; mark stale if we have any, else it's a cold error
      this.set({ error: msg, stale: this.st.data !== null, loading: false });
      this.schedule(backoffDelay(this.attempt++, {}, this.rng));
    } finally {
      this.inflight = false;
    }
  }
}

/** A registry of keyed stores so per-machine / per-position reads dedup across
 * components (same key ⇒ same store ⇒ one poll). */
const registry = new Map<string, PollStore<unknown>>();
export function keyedStore<T>(key: string, fetcher: () => Promise<T>, intervalMs: number): PollStore<T> {
  let s = registry.get(key) as PollStore<T> | undefined;
  if (!s) { s = new PollStore<T>(fetcher, intervalMs); registry.set(key, s); }
  return s;
}

export const EMPTY_STATE = EMPTY as StoreState<never>;
