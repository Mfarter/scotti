import { useEffect, useRef } from "react";

// UI-6 — the scroll-linked fresco reveal. The .os-bg-img holds the dithered Last
// Judgment sized to COVER the viewport width with guaranteed vertical overflow;
// on scroll it is translated so the composition's full vertical arc (heaven at
// the top, the damned at the bottom) maps onto the page's scroll on EVERY route,
// regardless of page length. Short / no-scroll pages clamp to the top of the
// fresco (the UI-5 look). The scrim (.os-bg::after) stays viewport-fixed.
//
// Fallback path (kept as the UI-5 static fixed+cover look): used when JS hasn't
// hydrated (no `data-scroll` attribute) OR the user prefers reduced motion — the
// img is object-fit:cover, no transform. Motion adds `data-scroll="on"` on the
// shell, which switches the img to full-height + the translate.
//
// Perf: one transform write per animation frame (rAF-throttled scroll, no layout
// reads in the scroll path beyond cheap window.scrollY); measurements are cached
// and refreshed only on resize / route change / document-height change (a
// ResizeObserver on <body>, its callback deferred to rAF to avoid RO loops). The
// translate is rounded to whole pixels so the `pixelated` dither never shimmers.

const TRAVEL = 1.35; // portrait viewports: min display height = TRAVEL × viewport, so the fresco still traverses

export function FrescoBg({ treat }: { treat: string }) {
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    // reduced motion (or no matchMedia) → leave the static fixed+cover fallback.
    if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const shell = img.closest(".os-shell") as HTMLElement | null;
    shell?.setAttribute("data-scroll", "on");

    let range = 0, maxScroll = 1, ticking = false, roScheduled = false;

    const measure = () => {
      const natW = img.naturalWidth || 800, natH = img.naturalHeight || 881;
      const aspect = natW / natH;
      const vpW = window.innerWidth, vpH = window.innerHeight;
      // cover the width, but never shorter than TRAVEL × viewport height (so a tall
      // narrow phone still gets vertical travel). dispW ≥ vpW always ⇒ width covered.
      const dispH = Math.max(vpW / aspect, vpH * TRAVEL);
      const dispW = dispH * aspect;
      img.style.width = `${dispW}px`;
      img.style.height = `${dispH}px`;
      img.style.left = `${Math.round((vpW - dispW) / 2)}px`;
      range = Math.max(0, dispH - vpH);
      maxScroll = Math.max(1, document.documentElement.scrollHeight - vpH);
      apply();
    };
    const apply = () => {
      // progress 0 at scroll-top → 1 at page-bottom; short pages clamp to 0 (top of the fresco).
      const p = range === 0 ? 0 : Math.min(1, Math.max(0, window.scrollY / maxScroll));
      img.style.transform = `translate3d(0, ${-Math.round(p * range)}px, 0)`;
    };
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => { apply(); ticking = false; });
    };
    const scheduleMeasure = () => {
      if (roScheduled) return;
      roScheduled = true;
      requestAnimationFrame(() => { roScheduled = false; measure(); });
    };

    if (img.complete && img.naturalWidth) measure();
    else img.addEventListener("load", measure, { once: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", measure);
    // async content (e.g. the Floor filling in) changes docHeight → remeasure maxScroll.
    // The img is position:absolute in a fixed parent, so measure() never resizes <body>
    // — no feedback loop; the rAF defer also silences the RO-loop warning.
    const ro = new ResizeObserver(scheduleMeasure);
    ro.observe(document.body);

    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", measure);
      ro.disconnect();
      shell?.removeAttribute("data-scroll");
      img.style.transform = img.style.width = img.style.height = img.style.left = "";
    };
    // re-run when the treatment (and thus the src) changes; the ResizeObserver covers
    // route changes that keep the same treatment but change the document height.
  }, [treat]);

  return (
    <div className="os-bg" aria-hidden>
      <img ref={imgRef} className="os-bg-img" src={`/bg-${treat}.png`} alt="" decoding="async" />
    </div>
  );
}
