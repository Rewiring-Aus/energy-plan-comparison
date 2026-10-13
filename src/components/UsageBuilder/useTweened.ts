import { useLayoutEffect, useRef, useState } from 'react';
import { easeOutCubic, lerpArray } from '../../lib/chartAnim';

type Shape = Record<string, number | number[]>;

/** True when the user has asked the OS to minimise motion. */
export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function interpolate<T extends Shape>(from: Shape, to: T, t: number): T {
  const out: Shape = {};
  for (const [k, b] of Object.entries(to)) {
    const a = from[k];
    if (Array.isArray(b)) out[k] = lerpArray(Array.isArray(a) ? a : [], b, t);
    else out[k] = typeof a === 'number' ? a + (b - a) * t : b;
  }
  return out as T;
}

/**
 * Smoothly tween a bag of numbers / number arrays towards `target`. Returns the values to render
 * this frame. A target change mid-tween restarts from what's currently on screen (no jumps); a
 * series that appears grows up from 0. `immediate` (e.g. while dragging) and reduced-motion
 * snap straight to the target.
 */
export function useTweened<T extends Shape>(target: T, { duration = 450, immediate = false } = {}): T {
  const [display, setDisplay] = useState<T>(target);
  const shownRef = useRef<Shape>(target);
  const rafRef = useRef<number | null>(null);
  const snap = immediate || prefersReducedMotion();
  // Deep-compare by value: callers rebuild arrays every render.
  const key = JSON.stringify(target);

  useLayoutEffect(() => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    if (snap) {
      shownRef.current = target;
      setDisplay(target);
      return;
    }
    const from = shownRef.current;
    const start = performance.now();
    const tick = (now: number) => {
      const t = easeOutCubic((now - start) / duration);
      const v = interpolate(from, target, t);
      shownRef.current = v;
      setDisplay(v);
      rafRef.current = t < 1 ? requestAnimationFrame(tick) : null;
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
    // `key` captures every value in `target`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, snap, duration]);

  return snap ? target : display;
}
