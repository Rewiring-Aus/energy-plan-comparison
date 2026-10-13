import { useLayoutEffect, useState, type RefObject } from 'react';

/**
 * viewBox units per on-screen pixel for an SVG drawn at `viewBoxWidth` — i.e. how much to scale
 * text so it renders at a fixed pixel size however wide the chart is laid out. Tracks resizes.
 */
export function useChartScale(ref: RefObject<SVGSVGElement | null>, viewBoxWidth: number): number {
  const [k, setK] = useState(1.3); // typical desktop until measured
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = el.getBoundingClientRect().width;
      if (w > 0) setK(viewBoxWidth / w);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, viewBoxWidth]);
  return k;
}
