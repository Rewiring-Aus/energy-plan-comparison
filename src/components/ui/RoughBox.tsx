import { useEffect, useRef, type ReactNode } from 'react';
import rough from 'roughjs';

interface RoughBoxProps {
  children: ReactNode;
  stroke?: string;
  strokeWidth?: number;
  roughness?: number;
  bowing?: number;
  fill?: string;
  fillStyle?: string;
  /** Stable seed so the sketch doesn't reshuffle on every redraw. */
  seed?: number;
  className?: string;
  /** Inset of the drawn rectangle from the element edge. */
  inset?: number;
}

/**
 * Wraps children and draws a hand-drawn rough.js rectangle behind them, redrawing
 * on size changes. Ported from the Rewiring Australia "petrol bowser" project.
 */
export function RoughBox({
  children,
  stroke = '#4a00c3',
  strokeWidth = 1.5,
  roughness = 1.5,
  bowing = 1.5,
  fill,
  fillStyle = 'solid',
  seed = 1,
  className,
  inset = 2,
}: RoughBoxProps) {
  const wrapRef = useRef<HTMLSpanElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const svg = svgRef.current;
    if (!wrap || !svg) return;

    const draw = () => {
      const w = wrap.offsetWidth;
      const h = wrap.offsetHeight;
      if (!w || !h) return;
      svg.setAttribute('width', String(w));
      svg.setAttribute('height', String(h));
      svg.innerHTML = '';
      const rc = rough.svg(svg);
      const opts: Record<string, unknown> = { roughness, bowing, seed };
      if (fill) {
        opts.fill = fill;
        opts.fillStyle = fillStyle;
        opts.stroke = stroke ?? 'none';
        opts.strokeWidth = strokeWidth;
      } else {
        opts.stroke = stroke;
        opts.strokeWidth = strokeWidth;
      }
      svg.appendChild(
        rc.rectangle(inset, inset, Math.max(1, w - inset * 2), Math.max(1, h - inset * 2), opts),
      );
    };

    draw();
    let pending = false;
    const ro = new ResizeObserver(() => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        draw();
      });
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [stroke, strokeWidth, roughness, bowing, fill, fillStyle, seed, inset]);

  return (
    <span ref={wrapRef} className={`rough-wrap${className ? ` ${className}` : ''}`}>
      {children}
      <svg ref={svgRef} className="rough-svg" aria-hidden="true" />
    </span>
  );
}
