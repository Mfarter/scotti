#!/usr/bin/env python3
# H6a house-math cross-check (the H0 Python discipline): generate tick->sqrtPrice
# vectors TWO independent ways and assert agreement, so the pinned Rust vectors
# are validated against the mathematical definition, not just self-consistent.
#   Way 1 — the Raydium per-bit magic-multiplier integer algorithm (what the
#           deployed CLMM uses; ported here to confirm the Rust port matches).
#   Way 2 — the true value floor(sqrt(1.0001^tick) * 2^64) at 120-digit precision.
# Way 1 truncates each intermediate >>64, so it is within a few ULP of Way 2;
# we assert |Way1 - Way2| is tiny AND pin the exact Way1 integers.
from decimal import Decimal, getcontext
getcontext().prec = 120

MAGIC = [
    0xfffcb933bd6fb800, 0xfff97272373d4000, 0xfff2e50f5f657000, 0xffe5caca7e10f000,
    0xffcb9843d60f7000, 0xff973b41fa98e800, 0xff2ea16466c9b000, 0xfe5dee046a9a3800,
    0xfcbe86c7900bb000, 0xf987a7253ac65800, 0xf3392b0822bb6000, 0xe7159475a2caf000,
    0xd097f3bdfd2f2000, 0xa9f746462d9f8000, 0x70d869a156f31c00, 0x31be135f97ed3200,
    0x09aa508b5b85a500, 0x005d6af8dedc582c, 0x00002216e584f5fa,
]
U128_MAX = (1 << 128) - 1
MIN_TICK, MAX_TICK = -443636, 443636

def way1_magic(tick):  # Raydium get_sqrt_price_at_tick, exact integer
    a = abs(tick)
    ratio = MAGIC[0] if (a & 0x1) else (1 << 64)
    bit = 0x2
    for i in range(1, 19):
        if a & bit:
            ratio = (ratio * MAGIC[i]) >> 64
        bit <<= 1
    if tick > 0:
        ratio = U128_MAX // ratio
    return ratio

def isqrt(n):
    if n < 0: raise ValueError
    x = int(Decimal(n).sqrt())
    while x*x > n: x -= 1
    while (x+1)*(x+1) <= n: x += 1
    return x

def way2_true(tick):  # floor(sqrt(1.0001^tick) * 2^64) at high precision
    base = Decimal("1.0001") ** tick
    val = (base.sqrt()) * (Decimal(2) ** 64)
    return int(val)  # floor

# Raydium's published boundary constants — exact-equality anchors.
assert way1_magic(MIN_TICK) == 4295048016, way1_magic(MIN_TICK)
assert way1_magic(MAX_TICK) == 79226673521066979257578248091, way1_magic(MAX_TICK)
print("OK  boundary constants match Raydium's published MIN/MAX_SQRT_PRICE_X64")

TICKS = [MIN_TICK, -100000, -69081, -10, -1, 0, 1, 10, 69081, 69082, 100000, MAX_TICK]
print(f"\n{'tick':>8} {'way1_magic (sqrtX64)':>32} {'|w1-w2|':>10}  price_1e12")
rows = []
for t in TICKS:
    w1 = way1_magic(t)
    w2 = way2_true(t)
    diff = abs(w1 - w2)
    # price scaled 1e12 from way1: (w1^2 >> 64) * 1e12 >> 64
    price_x64 = (w1 * w1) >> 64
    price_1e12 = (price_x64 * 10**12) >> 64
    rows.append((t, w1, price_1e12))
    # per-bit truncation gives small RELATIVE error (bounded, ~1e-12 here); assert
    # rel < 1e-9 — orders of magnitude tighter than the 300bp price band.
    rel = diff / w2 if w2 else 0
    assert rel < 1e-9, f"tick {t}: rel err {rel:.3e} too large (diff {diff})"
    print(f"{t:>8} {w1:>32} {diff:>10}  {price_1e12}")
print("\nOK  every tick: relative error of magic vs true sqrt < 1e-9 (correct math)")

# emit the pinned Rust table
print("\n// paste into house-math tick_price proofs:")
print("const PINNED: &[(i32, u128, u128)] = &[")
for t, w1, p in rows:
    print(f"    ({t}, {w1}, {p}),")
print("];")
