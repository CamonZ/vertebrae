/**
 * Motion model for machine diagrams: pure functions of elapsed time.
 *
 * Numbers follow the catalogue's VL-06 (thrown travel ζ 0.78, pop k 260 c 11,
 * clamp k 420 c 30) and VL-04 (status swap). Every function here is pure so a
 * frame is a deterministic function of `t` and can be seeked in any direction.
 */

/** Unit step response of a damped spring with stiffness `k` and damping `c`. */
export function spring(dt: number, k: number, c: number): number {
  if (dt <= 0) return 0;
  const w = Math.sqrt(k);
  const z = c / (2 * w);
  if (z >= 1) return 1 - (1 + w * dt) * Math.exp(-w * dt);
  const s = Math.sqrt(1 - z * z);
  const wd = w * s;
  return (
    1 -
    Math.exp(-z * w * dt) * (Math.cos(wd * dt) + (z / s) * Math.sin(wd * dt))
  );
}

/** Damping ratio of the thrown travel spring (VL-06). */
export const THROWN_ZETA = 0.78;

/**
 * Travel spring tuned so the first crossing of the target happens at
 * `duration`; afterwards it overshoots slightly and settles.
 */
export function thrown(
  dt: number,
  duration: number,
  zeta = THROWN_ZETA
): number {
  const d = Math.sqrt(1 - zeta * zeta);
  const f = (Math.PI - Math.atan(d / zeta)) / (d * duration);
  return spring(dt, f * f, 2 * zeta * f);
}

export const POP_SPRING = { k: 260, c: 11 } as const;
export const CLAMP_SPRING = { k: 420, c: 30 } as const;

/** Pop spring for rings, bars, dots and lamps. */
export const pop = (dt: number) => spring(dt, POP_SPRING.k, POP_SPRING.c);
/** Clamp spring for plates and latches. */
export const clamp = (dt: number) => spring(dt, CLAMP_SPRING.k, CLAMP_SPRING.c);

/** Hermite smoothstep of `x` between edges `a` and `b`, clamped to [0, 1]. */
export function smoothstep(a: number, b: number, x: number): number {
  const u = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return u * u * (3 - 2 * u);
}

/** 0 → 1 over 0.15 s from `a`, then back to 0 over 0.25 s from `b`. */
export function windowed(t: number, a: number, b: number): number {
  return smoothstep(a, a + 0.15, t) * (1 - smoothstep(b, b + 0.25, t));
}

/** Clamp spring engaged at `a` and released at `b` (plates, latches). */
export function held(t: number, a: number, b: number): number {
  return Math.max(0, clamp(t - a) - clamp(t - b));
}

/** Short slide used by pointers and value tracks. */
export const slide = (dt: number) => thrown(dt, 0.35);

/**
 * A value that springs from one entry to the next: `[[time, value], ...]`
 * sorted by time. Before the second entry the first value holds.
 */
export function track(
  list: readonly (readonly [number, number])[],
  t: number,
  ease: (dt: number) => number
): number {
  let i = 0;
  while (i + 1 < list.length && list[i + 1][0] <= t) i++;
  if (i === 0) return list[0][1];
  const from = list[i - 1][1];
  const to = list[i][1];
  return from + (to - from) * ease(t - list[i][0]);
}

/** The last entry whose time is at or before `t` (first entry otherwise). */
export function valueAt<T>(
  list: readonly (readonly [number, T])[],
  t: number
): T {
  let value = list[0][1];
  for (const [at, v] of list) if (t >= at) value = v;
  return value;
}

/** Final 0.6 s of every loop fades back to idle (VL-06). */
export function loopFade(period: number, t: number): number {
  return 1 - smoothstep(period - 0.6, period - 0.2, t);
}

/** Smear: ten ghosts spaced 6 ms apart behind a travelling card (VL-06). */
export const SMEAR_GHOSTS = 10;
export const SMEAR_STEP = 0.006;
/** Lean, in degrees, of a card leaving a slot (VL-06). */
export const LEAN_DEGREES = 38;

/** Status line swap (VL-04): out 16 px up in 0.1 s, in from 14 px below. */
export const STATUS_SWAP = {
  outDistance: 16,
  outDuration: 0.1,
  inDistance: 14,
  inDuration: 0.26,
} as const;
