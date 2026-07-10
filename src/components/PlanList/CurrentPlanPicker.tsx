import { useMemo, useState } from 'react';
import { useUsageStore } from '../../store/usageStore';
import type { Plan } from '../../types';

function variantSummary(p: Plan): string {
  const model =
    p.pricingModel === 'SINGLE_RATE' ? 'Single rate' : p.pricingModel === 'TIME_OF_USE' ? 'Time of use' : 'Demand';
  const usage = p.singleRate?.blocks[0]?.perKwh ?? p.touRates?.[0]?.blocks[0]?.perKwh ?? 0;
  return `${model} · ${Math.round(usage * 100)}c/kWh · ${Math.round(p.supplyPerDay * 100)}c/day`;
}

/** Cascading retailer → plan → variant picker to set the user's current plan. */
export function CurrentPlanPicker({ plans }: { plans: Plan[] }) {
  const currentPlanId = useUsageStore((s) => s.currentPlanId);
  const setCurrentPlan = useUsageStore((s) => s.setCurrentPlan);

  const current = plans.find((p) => p.id === currentPlanId);
  const [retailer, setRetailer] = useState(current?.retailer ?? '');
  const [planName, setPlanName] = useState(current?.planName ?? '');

  const retailers = useMemo(() => [...new Set(plans.map((p) => p.retailer))].sort(), [plans]);
  const names = useMemo(
    () => [...new Set(plans.filter((p) => p.retailer === retailer).map((p) => p.planName))].sort(),
    [plans, retailer],
  );
  const variants = useMemo(
    () => plans.filter((p) => p.retailer === retailer && p.planName === planName),
    [plans, retailer, planName],
  );

  return (
    <div className="current-picker">
      <p className="current-picker-note">Select your current plan (optional) to compare possible savings</p>
      <div className="current-picker-row">
        <span className="current-picker-label">Your current plan:</span>
        <select
          className="picker-select"
          value={retailer}
          onChange={(e) => {
            setRetailer(e.target.value);
            setPlanName('');
            setCurrentPlan(null);
          }}
        >
          <option value="">Retailer…</option>
          {retailers.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>

        {retailer && (
          <select
            className="picker-select"
            value={planName}
            onChange={(e) => {
              setPlanName(e.target.value);
              const vs = plans.filter((p) => p.retailer === retailer && p.planName === e.target.value);
              setCurrentPlan(vs.length === 1 ? vs[0].id : null);
            }}
          >
            <option value="">Plan…</option>
            {names.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        )}

        {planName && variants.length > 1 && (
          <select className="picker-select" value={currentPlanId ?? ''} onChange={(e) => setCurrentPlan(e.target.value || null)}>
            <option value="">Which one?…</option>
            {variants.map((v) => (
              <option key={v.id} value={v.id}>
                {variantSummary(v)}
              </option>
            ))}
          </select>
        )}

        {currentPlanId && (
          <button
            className="picker-clear"
            onClick={() => {
              setCurrentPlan(null);
              setRetailer('');
              setPlanName('');
            }}
          >
            clear
          </button>
        )}
      </div>
    </div>
  );
}
