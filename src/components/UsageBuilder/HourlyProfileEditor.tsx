import { useCallback, useEffect, useRef, useState } from 'react';
import { useUsageStore } from '../../store/usageStore';
import { APPLIANCE_META, soakWindowLabel } from '../../data/applianceProfiles';
import { stateForPostcode } from '../../data/energyModel';
import { resolveTouRate, resolveFitRate } from '../../lib/time';
import { billingDays } from '../../lib/costEngine';
import { niceTicks } from '../../lib/chartAnim';
import type { BillingPeriod, CostResult, DayType, Plan, SolarEffectiveness, TouLabel, UsageProfile, Behaviours } from '../../types';
import { FlexibleLoads } from './FlexibleLoads';
import { DragHint } from './DragHint';
import { dragHintSeen, markDragHintSeen } from './dragHintStorage';
import { prefersReducedMotion, useTweened } from './useTweened';
import { useChartScale } from './useChartScale';

const VW = 720;
const VH = 270;
// `top` includes a header lane above the plot for the billed chart's period labels; `left` and
// `bottom` leave room for axis labels at their on-screen size (see axisStyle).
const M = { left: 46, right: 8, top: 26, bottom: 26 };
const PLOT_W = VW - M.left - M.right;
const PLOT_H = VH - M.top - M.bottom;
const SLOT = PLOT_W / 24;
const BAR_W = SLOT * 0.78;
const BAR_PAD = (SLOT - BAR_W) / 2;

const TOU_FILL: Record<TouLabel, string> = { PEAK: '#c0392b', SHOULDER: '#e08a1e', OFFPEAK: '#4f9e6a' };
const FLAT_FILL = '#4a00c3';
const FREE_FILL = '#12c46e'; // vivid green — free periods should pop vs the muted off-peak green
const EXPORT_FILL = '#3b7dd8';
const WHOLESALE_FILL = '#6b46c1';
const PRICE_LINE = '#e0a020';
// Off-peak scales green (cheapest) → yellow-green (dearest) by price, like the shoulder ramp.
const OFFPEAK_LOW = '#4f9e6a';
const OFFPEAK_HIGH = '#8faa39';
/** How long the dashed "before" outline lingers after a flexible-load toggle (matches the CSS fade). */
const GHOST_MS = 1800;
/** How long the savings badge stays up after a toggle (the CSS fade-out ends at the same time). */
const BADGE_MS = 6000;

const BAND_COLOR: Record<string, string> = {
  PEAK: '#c0392b',
  SHOULDER: '#e08a1e',
  OFFPEAK: '#4f9e6a',
  ANYTIME: '#4a00c3',
  FREE: '#12c46e',
  CONTROLLED_LOAD: '#1f9e8f',
  DEMAND: '#777',
  SOLAR: '#0d6e2d',
};

function money(v: number): string {
  const r = Math.round(v);
  return r < 0 ? `−$${Math.abs(r).toLocaleString('en-AU')}` : `$${r.toLocaleString('en-AU')}`;
}

/** Interpolate between two #rrggbb colours (t clamped 0..1). */
function lerpColor(a: string, b: string, t: number): string {
  const p = (s: string) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
  const [ar, ag, ab] = p(a);
  const [br, bg, bb] = p(b);
  const k = Math.max(0, Math.min(1, t));
  const h = (x: number, y: number) => Math.round(x + (y - x) * k).toString(16).padStart(2, '0');
  return `#${h(ar, br)}${h(ag, bg)}${h(ab, bb)}`;
}

/** Axis text ≈11px on screen: k = viewBox units per pixel (capped so labels fit the margins). */
const axisStyle = (k: number) => ({ '--axis-fs': `${Math.max(10, Math.min(22, 11 * k))}px` }) as React.CSSProperties;
/** Y-axis labels sit right-aligned just left of the plot. */
const Y_LABEL_X = M.left - 5;

/** Axis label for a gridline value: whole numbers bare, fractions to one decimal. */
const tickLabel = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

function isFreeHour(plan: Plan | undefined, hour: number, day: DayType): boolean {
  return !!plan?.freeWindows?.some(
    (w) => w.dayTypes.includes(day) && hour >= Math.floor(w.fromHour) && hour < Math.ceil(w.toHour),
  );
}
function touLabelAt(plan: Plan | undefined, hour: number, day: DayType): TouLabel | null {
  if (!plan?.touRates?.length) return null;
  return resolveTouRate(plan.touRates, hour, day)?.label ?? null;
}

const TOU_NAME: Record<TouLabel, string> = { PEAK: 'Peak', SHOULDER: 'Shoulder', OFFPEAK: 'Off-peak' };
/** Day type used to resolve TOU windows for display (shading/labels) — weekday is representative. */
const DISPLAY_DAY: DayType = 'WEEKDAY';
/** Energy bands tied to a time-of-day period (labelled on the billed chart, not chipped below). */
function isTimeBand(key: string): boolean {
  return key.includes('#') || key === 'FREE' || key === 'ANYTIME';
}

type Mode = 'loads' | 'billed';

/** The chart as it was just before a flexible-load toggle — drives the "before" outline + savings badge. */
interface ChangeSnapshot {
  id: number;
  at: number;
  import: number[];
  gross: number[];
  total: number | null;
}

/** A fading dashed outline of the previous bar heights. */
interface Ghost {
  id: number;
  values: number[];
}

interface Props {
  activePlan?: Plan;
  activeResult?: CostResult;
}

export function HourlyProfileEditor({ activePlan, activeResult }: Props) {
  const {
    profile,
    manualProfile,
    loads,
    gross,
    effectiveness,
    home,
    period,
    postcode,
    selectedPlanId,
    setEffectiveness,
    setManualImport,
    resetManual,
    behaviours,
    setBehaviour,
  } = useUsageStore();
  const soakLabel = soakWindowLabel(stateForPostcode(postcode));
  const [mode, setMode] = useState<Mode>('billed');
  const chartRef = useRef<HTMLDivElement>(null);
  const [change, setChange] = useState<ChangeSnapshot | null>(null);
  // Drag demo: `hintRun` remounts it (replay); `hintOn` shows it.
  const [hintRun, setHintRun] = useState(0);
  const [hintOn, setHintOn] = useState(false);

  const eff = manualProfile ?? profile;
  const edited = manualProfile != null;
  const imp = eff.import;
  const hasSolar = home.solarKw > 0;
  const bands = activeResult?.breakdown.usageBands ?? [];

  const impTotal = imp.reduce((a, b) => a + b, 0);
  const derivedTotal = profile.import.reduce((a, b) => a + b, 0);

  // Play the drag demo once, the first time someone sees the editable chart.
  useEffect(() => {
    if (mode !== 'billed' || dragHintSeen()) return;
    const t = setTimeout(() => {
      markDragHintSeen();
      setHintRun((n) => n + 1);
      setHintOn(true);
    }, 600);
    return () => clearTimeout(t);
  }, [mode]);
  const stopHint = useCallback(() => setHintOn(false), []);
  const replayHint = () => {
    setMode('billed');
    setHintRun((n) => n + 1);
    setHintOn(true);
  };

  // A tickbox flip: snapshot the chart first so the change animates from a visible "before".
  const onToggle = (patch: Partial<Behaviours>) => {
    setChange((c) => ({ id: (c?.id ?? 0) + 1, at: Date.now(), import: eff.import, gross, total: activeResult?.total ?? null }));
    setBehaviour(patch);
    const el = chartRef.current;
    if (el && !prefersReducedMotion()) {
      const r = el.getBoundingClientRect();
      if (r.top < 0 || r.bottom > window.innerHeight) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  };

  const ghostLive = change != null && Date.now() - change.at < GHOST_MS && !prefersReducedMotion();
  const periodWord = period === 'annual' ? 'year' : period === 'quarterly' ? 'quarter' : 'month';

  return (
    <div className="panel">
      {mode === 'billed' && <h2>See if you can shift your usage to save</h2>}
      <div className="editor-tabs">
        <div className="seg mode-seg">
          <button className={mode === 'loads' ? 'active' : ''} onClick={() => setMode('loads')}>
            What's using power
          </button>
          <button className={mode === 'billed' ? 'active' : ''} onClick={() => setMode('billed')}>
            What I'm paying for
          </button>
        </div>
      </div>

      <FlexibleLoads home={home} behaviours={behaviours} soakLabel={soakLabel} onToggle={onToggle} onTune={setBehaviour} />

      <div className="edit-toolbar">
        <span className="edit-total">
          {mode === 'billed' && (
            <>
              {impTotal.toFixed(1)} kWh/day
              {edited && Math.abs(impTotal - derivedTotal) > 0.05 && (
                <em>
                  {' '}({impTotal >= derivedTotal ? '+' : '−'}
                  {Math.abs(impTotal - derivedTotal).toFixed(1)} vs estimate)
                </em>
              )}
            </>
          )}
        </span>
        {change?.total != null && activeResult && (
          <SavingsBadge
            key={change.id}
            before={change.total}
            after={activeResult.total}
            who={selectedPlanId ? 'Your selected plan' : 'Cheapest plan'}
            periodWord={periodWord}
          />
        )}
        {mode === 'billed' && (
          <button className="hint-btn" onClick={replayHint}>
            ↕ How to edit
          </button>
        )}
        {mode === 'billed' && edited && (
          <button className="reset-btn" onClick={resetManual}>
            Reset
          </button>
        )}
      </div>

      <div ref={chartRef}>
        {mode === 'loads' ? (
          <LoadsChart loads={loads} ghost={ghostLive ? { id: change!.id, values: change!.gross } : undefined} />
        ) : (
          <BilledChart
            profile={eff}
            activePlan={activePlan}
            activeResult={activeResult}
            period={period}
            onEdit={(h, v) => setManualImport(h, v, true)}
            ghost={ghostLive ? { id: change!.id, values: change!.import } : undefined}
            hint={{ run: hintRun, on: hintOn, onDone: stopHint }}
          />
        )}
      </div>

      {/* Per-period cost contribution. In the billed view the time-of-use energy periods and the
          solar feed-in credit are shown directly on the chart, so only the other non-time costs
          (fixed, controlled load, demand) are chipped below; the loads view shows the full set. */}
      {activeResult && (
        <div className="period-chips">
          <span className="chip fixed">
            Fixed <b>{money(activeResult.fixedTotal)}</b>
          </span>
          {bands
            // Bands with no usage are listed on the plan card for reference; skip them as chips.
            .filter((b) => b.cost !== 0 || !isTimeBand(b.key))
            .filter((b) => mode === 'loads' || (!isTimeBand(b.key) && b.key !== 'SOLAR' && b.key !== 'WHOLESALE'))
            .map((b) => (
              <span
                key={b.key}
                className="chip"
                style={{ ['--chip' as string]: BAND_COLOR[b.key.split('#')[0]] ?? BAND_COLOR[b.key] ?? '#777' }}
              >
                <i className="dot" />
                {b.label} <b>{money(b.cost)}</b>
              </span>
            ))}
        </div>
      )}

      {hasSolar && (
        <div className="behaviour-row" style={{ marginTop: 12 }}>
          <span className="behaviour-label">Solar realism</span>
          <div className="seg">
            {(['optimistic', 'realistic', 'conservative'] as SolarEffectiveness[]).map((e) => (
              <button key={e} className={effectiveness === e ? 'active' : ''} onClick={() => setEffectiveness(e)}>
                {e[0].toUpperCase() + e.slice(1)}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Slides in after a flexible-load toggle with the bill before → after, then fades and unmounts. */
function SavingsBadge({ before, after, who, periodWord }: { before: number; after: number; who: string; periodWord: string }) {
  const [shown, setShown] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setShown(false), BADGE_MS);
    return () => clearTimeout(t);
  }, []);
  if (!shown) return null;
  const delta = after - before;
  const same = Math.abs(delta) < 1;
  return (
    <span className={`savings-badge${same ? '' : delta < 0 ? ' saved' : ' cost'}`} role="status">
      {who} now <b>{money(after)}</b>/{periodWord}{' '}
      {same ? '(no change)' : `(${delta < 0 ? '−' : '+'}${money(Math.abs(delta))})`}
    </span>
  );
}

// Labels sit on the slot boundary (left edge of each bar), with a tick, so it reads as
// "the hour starts here" rather than the label belonging to the whole bar.
const XLabels = () => (
  <>
    {Array.from({ length: 9 }, (_, i) => i * 3).map((h) => {
      const x = M.left + h * SLOT;
      const anchor = h === 0 ? 'start' : h === 24 ? 'end' : 'middle';
      return (
        <g key={`x${h}`}>
          <line x1={x} x2={x} y1={M.top + PLOT_H} y2={M.top + PLOT_H + 4} stroke="#0003" />
          <text className="axis-label" x={x} y={VH - 6} textAnchor={anchor}>
            {h}:00
          </text>
        </g>
      );
    })}
  </>
);

/** Dashed outlines at the previous bar heights; CSS fades them out. */
function GhostBars({ ghost, y, baseY }: { ghost: Ghost; y: (v: number) => number; baseY: number }) {
  return (
    <g className="ghost-outline" pointerEvents="none">
      {ghost.values.map((v, h) =>
        v > 0.001 ? <rect key={h} x={M.left + h * SLOT + BAR_PAD} y={y(v)} width={BAR_W} height={Math.max(0, baseY - y(v))} rx={1.5} /> : null,
      )}
    </g>
  );
}

/** "What's using power" — stacked appliance loads through the day. */
function LoadsChart({ loads, ghost }: { loads: Record<string, number[]>; ghost?: Ghost }) {
  // Tween every category (absent ones as zeros, so a load that's switched off shrinks away rather
  // than vanishing) plus the scale.
  const target: Record<string, number | number[]> = {};
  for (const c of APPLIANCE_META) target[c.key] = loads[c.key] ?? Array(24).fill(0);
  const grossT = Array.from({ length: 24 }, (_, h) => APPLIANCE_META.reduce((s, c) => s + (loads[c.key]?.[h] ?? 0), 0));
  target.__max = Math.max(0.5, ...grossT, ...(ghost?.values ?? [])) * 1.1;
  const tw = useTweened(target);
  const series = (k: string) => tw[k] as number[];
  const maxY = tw.__max as number;

  const cats = APPLIANCE_META.filter((c) => series(c.key).some((v) => v > 0.001));
  const y = (v: number) => M.top + PLOT_H * (1 - Math.min(1, v / maxY));
  const svgRef = useRef<SVGSVGElement>(null);
  const k = useChartScale(svgRef, VW);

  return (
    <>
      <p className="editor-meta">Each bar is the power your appliances draw that hour of the day.</p>
      <svg ref={svgRef} className="bar-chart" viewBox={`0 0 ${VW} ${VH}`} style={axisStyle(k)}>
        {niceTicks(maxY).map((v) => (
          <g key={`t${v}`} className="grid-tick">
            <line x1={M.left} x2={VW - M.right} y1={y(v)} y2={y(v)} stroke="#0001" />
            <text className="axis-label" x={Y_LABEL_X} y={y(v)} dominantBaseline="middle" textAnchor="end">
              {tickLabel(v)}
            </text>
          </g>
        ))}
        {Array.from({ length: 24 }, (_, h) => {
          const x = M.left + h * SLOT + BAR_PAD;
          let acc = 0;
          return (
            <g key={h}>
              {cats.map((c) => {
                const v = series(c.key)[h] ?? 0;
                if (v <= 0.001) return null;
                const yTop = y(acc + v);
                const height = y(acc) - yTop;
                acc += v;
                return <rect key={c.key} x={x} y={yTop} width={BAR_W} height={height} fill={c.color} />;
              })}
            </g>
          );
        })}
        {ghost && <GhostBars key={ghost.id} ghost={ghost} y={y} baseY={M.top + PLOT_H} />}
        <XLabels />
      </svg>
      <div className="chart-legend">
        {cats.map((c) => (
          <span key={c.key} className="lg">
            <i className="sw" style={{ background: c.color }} /> {c.label}
          </span>
        ))}
      </div>
    </>
  );
}

/** "What I'm paying for" — net grid demand: import (TOU-shaded) above 0, export below 0. */
function BilledChart({
  profile,
  activePlan,
  activeResult,
  period,
  onEdit,
  ghost,
  hint,
}: {
  profile: UsageProfile;
  activePlan?: Plan;
  activeResult?: CostResult;
  period: BillingPeriod;
  onEdit?: (hour: number, value: number) => void;
  ghost?: Ghost;
  hint?: { run: number; on: boolean; onDone: () => void };
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [hoverHour, setHoverHour] = useState<number | null>(null);
  // Freeze the import scale while dragging so the axis doesn't jump as bars change.
  const [frozenMax, setFrozenMax] = useState<number | null>(null);
  const editable = !!onEdit;
  const k = useChartScale(svgRef, VW);

  // One representative day. Weekday TOU resolution drives the shading/labels; per-period kWh below
  // still weights weekday + weekend day counts so it matches the billed cost.
  const flat = !touLabelAt(activePlan, 12, DISPLAY_DAY) && !touLabelAt(activePlan, 18, DISPLAY_DAY);
  const targetImp = profile.import.map((v) => Math.max(0, v));
  const targetExp = profile.export.map((v) => Math.max(0, v));
  // Leave room for the "before" outline so it isn't clipped when a toggle lowers the peak.
  const computedMaxImp = Math.max(0.5, ...targetImp, ...(ghost?.values ?? [])) * (editable ? 1.25 : 1.1);

  // Feed-in ($/kWh) resolved PER HOUR from the plan's FiT bands. (The old code mapped over the bands
  // and resolved each at hour 0, so all-but-one came back 0 — that's why Amber's line looked wrong.)
  const fitBands = activePlan?.solarFeedIn ?? [];
  const fitAt = (h: number) => resolveFitRate(fitBands, h, DISPLAY_DAY);
  const targetExportRates = Array.from({ length: 24 }, (_, h) => fitAt(h));
  const targetPriceRates = activePlan?.touRates?.map((r) => r.blocks[0]?.perKwh ?? 0) ?? [];

  // Everything that sets geometry is tweened, so bars, the zero line, gridlines and price curves
  // glide to new values. While dragging it snaps (the bar must track the pointer exactly).
  const tw = useTweened(
    {
      imp: targetImp,
      exp: targetExp,
      maxImp: frozenMax ?? computedMaxImp,
      maxExp: Math.max(0, ...targetExp) * 1.45, // headroom at the bottom for the export watermark
      price: targetPriceRates,
      fit: targetExportRates,
    },
    { immediate: drag != null },
  );
  const imp = tw.imp;
  const exp = tw.exp;
  const maxImp = tw.maxImp;
  const maxExp = tw.maxExp > 0.001 ? tw.maxExp : 0;
  const totalRange = maxImp + maxExp;
  const zeroY = M.top + PLOT_H * (maxExp > 0 ? maxImp / totalRange : 1);
  const importH = Math.max(1, zeroY - M.top);
  const exportH = Math.max(0, M.top + PLOT_H - zeroY);
  const yImp = (v: number) => zeroY - (v / maxImp) * importH;

  // Map a pointer's client-Y to an import kWh value (clamped to the plot).
  const valueAt = (clientY: number): number => {
    const svg = svgRef.current;
    if (!svg) return 0;
    const r = svg.getBoundingClientRect();
    const svgY = (clientY - r.top) * (VH / r.height);
    return Math.max(0, Math.min(maxImp, ((zeroY - svgY) / importH) * maxImp));
  };
  const startDrag = (h: number, e: React.PointerEvent) => {
    if (!editable) return;
    e.preventDefault();
    setFrozenMax(maxImp);
    setDrag(h);
    try {
      svgRef.current?.setPointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort; move/up handlers on the svg still track the drag */
    }
    onEdit!(h, valueAt(e.clientY));
  };
  const moveDrag = (e: React.PointerEvent) => {
    if (drag == null) return;
    onEdit!(drag, valueAt(e.clientY));
  };
  const endDrag = () => {
    setDrag(null);
    setFrozenMax(null);
  };

  // Resolve each hour to its billing period (matching the bar colours), so overlapping TOU windows
  // never double-shade. Then build the distinct periods (with cost) + each one's longest run of
  // hours, which is where we anchor its on-chart label.
  const flatRate = activePlan?.singleRate?.blocks[0]?.perKwh ?? activePlan?.touRates?.[0]?.blocks[0]?.perKwh ?? 0;
  // Plans often carry several distinct "shoulder" windows at different prices; a single orange makes
  // them indistinguishable, so scale shoulder bands from yellow (cheapest) to red (dearest) by price.
  const shoulderRates = (flat ? [] : activePlan?.touRates ?? [])
    .filter((r) => r.label === 'SHOULDER')
    .map((r) => r.blocks[0]?.perKwh ?? 0);
  const shMin = Math.min(...shoulderRates);
  const shMax = Math.max(...shoulderRates);
  // Yellow (cheapest shoulder) → orange (dearest). Stops short of the peak brick-red so a shoulder
  // never reads as a peak band.
  const shoulderColor = (rate: number) =>
    shoulderRates.length < 2 || shMax === shMin ? TOU_FILL.SHOULDER : lerpColor('#eccb3f', '#e07a1e', (rate - shMin) / (shMax - shMin));
  // Off-peak: scale by price too (muted green → yellow-green), so it reads as cheap-but-not-free and
  // is visibly distinct from the vivid-green FREE periods.
  const offpeakRates = (flat ? [] : activePlan?.touRates ?? [])
    .filter((r) => r.label === 'OFFPEAK' && (r.blocks[0]?.perKwh ?? 0) > 0)
    .map((r) => r.blocks[0]?.perKwh ?? 0);
  const opMin = Math.min(...offpeakRates);
  const opMax = Math.max(...offpeakRates);
  const offpeakColor = (rate: number) =>
    offpeakRates.length < 2 || opMax === opMin ? OFFPEAK_LOW : lerpColor(OFFPEAK_LOW, OFFPEAK_HIGH, (rate - opMin) / (opMax - opMin));
  const hourPeriod = (h: number, day: DayType): { key: string; name: string; color: string; rateC: number } => {
    if (isFreeHour(activePlan, h, day)) return { key: 'FREE', name: 'Free', color: FREE_FILL, rateC: 0 };
    if (!flat && activePlan?.touRates?.length) {
      const r = resolveTouRate(activePlan.touRates, h, day);
      if (r) {
        const perKwh = r.blocks[0]?.perKwh ?? 0;
        // A 0c TOU band (of any label) is effectively a free window — show it as such.
        if (perKwh <= 0) return { key: 'FREE', name: 'Free', color: FREE_FILL, rateC: 0 };
        const color =
          r.label === 'SHOULDER' ? shoulderColor(perKwh) : r.label === 'OFFPEAK' ? offpeakColor(perKwh) : TOU_FILL[r.label];
        return { key: `${r.label}#${activePlan.touRates.indexOf(r)}`, name: TOU_NAME[r.label], color, rateC: Math.round(perKwh * 100) };
      }
    }
    return { key: 'ANYTIME', name: 'Usage', color: FLAT_FILL, rateC: Math.round(flatRate * 100) };
  };
  const hourInfo = Array.from({ length: 24 }, (_, h) => hourPeriod(h, DISPLAY_DAY));
  const bandCost = (key: string) => activeResult?.breakdown.usageBands.find((b) => b.key === key)?.cost ?? 0;

  // Import kWh per period over the whole billing period (weekday + weekend day mix) — matches the
  // cost aggregation, so the watermark kWh and $ read as a consistent pair.
  const days = billingDays(period);
  const kwhByKey = new Map<string, number>();
  const addKwh = (key: string, kwh: number) => kwhByKey.set(key, (kwhByKey.get(key) ?? 0) + kwh);
  for (let h = 0; h < 24; h++) {
    const kwh = targetImp[h] ?? 0;
    addKwh(hourPeriod(h, 'WEEKDAY').key, kwh * days.weekday);
    addKwh(hourPeriod(h, 'WEEKEND').key, kwh * days.weekend);
  }

  const periods = new Map<string, { key: string; name: string; color: string; rateC: number; cost: number; kwh: number }>();
  for (const info of hourInfo)
    if (!periods.has(info.key)) periods.set(info.key, { ...info, cost: bandCost(info.key), kwh: kwhByKey.get(info.key) ?? 0 });

  const bestRun = new Map<string, { start: number; end: number }>(); // end exclusive
  for (let s = 0, h = 1; h <= 24; h++) {
    if (h === 24 || hourInfo[h].key !== hourInfo[s].key) {
      const key = hourInfo[s].key;
      const prev = bestRun.get(key);
      if (!prev || h - s > prev.end - prev.start) bestRun.set(key, { start: s, end: h });
      s = h;
    }
  }
  const LBL_HALF = 46; // keep labels/watermarks clear of the chart edges
  const clampX = (x: number) => Math.max(M.left + LBL_HALF, Math.min(VW - M.right - LBL_HALF, x));

  // Variable-wholesale (Amber-style) plans have 24 hourly bands — too many to label. Instead show
  // one tint + the hourly price curve, and a single aggregated usage watermark.
  const wholesale = !!activePlan?.variableWholesale;
  const priceRates = tw.price;
  // Scale + labels from the target rates (stable), the curve itself from the tweened ones.
  const maxRate = Math.max(0.01, ...targetPriceRates);
  const minRate = Math.min(...(targetPriceRates.length ? targetPriceRates : [0]));
  const priceYr = (rate: number) => M.top + importH * (0.08 + 0.85 * (1 - rate / maxRate));
  const priceY = (h: number) => priceYr(priceRates[h] ?? 0);
  const priceLine = priceRates.map((_, h) => `${M.left + h * SLOT + SLOT / 2},${priceY(h)}`).join(' ');
  const wholesaleKwh = [...periods.values()].reduce((s, p) => s + p.kwh, 0);
  const wholesaleCost = bandCost('WHOLESALE');

  const exportRates = tw.fit;
  const hasExportRates = targetExportRates.some((r) => r > 0);
  const maxExportRate = Math.max(0.01, ...targetExportRates);
  // Wholesale plans draw an hourly feed-in curve BELOW the line: a higher feed-in reads as a bigger
  // credit, so it sits FURTHER from the x-axis (further down), like a more-negative amount.
  const exportYr = (rate: number) => zeroY + (0.14 + 0.78 * (rate / maxExportRate)) * exportH;
  const exportY = (h: number) => exportYr(exportRates[h] ?? 0);
  const exportLine = hasExportRates ? exportRates.map((_, h) => `${M.left + h * SLOT + SLOT / 2},${exportY(h)}`).join(' ') : '';

  // Below-line feed-in sections (non-wholesale): group hours by feed-in rate, each with its own blue
  // shade + a $ credit / kWh watermark, mirroring the import periods above the line.
  const totalDays = days.weekday + days.weekend;
  const expInfo = Array.from({ length: 24 }, (_, h) => {
    const rate = targetExportRates[h];
    return { key: `FIT#${Math.round(rate * 1000)}`, rate };
  });
  const expMaxRate = Math.max(0.01, ...expInfo.map((i) => i.rate));
  const expColor = (rate: number) => lerpColor('#aecbef', '#1f5fb0', rate / expMaxRate);
  const expPeriods = new Map<string, { key: string; rate: number; kwh: number; credit: number }>();
  for (let h = 0; h < 24; h++) {
    const e = targetExp[h] ?? 0;
    if (e <= 0.001) continue;
    const info = expInfo[h];
    const cur = expPeriods.get(info.key) ?? { key: info.key, rate: info.rate, kwh: 0, credit: 0 };
    cur.kwh += e * totalDays;
    cur.credit += e * info.rate * totalDays;
    expPeriods.set(info.key, cur);
  }
  const expCenter = (key: string): number | null => {
    const hs: number[] = [];
    for (let h = 0; h < 24; h++) if (expInfo[h].key === key && (targetExp[h] ?? 0) > 0.001) hs.push(h);
    return hs.length ? (hs[0] + hs[hs.length - 1] + 1) / 2 : null;
  };
  const totalExportKwh = targetExp.reduce((s, e) => s + e, 0) * totalDays;

  // Drag demo target: the busiest evening hour (where shifting load matters most).
  let hintHour = 16;
  for (let h = 16; h <= 20; h++) if (targetImp[h] > targetImp[hintHour]) hintHour = h;
  if (targetImp[hintHour] < 0.05) hintHour = targetImp.indexOf(Math.max(...targetImp));
  const showHint = editable && !!hint?.on && hintHour >= 0;

  return (
    <>
      <p className="editor-meta">
        {wholesale ? (
          <>
            Bars are grid <em>import</em>; the <span style={{ color: PRICE_LINE }}>▬</span> line is{' '}
            <strong>{activePlan?.retailer ?? 'the plan'}</strong>'s wholesale price, which changes every hour.{' '}
            <em>Modelled from average wholesale prices — real bills swing with market volatility.</em>
          </>
        ) : (
          <>
            Bars above the line are grid <em>import</em> (what you're billed), shaded by{' '}
            <strong>{activePlan?.retailer ?? 'the plan'}</strong>'s {flat ? 'flat rate' : 'time-of-use periods'};
            below the line is <em>export</em> (earns the feed-in credit).{' '}
            {editable ? (
              <strong>Drag any bar to shift load and watch the plans re-rank.</strong>
            ) : (
              <>This is your usage net of solar &amp; battery.</>
            )}
          </>
        )}
      </p>
      <div className="chart-wrap">
        <svg
          ref={svgRef}
          className={`bar-chart${editable ? ' editable' : ''}`}
          viewBox={`0 0 ${VW} ${VH}`}
          style={axisStyle(k)}
          onPointerDownCapture={() => hint?.on && hint.onDone()}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          {/* Import-region background: one tint for wholesale, else each hour tinted by its period. */}
          {wholesale ? (
            <rect className="tint" x={M.left} y={M.top} width={PLOT_W} height={importH} style={{ fill: WHOLESALE_FILL }} opacity={0.1} />
          ) : (
            hourInfo.map((info, h) => (
              <rect key={`bg${h}`} className="tint" x={M.left + h * SLOT} y={M.top} width={SLOT} height={importH} style={{ fill: info.color }} opacity={0.14} />
            ))
          )}
          {/* Export-region background: blue feed-in sections (each hour shaded by its feed-in rate). */}
          {maxExp > 0 &&
            exportH > 2 &&
            Array.from({ length: 24 }, (_, h) => (
              <rect
                key={`ebg${h}`}
                className="tint"
                x={M.left + h * SLOT}
                y={zeroY}
                width={SLOT}
                height={exportH}
                style={{ fill: wholesale ? EXPORT_FILL : expColor(targetExportRates[h]) }}
                opacity={0.12}
              />
            ))}
          {/* Gridlines at fixed kWh values: they slide/compress as the (tweened) scale changes. */}
          {niceTicks(maxImp)
            .filter((v) => v > 0)
            .map((v) => (
              <g key={`t${v}`} className="grid-tick" pointerEvents="none">
                <line x1={M.left} x2={VW - M.right} y1={yImp(v)} y2={yImp(v)} stroke="#0002" strokeDasharray="2 3" />
                <text className="axis-label" x={Y_LABEL_X} y={yImp(v)} dominantBaseline="middle" textAnchor="end">
                  {tickLabel(v)}
                </text>
              </g>
            ))}
          <line x1={M.left} x2={VW - M.right} y1={zeroY} y2={zeroY} stroke="#333" strokeWidth={1} />
          <text className="axis-label" x={Y_LABEL_X} y={zeroY} dominantBaseline="middle" textAnchor="end">
            0
          </text>
          {maxExp > 0 && exportH > 14 && (
            <text className="axis-label" x={Y_LABEL_X} y={M.top + PLOT_H} textAnchor="end">
              −{maxExp.toFixed(1)}
            </text>
          )}
          {Array.from({ length: 24 }, (_, h) => {
            const x = M.left + h * SLOT + BAR_PAD;
            const i = imp[h] ?? 0;
            const e = exp[h] ?? 0;
            const fill = wholesale ? WHOLESALE_FILL : hourInfo[h].color;
            const hot = editable && (hoverHour === h || drag === h);
            return (
              <g key={h}>
                {i > 0.001 && <rect className="bar" x={x} y={yImp(i)} width={BAR_W} height={zeroY - yImp(i)} style={{ fill }} rx={1.5} />}
                {editable && (
                  <rect className={`grab-handle${hot ? ' hot' : ''}`} x={x} y={yImp(i) - (hot ? 2.5 : 1.5)} width={BAR_W} height={hot ? 5 : 3} rx={1.5} />
                )}
                {hot && (
                  <path
                    className="grab-chevrons"
                    d={`M${x + BAR_W / 2 - 4} ${yImp(i) - 7} l4 -4 l4 4 M${x + BAR_W / 2 - 4} ${yImp(i) + 7} l4 4 l4 -4`}
                    pointerEvents="none"
                  />
                )}
                {e > 0.001 && exportH > 0 && maxExp > 0 && (
                  <rect className="bar" x={x} y={zeroY} width={BAR_W} height={(e / maxExp) * exportH} style={{ fill: EXPORT_FILL }} rx={1.5} />
                )}
              </g>
            );
          })}
          {ghost && <GhostBars key={ghost.id} ghost={ghost} y={yImp} baseY={zeroY} />}
          {/* Transparent grab targets over the import region (on top so they catch the pointer). */}
          {editable &&
            Array.from({ length: 24 }, (_, h) => (
              <rect
                key={`hit${h}`}
                x={M.left + h * SLOT}
                y={M.top}
                width={SLOT}
                height={importH}
                fill="transparent"
                style={{ cursor: 'ns-resize' }}
                onPointerDown={(e) => startDrag(h, e)}
                onPointerEnter={() => setHoverHour(h)}
                onPointerLeave={() => setHoverHour((cur) => (cur === h ? null : cur))}
              />
            ))}
          {/* Watermarks paint AFTER the bars (on top) with a white halo, so the $/kWh figures stay
              legible over tall bars. pointerEvents:none keeps the bars draggable underneath. */}
          {wholesale ? (
            <g pointerEvents="none" fill={WHOLESALE_FILL} stroke="#fff" strokeWidth={3.5} strokeLinejoin="round" paintOrder="stroke" opacity={0.92} textAnchor="middle" fontWeight={900}>
              <text x={M.left + PLOT_W * 0.28} y={M.top + 22} fontSize={22}>
                {money(wholesaleCost)}
              </text>
              <text x={M.left + PLOT_W * 0.28} y={M.top + 39} fontSize={12}>
                {Math.round(wholesaleKwh).toLocaleString('en-AU')} kWh
              </text>
            </g>
          ) : (
            [...periods.values()].map((p) => {
              const run = bestRun.get(p.key)!;
              const cx = clampX(M.left + ((run.start + run.end) / 2) * SLOT);
              return (
                <g key={`wm${p.key}`} pointerEvents="none" fill={p.color} stroke="#fff" strokeWidth={3.5} strokeLinejoin="round" paintOrder="stroke" opacity={0.92} textAnchor="middle" fontWeight={900}>
                  <text x={cx} y={M.top + 22} fontSize={22}>
                    {money(p.cost)}
                  </text>
                  <text x={cx} y={M.top + 39} fontSize={12}>
                    {Math.round(p.kwh).toLocaleString('en-AU')} kWh
                  </text>
                </g>
              );
            })
          )}
          {maxExp > 0 &&
            exportH > 30 &&
            (() => {
              const items = wholesale
                ? [{ key: 'W', cx: clampX(M.left + PLOT_W * 0.72), dollars: activeResult?.breakdown.solarCredit ?? 0, kwh: totalExportKwh }]
                : [...expPeriods.values()].map((p) => {
                    const c = expCenter(p.key);
                    return c == null ? null : { key: p.key, cx: clampX(M.left + c * SLOT), dollars: -p.credit, kwh: p.kwh };
                  });
              return items.map((it) =>
                !it ? null : (
                  <g
                    key={`ewm${it.key}`}
                    pointerEvents="none"
                    fill={EXPORT_FILL}
                    stroke="#fff"
                    strokeWidth={3.5}
                    strokeLinejoin="round"
                    paintOrder="stroke"
                    opacity={0.92}
                    textAnchor="middle"
                    fontWeight={900}
                  >
                    <text x={it.cx} y={M.top + PLOT_H - 22} fontSize={20}>
                      {money(it.dollars)}
                    </text>
                    <text x={it.cx} y={M.top + PLOT_H - 7} fontSize={12}>
                      {Math.round(it.kwh).toLocaleString('en-AU')} kWh
                    </text>
                  </g>
                ),
              );
            })()}
          {/* Wholesale: the hourly price curve behind the bars + one header. Else: per-period labels. */}
          {wholesale ? (
            <>
              <polyline points={priceLine} fill="none" stroke={PRICE_LINE} strokeWidth={2} strokeDasharray="4 3" pointerEvents="none" />
              {hasExportRates && <polyline points={exportLine} fill="none" stroke={EXPORT_FILL} strokeWidth={2} strokeDasharray="4 3" pointerEvents="none" opacity={0.6} />}
              <text x={M.left + PLOT_W / 2} y={16} textAnchor="middle" fontSize={13} fontWeight={700} fill={WHOLESALE_FILL} pointerEvents="none">
                Wholesale price · {Math.round(minRate * 100)}–{Math.round(maxRate * 100)}c/kWh through the day
              </text>
              {/* Right axis: c/kWh amounts for the import price curve (gold) and feed-in curve (blue). */}
              {[maxRate, minRate].map((r, i) => (
                <text key={`py${i}`} className="axis-label" x={VW - 2} y={priceYr(r) + 3} textAnchor="end" fill={PRICE_LINE} pointerEvents="none">
                  {Math.round(r * 100)}c
                </text>
              ))}
              {hasExportRates && (
                <text className="axis-label" x={VW - 2} y={exportYr(maxExportRate) + 3} textAnchor="end" fill={EXPORT_FILL} pointerEvents="none">
                  {Math.round(maxExportRate * 100)}c
                </text>
              )}
            </>
          ) : (
            [...periods.values()].map((p) => {
              const run = bestRun.get(p.key)!;
              const cx = clampX(M.left + ((run.start + run.end) / 2) * SLOT);
              return (
                <text key={`hdr${p.key}`} x={cx} y={16} textAnchor="middle" fontSize={13} fontWeight={700} fill={p.color} pointerEvents="none">
                  {p.name} · {p.rateC}c
                </text>
              );
            })
          )}
          <XLabels />
        </svg>
        {showHint && (
          <DragHint
            key={hint!.run}
            vw={VW}
            vh={VH}
            x={M.left + hintHour * SLOT + BAR_PAD}
            width={BAR_W}
            top={yImp(imp[hintHour] ?? 0)}
            bottom={zeroY}
            plotTop={M.top}
            onDone={hint!.onDone}
          />
        )}
      </div>
    </>
  );
}
