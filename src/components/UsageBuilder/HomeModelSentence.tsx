import { useUsageStore, baselineDaily } from '../../store/usageStore';
import { BlankInput } from '../ui/BlankInput';
import { BlankSelect } from '../ui/BlankSelect';
import { RoughBox } from '../ui/RoughBox';
import { CurrentPlanPicker } from '../PlanList/CurrentPlanPicker';
import { dailyToPeriodKwh } from '../../lib/usageModel';
import { estimatedDailyKwh } from '../../data/applianceProfiles';
import { stateForPostcode } from '../../data/energyModel';

const OCCUPANTS = [1, 2, 3, 4, 5, 6].map((n) => ({ value: n, label: String(n) }));
const HOT_WATER = [
  { value: 'gas', label: 'gas' },
  { value: 'electric-storage', label: 'electric' },
  { value: 'heat-pump', label: 'a heat pump' },
  { value: 'controlled-load', label: 'off-peak electric' },
  { value: 'solar', label: 'solar' },
];
const HEATING = [
  { value: 'none', label: 'no' },
  { value: 'reverse-cycle', label: 'reverse-cycle' },
  { value: 'gas', label: 'gas' },
  { value: 'resistive', label: 'plug-in electric' },
];
const COOKING = [
  { value: 'electric', label: 'electric' },
  { value: 'gas', label: 'gas' },
];
const AIRCON = [
  { value: 'none', label: 'no' },
  { value: 'some', label: 'a split-system' },
  { value: 'ducted', label: 'ducted' },
];
const EV_COUNT = [0, 1, 2].map((n) => ({ value: n, label: String(n) }));
const EV_CHARGE = [
  { value: 'overnight', label: 'overnight' },
  { value: 'evening', label: 'in the evening' },
  { value: 'day', label: 'during the day' },
];
const PERIOD_OPTS = [
  { value: 'monthly', label: 'month' },
  { value: 'quarterly', label: 'quarter' },
  { value: 'annual', label: 'year' },
] as const;

interface HomeModelSentenceProps {
  /** Whether the panel is expanded. */
  open?: boolean;
  /** Show the collapse control in the header (only meaningful once plans are shown). */
  collapsible?: boolean;
  onToggle?: () => void;
}

export function HomeModelSentence({ open = true, collapsible = false, onToggle }: HomeModelSentenceProps) {
  const { home, setHome, postcode, setPostcode, period, setPeriod, baselineAmount, setBaseline } =
    useUsageStore();

  const estDaily = estimatedDailyKwh(home, stateForPostcode(postcode));
  const estPeriod = Math.round(dailyToPeriodKwh(estDaily, period));
  const usingEstimate = baselineDaily(baselineAmount, 'kWh', period) == null;

  const periodScale = period === 'annual' ? 12 : period === 'quarterly' ? 3 : 1;
  const sliderMax = 2000 * periodScale;

  // The heading + toggle live in a fixed header row so "Your home" never shifts between the
  // collapsed recap and the full form — only the content below the header swaps.
  const periodLabel = period === 'annual' ? 'year' : period === 'quarterly' ? 'quarter' : 'month';
  const usage = Math.round(baselineAmount ?? estPeriod).toLocaleString('en-AU');

  if (!open) {
    return (
      <div className="panel">
        <div className="panel-head">
          <h2>Your home</h2>
          <button className="home-hide-btn" onClick={onToggle}>
            Edit your home ▾
          </button>
        </div>
        <p className="home-collapsed-recap">
          {postcode || '—'} · {home.occupants} {home.occupants === 1 ? 'person' : 'people'} · {usage} kWh/{periodLabel}
        </p>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Your home</h2>
        {collapsible && (
          <button className="home-hide-btn" onClick={onToggle}>
            Hide ▴
          </button>
        )}
      </div>

      <p className="sentence">
        <span className="lead">We live in postcode</span>{' '}
        <RoughBox className="blank" seed={20}>
          <span className="blank-input-wrap">
            <input
              className="blank-input"
              type="text"
              inputMode="numeric"
              maxLength={4}
              style={{ width: '6ch' }}
              value={postcode}
              placeholder="2000"
              onChange={(e) => setPostcode(e.target.value.replace(/\D/g, '').slice(0, 4))}
            />
          </span>
        </RoughBox>
        .{' '}
        <span className="lead">We're</span>{' '}
        <BlankSelect value={home.occupants} options={OCCUPANTS} numeric onChange={(v) => setHome({ occupants: v })} seed={21} />{' '}
        people with{' '}
        <BlankSelect value={home.hotWater} options={HOT_WATER} onChange={(v) => setHome({ hotWater: v as never })} seed={22} />{' '}
        hot water,{' '}
        <BlankSelect value={home.cooking} options={COOKING} onChange={(v) => setHome({ cooking: v as never })} seed={23} />{' '}
        cooking,{' '}
        <BlankSelect value={home.heating} options={HEATING} onChange={(v) => setHome({ heating: v as never })} seed={24} />{' '}
        heating and{' '}
        <BlankSelect value={home.aircon} options={AIRCON} onChange={(v) => setHome({ aircon: v as never })} seed={25} />{' '}
        air-con.
      </p>
      <p className="sentence">
        We{' '}
        <BlankSelect
          value={home.poolPump ? 'yes' : 'no'}
          options={[
            { value: 'no', label: "don't have" },
            { value: 'yes', label: 'have' },
          ]}
          onChange={(v) => setHome({ poolPump: v === 'yes' })}
          seed={26}
        />{' '}
        a pool, run{' '}
        <BlankSelect
          value={home.evCount}
          options={EV_COUNT}
          numeric
          onChange={(v) =>
            setHome({ evCount: v, ...(v > 0 && !home.evKmPerWeek ? { evKmPerWeek: 200 } : {}) })
          }
          seed={27}
        />{' '}
        EV(s)
        {home.evCount > 0 && (
          <>
            {' '}driven{' '}
            <BlankInput value={home.evKmPerWeek || null} onChange={(v) => setHome({ evKmPerWeek: v ?? 0 })} placeholder="200" width={6} seed={28} />{' '}
            km/week, charged{' '}
            <BlankSelect value={home.evCharge} options={EV_CHARGE} onChange={(v) => setHome({ evCharge: v as never })} seed={29} />
          </>
        )}
        , and have{' '}
        <BlankInput value={home.solarKw || null} onChange={(v) => setHome({ solarKw: v ?? 0 })} placeholder="0" width={3} step={0.5} seed={30} />{' '}
        kW of solar
        {home.solarKw > 0 && (
          <>
            {' '}with a{' '}
            <BlankInput value={home.batteryKwh || null} onChange={(v) => setHome({ batteryKwh: v ?? 0 })} placeholder="0" width={3} step={0.5} seed={31} />{' '}
            kWh battery
          </>
        )}
        .
      </p>

      {/* Total usage — estimated from the home above, editable if you have a bill handy. */}
      <div className="usage-total">
        <p className="sentence">
          <span className="lead">That's about</span>{' '}
          <BlankInput
            value={baselineAmount}
            onChange={(v) => setBaseline(v)}
            placeholder={String(estPeriod)}
            width={7}
            seed={32}
          />{' '}
          kWh per{' '}
          <BlankSelect
            value={period}
            options={PERIOD_OPTS as unknown as { value: string; label: string }[]}
            onChange={(v) => setPeriod(v as typeof period)}
            seed={33}
          />
          .
        </p>
        <div className="slider-row">
          <input
            className="kwh-slider"
            type="range"
            min={0}
            max={sliderMax}
            step={25}
            value={baselineAmount ?? estPeriod}
            onChange={(e) => setBaseline(Number(e.target.value))}
            aria-label="Total usage"
          />
          <span className="slider-value">
            {Math.round(baselineAmount ?? estPeriod).toLocaleString('en-AU')} kWh
          </span>
        </div>
        <p className="editor-meta">
          {usingEstimate
            ? "We estimated this from your home. Got a bill handy? Pop in the real number for a sharper match."
            : 'Using your number. Clear it to fall back to the estimate from your home.'}
        </p>
      </div>

      <CurrentPlanPicker />
    </div>
  );
}
