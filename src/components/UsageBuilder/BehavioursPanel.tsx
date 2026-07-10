import { useState, type ReactNode } from 'react';
import { useUsageStore } from '../../store/usageStore';
import type { Behaviours } from '../../types';

function money(v: number): string {
  const r = Math.round(v);
  return r < 0 ? `−$${Math.abs(r).toLocaleString('en-AU')}` : `$${r.toLocaleString('en-AU')}`;
}

interface RowProps {
  on: boolean;
  onToggle: (v: boolean) => void;
  title: string;
  blurb: string;
  children?: ReactNode; // expanded settings
}

function BehaviourRow({ on, onToggle, title, blurb, children }: RowProps) {
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

export function BehavioursPanel({ saving }: { saving: number | null }) {
  const home = useUsageStore((s) => s.home);
  const b = useUsageStore((s) => s.behaviours);
  const set = useUsageStore((s) => s.setBehaviour);
  const pct = (v: number) => Math.round(v * 100);
  const setPct = (k: keyof Behaviours) => (v: number) => set({ [k]: v / 100 } as Partial<Behaviours>);

  const showHotWater = home.hotWater === 'electric-storage' || home.hotWater === 'controlled-load';
  const showHeatPump = home.hotWater === 'heat-pump';
  const showEv = home.evCount > 0;

  return (
    <div className="panel">
      <h2>Shift your usage into the midday solar window</h2>
      <p className="behaviour-intro">
        Moving flexible loads into the cheap/free solar-soak window (11am–2pm) can cut your bill.
        Try switching these on and watch the plans re-rank.
        {saving != null && saving > 1 && (
          <>
            {' '}These choices currently save about <strong className="behaviour-save">{money(saving)}</strong> on
            your selected plan.
          </>
        )}
      </p>

      {home.poolPump && (
        <BehaviourRow
          on={b.poolTimer}
          onToggle={(v) => set({ poolTimer: v })}
          title="Put a timer on the pool pump"
          blurb="Run the pump in the middle of the day instead of morning/evening."
        >
          <Slider label="Pump runs" value={b.poolHours} min={2} max={12} step={1} suffix=" h/day" onChange={(v) => set({ poolHours: v })} />
          <Slider label="Shifted to midday" value={pct(b.poolShare)} min={0} max={100} step={5} suffix="%" onChange={setPct('poolShare')} />
        </BehaviourRow>
      )}

      {showHotWater && (
        <BehaviourRow
          on={b.hotWaterTimer}
          onToggle={(v) => set({ hotWaterTimer: v })}
          title="Add a smart timer to your hot water"
          blurb="Heat the tank at midday on solar instead of overnight."
        >
          <Slider label="Shifted to midday" value={pct(b.hotWaterShare)} min={0} max={100} step={5} suffix="%" onChange={setPct('hotWaterShare')} />
        </BehaviourRow>
      )}

      {showHeatPump && (
        <BehaviourRow
          on={b.heatPumpTimer}
          onToggle={(v) => set({ heatPumpTimer: v })}
          title="Set a timer on your heat-pump hot water"
          blurb="Heat pumps sip power — running midday soaks your solar cheaply."
        >
          <Slider label="Shifted to midday" value={pct(b.heatPumpShare)} min={0} max={100} step={5} suffix="%" onChange={setPct('heatPumpShare')} />
        </BehaviourRow>
      )}

      {showEv && (
        <BehaviourRow
          on={b.evScheduled}
          onToggle={(v) => set({ evScheduled: v })}
          title="Schedule EV charging for the day"
          blurb="Charge on midday solar instead of plugging in at night."
        >
          <label className="behaviour-check">
            <input type="checkbox" checked={b.evHomeDaytime} onChange={(e) => set({ evHomeDaytime: e.target.checked })} />
            The car is usually home during the day
          </label>
          <Slider label="Shifted to midday" value={pct(b.evShare)} min={0} max={100} step={5} suffix="%" onChange={setPct('evShare')} />
        </BehaviourRow>
      )}

      {showEv && (
        <BehaviourRow
          on={b.v2g}
          onToggle={(v) => set({ v2g: v })}
          title="Get a V2G charger (car works as a home battery)"
          blurb="Charges in your selected plan's cheapest hours and covers the evening peak — through a 7 kW charger."
        >
          <Slider label="Usable capacity" value={b.v2gKwh} min={5} max={60} step={5} suffix=" kWh" onChange={(v) => set({ v2gKwh: v })} />
        </BehaviourRow>
      )}

      {home.batteryKwh > 0 && (
        <BehaviourRow
          on={b.batteryGridCharge}
          onToggle={(v) => set({ batteryGridCharge: v })}
          title="Let the battery top up from the grid"
          blurb="On low-solar days, fill the battery in your selected plan's cheapest hours to cover the evening peak."
        />
      )}
    </div>
  );
}
