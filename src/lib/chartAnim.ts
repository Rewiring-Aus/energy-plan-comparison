// Pure helpers for animating the usage charts (tweening + axis ticks). Kept free of React/DOM so
// they're unit-testable.

/** Decelerating ease: fast start, gentle settle. t in [0,1]. */
export function easeOutCubic(t: number): number {
  const k = Math.max(0, Math.min(1, t));
  return 1 - (1 - k) ** 3;
}

/**
 * Interpolate two numeric arrays at t ∈ [0,1]. The result has `to`'s length; any start value
 * missing from `from` is treated as 0, so a newly appearing series grows up from the axis.
 */
export function lerpArray(from: readonly number[], to: readonly number[], t: number): number[] {
  return to.map((b, i) => {
    const a = from[i] ?? 0;
    return a + (b - a) * t;
  });
}

/**
 * Gridline values from 0 up to (and not exceeding) `max`, on a 1/2/5×10ⁿ step chosen to give
 * roughly 3–5 lines. e.g. 3.7 → [0,1,2,3]; 0.6 → [0,0.2,0.4,0.6].
 */
export function niceTicks(max: number): number[] {
  if (!(max > 0) || !Number.isFinite(max)) return [0];
  const rough = max / 4;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / mag;
  const step = (norm <= 1.2 ? 1 : norm <= 2.5 ? 2 : norm <= 6 ? 5 : 10) * mag;
  const ticks: number[] = [];
  // Round each tick to the step's precision so float drift doesn't produce 0.30000000000000004.
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  for (let v = 0; v <= max + step * 1e-9; v += step) ticks.push(Number(v.toFixed(decimals)));
  return ticks;
}
