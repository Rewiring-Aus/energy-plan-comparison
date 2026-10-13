import { useEffect, type CSSProperties } from 'react';
import { prefersReducedMotion } from './useTweened';

const DURATION_MS = 4200; // two 1.8s cycles + fade

interface Props {
  vw: number;
  vh: number;
  /** Bar slot geometry in viewBox units. */
  x: number;
  width: number;
  /** Top of the real bar and the zero line (bar bottom). */
  top: number;
  bottom: number;
  /** Top of the plot — the ghost never grows past it. */
  plotTop: number;
  onDone: () => void;
}

/**
 * A one-off demonstration of dragging: a ghost bar over a real one stretches up and squashes down
 * while a grab handle rides its top, with a speech bubble explaining. Purely visual — the profile
 * isn't touched, so plans don't re-rank. Remount (new `key`) to replay.
 */
export function DragHint({ vw, vh, x, width, top, bottom, plotTop, onDone }: Props) {
  const still = prefersReducedMotion();
  useEffect(() => {
    const t = setTimeout(onDone, still ? 4000 : DURATION_MS);
    return () => clearTimeout(t);
  }, [onDone, still]);

  const h = Math.max(30, bottom - top);
  const barTop = bottom - h;
  const up = Math.min(1.45, (bottom - plotTop - 4) / h);
  const vars = { '--h': h, '--up': up, '--down': 0.6 } as CSSProperties;
  const cx = x + width / 2;
  // Bubble sits BESIDE the bar (towards the chart's middle) so it stays inside the plot rather
  // than covering the caption above.
  const side = cx > vw / 2 ? 'left' : 'right';
  const anchorX = side === 'left' ? x : x + width;
  const anchorY = Math.max(barTop, plotTop + 26);

  return (
    <div className={`drag-hint${still ? ' still' : ''}`} aria-hidden="true">
      <svg viewBox={`0 0 ${vw} ${vh}`} className="drag-hint-svg">
        <g style={vars}>
          <rect className="hint-bar" x={x} y={barTop} width={width} height={h} rx={2} />
          <g className="hint-grip">
            <circle cx={cx} cy={barTop} r={9} />
            <path d={`M${cx - 4} ${barTop - 2} l4 -4 l4 4 M${cx - 4} ${barTop + 2} l4 4 l4 -4`} />
          </g>
        </g>
      </svg>
      <div className={`hint-bubble side-${side}`} style={{ left: `${(anchorX / vw) * 100}%`, top: `${(anchorY / vh) * 100}%` }}>
        Drag the bars up or down to move your usage
      </div>
    </div>
  );
}
