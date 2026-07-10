import { useMemo, useState } from 'react';
import { useUsageStore } from '../../store/usageStore';
import { dnspForPostcode, plansForDnsp } from '../../lib/plans';
import { BlankSelect } from '../ui/BlankSelect';
import type { Plan } from '../../types';

function variantSummary(p: Plan): string {
  const model =
    p.pricingModel === 'SINGLE_RATE' ? 'Single rate' : p.pricingModel === 'TIME_OF_USE' ? 'Time of use' : 'Demand';
  const usage = p.singleRate?.blocks[0]?.perKwh ?? p.touRates?.[0]?.blocks[0]?.perKwh ?? 0;
  return `${model} · ${Math.round(usage * 100)}c/kWh · ${Math.round(p.supplyPerDay * 100)}c/day`;
}

type Opt = { value: string; label: string };

/**
 * Optional "current plan" picker, phrased as a fill-in-the-blanks sentence to match the rest of the
 * Your Home panel. Cascades retailer → plan → variant; setting it lets the tool show savings.
 */
export function CurrentPlanPicker() {
  const postcode = useUsageStore((s) => s.postcode);
  const currentPlanId = useUsageStore((s) => s.currentPlanId);
  const setCurrentPlan = useUsageStore((s) => s.setCurrentPlan);
  const plans = useMemo(() => plansForDnsp(dnspForPostcode(postcode)), [postcode]);

  const current = plans.find((p) => p.id === currentPlanId);
  const [retailer, setRetailer] = useState(current?.retailer ?? '');
  const [planName, setPlanName] = useState(current?.planName ?? '');

  const retailerOpts: Opt[] = useMemo(
    () => [{ value: '', label: 'a retailer…' }, ...[...new Set(plans.map((p) => p.retailer))].sort().map((r) => ({ value: r, label: r }))],
    [plans],
  );
  const nameOpts: Opt[] = useMemo(
    () => [
      { value: '', label: 'a plan…' },
      ...[...new Set(plans.filter((p) => p.retailer === retailer).map((p) => p.planName))].sort().map((n) => ({ value: n, label: n })),
    ],
    [plans, retailer],
  );
  const variants = useMemo(
    () => plans.filter((p) => p.retailer === retailer && p.planName === planName),
    [plans, retailer, planName],
  );
  const variantOpts: Opt[] = useMemo(
    () => [{ value: '', label: 'which one?…' }, ...variants.map((v) => ({ value: v.id, label: variantSummary(v) }))],
    [variants],
  );

  return (
    <div className="current-plan-setup">
      <p className="sentence">
        <span className="lead">We're buying our electricity from</span>{' '}
        <BlankSelect
          value={retailer}
          options={retailerOpts}
          seed={40}
          onChange={(v) => {
            setRetailer(v);
            setPlanName('');
            setCurrentPlan(null);
          }}
        />
        {retailer && (
          <>
            {' '}on{' '}
            <BlankSelect
              value={planName}
              options={nameOpts}
              seed={41}
              onChange={(v) => {
                setPlanName(v);
                const vs = plans.filter((p) => p.retailer === retailer && p.planName === v);
                setCurrentPlan(vs.length === 1 ? vs[0].id : null);
              }}
            />
          </>
        )}
        {planName && variants.length > 1 && (
          <>
            {' — '}
            <BlankSelect value={currentPlanId ?? ''} options={variantOpts} seed={42} onChange={(v) => setCurrentPlan(v || null)} />
          </>
        )}
        .
        {currentPlanId && (
          <>
            {' '}
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
          </>
        )}
      </p>
      <p className="editor-meta">Optional — tell us your plan and we'll show what you could save by switching.</p>
    </div>
  );
}
