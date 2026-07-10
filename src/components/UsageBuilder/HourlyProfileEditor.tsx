import { useRef, useState, type ReactNode } from 'react';
import { useUsageStore } from '../../store/usageStore';
import { APPLIANCE_META } from '../../data/applianceProfiles';
import { resolveTouRate, resolveFitRate } from '../../lib/time';
import { billingDays } from '../../lib/costEngine';
import type { BillingPeriod, CostResult, DayType, Plan, SolarEffectiveness, TouLabel, UsageProfile, Behaviours } from '../../types';

const VW = 720;
const VH = 262;
// `top` includes a header lane above the plot for the billed chart's period labels.
const M = { left: 30, right: 8, top: 26, bottom: 22 };
const PLOT_W = VW - M.left - M.right;
const PLOT_H = VH - M.top - M.bottom;
const SLOT = PLOT_W / 24;
const BAR_W = SLOT * 0.78;
const BAR_PAD = (SLOT - BAR_W) / 2;

const TOU_FILL: Record<TouLabel, string> = { PEAK: '#c0392b', SHOULDER: '#e08a1e', OFFPEAK: '#2b8a5b' };
const FLAT_FILL = '#4a00c3';
const FREE_FILL = '#2b8a5b';
const EXPORT_FILL = '#3b7dd8';
const WHOLESALE_FILL = '#6b46c1';
const PRICE_LINE = '#e0a020';

const BAND_COLOR: Record<string, string> = {
  PEAK: '#c0392b',
  SHOULDER: '#e08a1e',
  OFFPEAK: '#2b8a5b',
  ANYTIME: '#4a00c3',
  FREE: '#2b8a5b',
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

function BehaviourRow({ on, onToggle, title, blurb, children }: { on: boolean; onToggle: (v: boolean) => void; title: string; blurb: string; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`behaviour-item${on ? ' on' : ''}`}>
      <label className="behaviour-head">
        <input type="checkbox" checked={on} onChange={(e) => onToggle(e.target.checked)} />
        <span className="behaviour-title">
          {title}
          <span className="behaviour-blurb">{blurb}</span>
        </span>
      </label>
      {on && children && (
        <button className="behaviour-tune" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? 'Hide options ▾' : 'Customise ▸'}
        </button>
      )}
      {on && open && <div className="behaviour-settings">{children}</div>}
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="behaviour-slider">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="behaviour-slider-val">
        {value}
        {suffix}
      </span>
    </label>
  );
}
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

interface Props {
  activePlan?: Plan;
  activeResult?: CostResult;
}

export function HourlyProfileEditor({ activePlan, activeResult }: Props) {
  const { profile, manualProfile, loads, effectiveness, home, period, setEffectiveness, setManualImport, resetManual, behaviours, setBehaviour } =
    useUsageStore();
  const [mode, setMode] = useState<Mode>('billed');

  const eff = manualProfile ?? profile;
  const edited = manualProfile != null;
  const imp = eff.import;
  const hasSolar = home.solarKw > 0;
  const bands = activeResult?.breakdown.usageBands ?? [];

  const impTotal = imp.reduce((a, b) => a + b, 0);
  const derivedTotal = profile.import.reduce((a, b) => a + b, 0);

  const pct = (v: number) => Math.round(v * 100);
  const setPct = (k: keyof Behaviours) => (v: number) => setBehaviour({ [k]: v / 100 } as Partial<Behaviours>);

  const showHotWater = home.hotWater === 'electric-storage' || home.hotWater === 'controlled-load';
  const showHeatPump = home.hotWater === 'heat-pump';
  const showEv = home.evCount > 0;

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

      {mode === 'billed' && (
        <div className="edit-toolbar">
          <span className="edit-total">
            {impTotal.toFixed(1)} kWh/day
            {edited && Math.abs(impTotal - derivedTotal) > 0.05 && (
              <em>
                {' '}({impTotal >= derivedTotal ? '+' : '−'}
                {Math.abs(impTotal - derivedTotal).toFixed(1)} vs estimate)
              </em>
            )}
          </span>
          {edited && (
            <button className="reset-btn" onClick={resetManual}>
              Reset
            </button>
          )}
        </div>
      )}

      {mode === 'loads' ? (
        <LoadsChart loads={loads} />
      ) : (
        <BilledChart
          profile={eff}
          activePlan={activePlan}
          activeResult={activeResult}
          period={period}
          onEdit={(h, v) => setManualImport(h, v, true)}
        />
      )}

      {/* Per-period cost contribution. In the billed view the time-of-use energy periods and the
          solar feed-in credit are shown directly on the chart, so only the other non-time costs
          (fixed, controlled load, demand) are chipped below; the loads view shows the full set. */}
      {activeResult && (
        <div className="period-chips">
          <span className="chip fixed">
            Fixed <b>{money(activeResult.fixedTotal)}</b>
          </span>
          {bands
            .filter((b) => mode === 'loads' || (!isTimeBand(b.key) && b.key !== 'SOLAR'))
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

      {(showHotWater || showHeatPump || showEv || home.poolPump || home.batteryKwh > 0) && (
        <div className="flexible-loads" style={{ marginTop: 20, paddingTop: 16, borderTop: '1px dashed #cfc7b8' }}>
          <p style={{ fontSize: 13, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--purple)', margin: '0 0 10px' }}>
            Flexible loads
          </p>
          <p className="behaviour-intro">
            Moving flexible loads into the cheap/free solar-soak window (11am–2pm) can cut your bill. Try switching these on and watch the plans re-rank.
          </p>

          {home.poolPump && (
            <BehaviourRow
              on={behaviours.poolTimer}
              onToggle={(v) => setBehaviour({ poolTimer: v })}
              title="Put a timer on the pool pump"
              blurb="Run the pump in the middle of the day instead of morning/evening."
            >
              <Slider label="Pump runs" value={behaviours.poolHours} min={2} max={12} step={1} suffix=" h/day" onChange={(v) => setBehaviour({ poolHours: v })} />
              <Slider label="Shifted to midday" value={pct(behaviours.poolShare)} min={0} max={100} step={5} suffix="%" onChange={setPct('poolShare')} />
            </BehaviourRow>
          )}

          {showHotWater && (
            <BehaviourRow
              on={behaviours.hotWaterTimer}
              onToggle={(v) => setBehaviour({ hotWaterTimer: v })}
              title="Add a smart timer to your hot water"
              blurb="Heat the tank at midday on solar instead of overnight."
            >
              <Slider label="Shifted to midday" value={pct(behaviours.hotWaterShare)} min={0} max={100} step={5} suffix="%" onChange={setPct('hotWaterShare')} />
            </BehaviourRow>
          )}

          {showHeatPump && (
            <BehaviourRow
              on={behaviours.heatPumpTimer}
              onToggle={(v) => setBehaviour({ heatPumpTimer: v })}
              title="Set a timer on your heat-pump hot water"
              blurb="Heat pumps sip power — running midday soaks your solar cheaply."
            >
              <Slider label="Shifted to midday" value={pct(behaviours.heatPumpShare)} min={0} max={100} step={5} suffix="%" onChange={setPct('heatPumpShare')} />
            </BehaviourRow>
          )}

          {showEv && (
            <BehaviourRow
              on={behaviours.evScheduled}
              onToggle={(v) => setBehaviour({ evScheduled: v })}
              title="Schedule EV charging for the day"
              blurb="Charge on midday solar instead of plugging in at night."
            >
              <label className="behaviour-check">
                <input type="checkbox" checked={behaviours.evHomeDaytime} onChange={(e) => setBehaviour({ evHomeDaytime: e.target.checked })} />
                The car is usually home during the day
              </label>
              <Slider label="Shifted to midday" value={pct(behaviours.evShare)} min={0} max={100} step={5} suffix="%" onChange={setPct('evShare')} />
            </BehaviourRow>
          )}

          {showEv && (
            <BehaviourRow
              on={behaviours.v2g}
              onToggle={(v) => setBehaviour({ v2g: v })}
              title="Get a V2G charger (car works as a home battery)"
              blurb="Charges in your selected plan's cheapest hours and covers the evening peak — through a 7 kW charger."
            >
              <Slider label="Usable capacity" value={behaviours.v2gKwh} min={5} max={60} step={5} suffix=" kWh" onChange={(v) => setBehaviour({ v2gKwh: v })} />
            </BehaviourRow>
          )}

          {home.batteryKwh > 0 && (
            <BehaviourRow
              on={behaviours.batteryGridCharge}
              onToggle={(v) => setBehaviour({ batteryGridCharge: v })}
              title="Let the battery top up from the grid"
              blurb="On low-solar days, fill the battery in your selected plan's cheapest hours to cover the evening peak."
            />
          )}
        </div>
      )}
    </div>
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

/** "What's using power" — stacked appliance loads through the day. */
function LoadsChart({ loads }: { loads: Record<string, number[]> }) {
  const cats = APPLIANCE_META.filter((c) => (loads[c.key] ?? []).some((v) => v > 0.001));
  const gross = Array.from({ length: 24 }, (_, h) => cats.reduce((s, c) => s + (loads[c.key][h] ?? 0), 0));
  const maxY = Math.max(0.5, ...gross) * 1.1;
  const y = (v: number) => M.top + PLOT_H * (1 - Math.min(1, v / maxY));

  return (
    <>
      <p className="editor-meta">Each bar is the power your appliances draw that hour of the day.</p>
      <svg className="bar-chart" viewBox={`0 0 ${VW} ${VH}`}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={M.left} x2={VW - M.right} y1={y(maxY * f)} y2={y(maxY * f)} stroke="#0001" />
            <text className="axis-label" x={2} y={y(maxY * f) + 3}>
              {(maxY * f).toFixed(1)}
            </text>
          </g>
        ))}
        {Array.from({ length: 24 }, (_, h) => {
          const x = M.left + h * SLOT + BAR_PAD;
          let acc = 0;
          return (
            <g key={h}>
              {cats.map((c) => {
                const v = loads[c.key][h] ?? 0;
                if (v <= 0.001) return null;
                const yTop = y(acc + v);
                const height = y(acc) - yTop;
                acc += v;
                return <rect key={c.key} x={x} y={yTop} width={BAR_W} height={height} fill={c.color} />;
              })}
            </g>
          );
        })}
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
}: {
  profile: UsageProfile;
  activePlan?: Plan;
  activeResult?: CostResult;
  period: BillingPeriod;
  onEdit?: (hour: number, value: number) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  // Freeze the import scale while dragging so the axis doesn't jump as bars change.
  const [frozenMax, setFrozenMax] = useState<number | null>(null);
  const editable = !!onEdit;

  // One representative day. Weekday TOU resolution drives the shading/labels; per-period kWh below
  // still weights weekday + weekend day counts so it matches the billed cost.
  const imp = profile.import;
  const exp = profile.export;
  const flat = !touLabelAt(activePlan, 12, DISPLAY_DAY) && !touLabelAt(activePlan, 18, DISPLAY_DAY);
  const computedMaxImp = Math.max(0.5, ...imp) * (editable ? 1.25 : 1.1);
  const maxImp = frozenMax ?? computedMaxImp;
  const maxExp = Math.max(0, ...exp) * 1.45; // headroom at the bottom for the export watermark
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
    setFrozenMax(computedMaxImp);
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
  const hourPeriod = (h: number, day: DayType): { key: string; name: string; color: string; rateC: number } => {
    if (isFreeHour(activePlan, h, day)) return { key: 'FREE', name: 'Free', color: FREE_FILL, rateC: 0 };
    if (!flat && activePlan?.touRates?.length) {
      const r = resolveTouRate(activePlan.touRates, h, day);
      if (r) {
        const perKwh = r.blocks[0]?.perKwh ?? 0;
        return {
          key: `${r.label}#${activePlan.touRates.indexOf(r)}`,
          name: TOU_NAME[r.label],
          color: r.label === 'SHOULDER' ? shoulderColor(perKwh) : TOU_FILL[r.label],
          rateC: Math.round(perKwh * 100),
        };
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
    const kwh = Math.max(0, profile.import[h] ?? 0);
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
  const priceRates = activePlan?.touRates?.map((r) => r.blocks[0]?.perKwh ?? 0) ?? [];
  const maxRate = Math.max(0.01, ...priceRates);
  const priceY = (h: number) => M.top + importH * (0.08 + 0.85 * (1 - (priceRates[h] ?? 0) / maxRate));
  const priceLine = priceRates.map((_, h) => `${M.left + h * SLOT + SLOT / 2},${priceY(h)}`).join(' ');
  const wholesaleKwh = [...periods.values()].reduce((s, p) => s + p.kwh, 0);
  const wholesaleCost = bandCost('WHOLESALE');

  // Feed-in ($/kWh) resolved PER HOUR from the plan's FiT bands. (The old code mapped over the bands
  // and resolved each at hour 0, so all-but-one came back 0 — that's why Amber's line looked wrong.)
  const fitBands = activePlan?.solarFeedIn ?? [];
  const fitAt = (h: number) => resolveFitRate(fitBands, h, DISPLAY_DAY);
  const exportRates = Array.from({ length: 24 }, (_, h) => fitAt(h));
  const hasExportRates = exportRates.some((r) => r > 0);
  const maxExportRate = Math.max(0.01, ...exportRates);
  // Wholesale plans draw an hourly feed-in curve; the height maps rate → position in the export band.
  const exportY = (h: number) => zeroY + (1 - (exportRates[h] ?? 0) / maxExportRate) * (exportH * 0.7) + exportH * 0.12;
  const exportLine = hasExportRates ? exportRates.map((_, h) => `${M.left + h * SLOT + SLOT / 2},${exportY(h)}`).join(' ') : '';

  // Below-line feed-in sections (non-wholesale): group hours by feed-in rate, each with its own blue
  // shade + a $ credit / kWh watermark, mirroring the import periods above the line.
  const totalDays = days.weekday + days.weekend;
  const expInfo = Array.from({ length: 24 }, (_, h) => {
    const rate = fitAt(h);
    return { key: `FIT#${Math.round(rate * 1000)}`, rate };
  });
  const expMaxRate = Math.max(0.01, ...expInfo.map((i) => i.rate));
  const expColor = (rate: number) => lerpColor('#aecbef', '#1f5fb0', rate / expMaxRate);
  const expPeriods = new Map<string, { key: string; rate: number; kwh: number; credit: number }>();
  for (let h = 0; h < 24; h++) {
    const e = Math.max(0, exp[h] ?? 0);
    if (e <= 0.001) continue;
    const info = expInfo[h];
    const cur = expPeriods.get(info.key) ?? { key: info.key, rate: info.rate, kwh: 0, credit: 0 };
    cur.kwh += e * totalDays;
    cur.credit += e * info.rate * totalDays;
    expPeriods.set(info.key, cur);
  }
  const expCenter = (key: string): number | null => {
    const hs: number[] = [];
    for (let h = 0; h < 24; h++) if (expInfo[h].key === key && (exp[h] ?? 0) > 0.001) hs.push(h);
    return hs.length ? (hs[0] + hs[hs.length - 1] + 1) / 2 : null;
  };
  const totalExportKwh = exp.reduce((s, e) => s + Math.max(0, e), 0) * totalDays;

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
      <svg
        ref={svgRef}
        className={`bar-chart${editable ? ' editable' : ''}`}
        viewBox={`0 0 ${VW} ${VH}`}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {/* Import-region background: one tint for wholesale, else each hour tinted by its period. */}
        {wholesale ? (
          <rect x={M.left} y={M.top} width={PLOT_W} height={importH} fill={WHOLESALE_FILL} opacity={0.1} />
        ) : (
          hourInfo.map((info, h) => (
            <rect key={`bg${h}`} x={M.left + h * SLOT} y={M.top} width={SLOT} height={importH} fill={info.color} opacity={0.14} />
          ))
        )}
        {/* Export-region background: blue feed-in sections (each hour shaded by its feed-in rate). */}
        {maxExp > 0 &&
          exportH > 2 &&
          Array.from({ length: 24 }, (_, h) => (
            <rect
              key={`ebg${h}`}
              x={M.left + h * SLOT}
              y={zeroY}
              width={SLOT}
              height={exportH}
              fill={wholesale ? EXPORT_FILL : expColor(fitAt(h))}
              opacity={0.12}
            />
          ))}
        <line x1={M.left} x2={VW - M.right} y1={zeroY} y2={zeroY} stroke="#333" strokeWidth={1} />
        <text className="axis-label" x={2} y={M.top + 8}>
          {maxImp.toFixed(1)}
        </text>
        {maxExp > 0 && (
          <text className="axis-label" x={2} y={M.top + PLOT_H}>
            −{maxExp.toFixed(1)}
          </text>
        )}
        {Array.from({ length: 24 }, (_, h) => {
          const x = M.left + h * SLOT + BAR_PAD;
          const i = Math.max(0, imp[h] ?? 0);
          const e = Math.max(0, exp[h] ?? 0);
          const fill = wholesale ? WHOLESALE_FILL : hourInfo[h].color;
          return (
            <g key={h}>
              {i > 0.001 && <rect x={x} y={yImp(i)} width={BAR_W} height={zeroY - yImp(i)} fill={fill} rx={1.5} />}
              {editable && (
                <rect x={x} y={yImp(i) - 1.5} width={BAR_W} height={3} fill="#0007" rx={1.5} />
              )}
              {e > 0.001 && exportH > 0 && (
                <rect x={x} y={zeroY} width={BAR_W} height={(e / maxExp) * exportH} fill={EXPORT_FILL} rx={1.5} />
              )}
            </g>
          );
        })}
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
              Wholesale price · {Math.round(Math.min(...priceRates) * 100)}–{Math.round(maxRate * 100)}c/kWh through the day
            </text>
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
    </>
  );
}
