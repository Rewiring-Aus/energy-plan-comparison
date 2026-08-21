import { useMemo } from 'react';
import { useUsageStore } from '../../store/usageStore';
import type { CostResult } from '../../types';
import { PLAN_BY_ID } from '../../lib/plans';
import { RetailerGroup } from './RetailerGroup';
import { PlanFilters } from './PlanFilters';
import { useFlip } from './useFlip';

const SHOW = 40; // retailers to show

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

  const { groups, rankOf } = useMemo(() => {
    const map = new Map<string, CostResult[]>();
    const rank = new Map<string, number>();
    ranked.forEach((r, i) => {
      rank.set(r.planId, i + 1);
      const retailer = PLAN_BY_ID.get(r.planId)?.retailer ?? 'Unknown';
      if (!map.has(retailer)) map.set(retailer, []);
      map.get(retailer)!.push(r);
    });
    // Within a retailer, on price ties prefer the simplest variant (no controlled-load add-on)
    // so the "basic" plan is the header, not a CL1/CL2 variant.
    const complexity = (planId: string) => {
      const p = PLAN_BY_ID.get(planId);
      if (!p) return 9;
      const nameHit = /control|ctl|\bcl ?[12]?\b/i.test(p.planName) ? 1 : 0;
      return (p.controlledLoad ? 1 : 0) + nameHit;
    };
    for (const results of map.values()) {
      results.sort((a, b) => {
        if (Math.abs(a.total - b.total) > 0.5) return a.total - b.total;
        const ca = complexity(a.planId);
        const cb = complexity(b.planId);
        if (ca !== cb) return ca - cb;
        const na = PLAN_BY_ID.get(a.planId)?.planName.length ?? 0;
        const nb = PLAN_BY_ID.get(b.planId)?.planName.length ?? 0;
        return na - nb;
      });
    }
    return {
      groups: [...map.entries()].map(([retailer, results]) => ({ retailer, results })),
      rankOf: (planId: string) => rank.get(planId) ?? 0,
    };
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
        {groups.slice(0, SHOW).map((g, i) => (
          <RetailerGroup
            key={g.retailer}
            retailer={g.retailer}
            results={g.results}
            planById={PLAN_BY_ID}
            rankOf={rankOf}
            best={i === 0}
            activePlanId={activePlanId}
            selectedPlanId={selectedPlanId}
            onSelect={setSelectedPlan}
          />
        ))}
      </div>
      {groups.length > SHOW && (
        <p className="plan-count" style={{ marginTop: 12 }}>
          Showing the {SHOW} cheapest retailers of {groups.length}.
        </p>
      )}
      <p className="plan-count" style={{ marginTop: 10, fontSize: 11, lineHeight: 1.5 }}>
        Estimates only, based on published reference rates. Plans marked “estimate” or “variable
        wholesale” (e.g. Amber, GloBird WHOLESAVE) track market prices and may not reflect real
        bills. Demand charges are modelled best-effort. Always confirm on{' '}
        <a href="https://www.energymadeeasy.gov.au/" target="_blank" rel="noreferrer">
          Energy Made Easy
        </a>
        .
      </p>
    </div>
  );
}
