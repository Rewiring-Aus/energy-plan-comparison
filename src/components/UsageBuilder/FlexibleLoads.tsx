import { useState, type ReactNode } from 'react';
import type { HomeInputs } from '../../data/applianceProfiles';
import type { Behaviours } from '../../types';

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

interface Props {
  home: HomeInputs;
  behaviours: Behaviours;
  soakLabel: string;
  /** A tickbox flip — the editor snapshots the chart first so the change can be animated. */
  onToggle: (patch: Partial<Behaviours>) => void;
  /** Slider tweaks (no before/after snapshot; the chart just tweens). */
  onTune: (patch: Partial<Behaviours>) => void;
}

/** Flexible-load "what if" toggles, shown above the usage chart so their effect is visible. */
export function FlexibleLoads({ home, behaviours, soakLabel, onToggle, onTune }: Props) {
  const showHotWater = home.hotWater === 'electric-storage' || home.hotWater === 'controlled-load';
  const showHeatPump = home.hotWater === 'heat-pump';
  const showEv = home.evCount > 0;
  if (!(showHotWater || showHeatPump || showEv || home.poolPump || home.batteryKwh > 0)) return null;

  const pct = (v: number) => Math.round(v * 100);
  const setPct = (k: keyof Behaviours) => (v: number) => onTune({ [k]: v / 100 } as Partial<Behaviours>);

  return (
    <div className="flexible-loads">
      <p className="flexible-loads-title">Flexible loads</p>
      <p className="behaviour-intro">
        Moving flexible loads into the cheap/free solar-soak window ({soakLabel}) can cut your bill. Tick these and watch the chart change.
      </p>

      {home.poolPump && (
        <BehaviourRow
          on={behaviours.poolTimer}
          onToggle={(v) => onToggle({ poolTimer: v })}
          title="Put a timer on the pool pump"
          blurb="Run the pump in the middle of the day instead of morning/evening."
        >
          <Slider label="Pump runs" value={behaviours.poolHours} min={2} max={12} step={1} suffix=" h/day" onChange={(v) => onTune({ poolHours: v })} />
          <Slider label="Shifted to midday" value={pct(behaviours.poolShare)} min={0} max={100} step={5} suffix="%" onChange={setPct('poolShare')} />
        </BehaviourRow>
      )}

      {showHotWater && (
        <BehaviourRow
          on={behaviours.hotWaterTimer}
          onToggle={(v) => onToggle({ hotWaterTimer: v })}
          title="Add a smart timer to your hot water"
          blurb="Heat the tank at midday on solar instead of overnight."
        >
          <Slider label="Shifted to midday" value={pct(behaviours.hotWaterShare)} min={0} max={100} step={5} suffix="%" onChange={setPct('hotWaterShare')} />
        </BehaviourRow>
      )}

      {showHeatPump && (
        <BehaviourRow
          on={behaviours.heatPumpTimer}
          onToggle={(v) => onToggle({ heatPumpTimer: v })}
          title="Set a timer on your heat-pump hot water"
          blurb="Heat pumps sip power — running midday soaks your solar cheaply."
        >
          <Slider label="Shifted to midday" value={pct(behaviours.heatPumpShare)} min={0} max={100} step={5} suffix="%" onChange={setPct('heatPumpShare')} />
        </BehaviourRow>
      )}

      {showEv && (
        <BehaviourRow
          on={behaviours.evScheduled}
          onToggle={(v) => onToggle({ evScheduled: v })}
          title="Schedule EV charging for the day"
          blurb="Charge on midday solar instead of plugging in at night."
        >
          <label className="behaviour-check">
            <input type="checkbox" checked={behaviours.evHomeDaytime} onChange={(e) => onToggle({ evHomeDaytime: e.target.checked })} />
            The car is usually home during the day
          </label>
          <Slider label="Shifted to midday" value={pct(behaviours.evShare)} min={0} max={100} step={5} suffix="%" onChange={setPct('evShare')} />
        </BehaviourRow>
      )}

      {showEv && (
        <BehaviourRow
          on={behaviours.v2g}
          onToggle={(v) => onToggle({ v2g: v })}
          title="Get a V2G charger (car works as a home battery)"
          blurb="Charges in your selected plan's cheapest hours and covers the evening peak — through a 7 kW charger."
        >
          <Slider label="Usable capacity" value={behaviours.v2gKwh} min={5} max={60} step={5} suffix=" kWh" onChange={(v) => onTune({ v2gKwh: v })} />
        </BehaviourRow>
      )}

      {home.batteryKwh > 0 && (
        <BehaviourRow
          on={behaviours.batteryGridCharge}
          onToggle={(v) => onToggle({ batteryGridCharge: v })}
          title="Let the battery top up from the grid"
          blurb="On low-solar days, fill the battery in your selected plan's cheapest hours to cover the evening peak."
        />
      )}
    </div>
  );
}
