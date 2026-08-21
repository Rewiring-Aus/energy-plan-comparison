import { useMemo } from 'react';
import { useUsageStore } from '../../store/usageStore';
import type { CostResult } from '../../types';
import { PLAN_BY_ID, pricingSignature } from '../../lib/plans';
import { OfferRow } from './OfferRow';
import { PlanFilters } from './PlanFilters';
import { useFlip } from './useFlip';

const SHOW = 50; // distinct offers to show

interface Props {
  ranked: CostResult[];
  activePlanId?: string;
  dnsp: string | null;
  postcode: string;
  total: number;
}

export function PlanList({ ranked, activePlanId, dnsp, postcode, total }: Props) {
  const selectedPlanId = useUsageStore((s) => s.selectedPlanId);
  const setSelectedPlan = useUsageStore((s) => s.setSelectedPlan);

  // Group by *pricing signature* (not retailer): identically-priced plans collapse into one offer
  // with same-price variants; genuinely distinct offers — even from the same retailer — list
  // separately, cheapest first.
  const { offers, rankOf } = useMemo(() => {
    const map = new Map<string, CostResult[]>();
    for (const r of ranked) {
      const p = PLAN_BY_ID.get(r.planId);
      if (!p) continue;
      const key = pricingSignature(p);
      (map.get(key) ?? map.set(key, []).get(key)!).push(r);
    }
    // Within an offer, pick the simplest-named plan as the representative (avoid a CL variant header).
    const complexity = (planId: string) => {
      const p = PLAN_BY_ID.get(planId);
      if (!p) return 9;
      return (p.controlledLoad ? 1 : 0) + (/control|ctl|\bcl ?[12]?\b/i.test(p.planName) ? 1 : 0);
    };
    const offers = [...map.values()].map((results) =>
      [...results].sort((a, b) => {
        const ca = complexity(a.planId);
        const cb = complexity(b.planId);
        if (ca !== cb) return ca - cb;
        const na = PLAN_BY_ID.get(a.planId)?.planName.length ?? 0;
        const nb = PLAN_BY_ID.get(b.planId)?.planName.length ?? 0;
        return na - nb;
      }),
    );
    // Cheapest offer first (all members of an offer share the same total).
    offers.sort((a, b) => a[0].total - b[0].total);
    const rank = new Map<string, number>();
    offers.forEach((o, i) => rank.set(o[0].planId, i + 1));
    return { offers, rankOf: (planId: string) => rank.get(planId) ?? 0 };
  }, [ranked]);

  const listRef = useFlip<HTMLDivElement>();

  return (
    <div>
      {!dnsp && (
        <p className="plan-count">
          Postcode <strong>{postcode}</strong> isn't matched to a distribution network in our data.
        </p>
      )}

      <PlanFilters shown={ranked.length} total={total} area={dnsp ?? undefined} />

      <div className="plan-list" ref={listRef}>
        {offers.slice(0, SHOW).map((results, i) => {
          const rep = results[0];
          const repPlan = PLAN_BY_ID.get(rep.planId)!;
          const variants = results.slice(1).flatMap((r) => PLAN_BY_ID.get(r.planId) ?? []);
          const ids = results.map((r) => r.planId);
          return (
            <OfferRow
              key={rep.planId}
              plan={repPlan}
              result={rep}
              variants={variants}
              rank={rankOf(rep.planId)}
              best={i === 0}
              active={!!activePlanId && ids.includes(activePlanId)}
              pinned={!!selectedPlanId && ids.includes(selectedPlanId)}
              onSelect={setSelectedPlan}
            />
          );
        })}
      </div>
      {offers.length > SHOW && (
        <p className="plan-count" style={{ marginTop: 12 }}>
          Showing the {SHOW} cheapest offers of {offers.length.toLocaleString('en-AU')}.
        </p>
      )}
      <p className="plan-count" style={{ marginTop: 10, fontSize: 11, lineHeight: 1.5 }}>
        Estimates only, based on published reference rates. Plans marked “variable / spot” (e.g.
        Amber) track market prices and may not reflect real bills. Demand charges are modelled
        best-effort. Always confirm on{' '}
        <a href="https://www.energymadeeasy.gov.au/" target="_blank" rel="noreferrer">
          Energy Made Easy
        </a>
        .
      </p>
    </div>
  );
}
