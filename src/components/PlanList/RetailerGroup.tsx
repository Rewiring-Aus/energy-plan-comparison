import { useState } from 'react';
import type { CostResult, Plan } from '../../types';
import { PlanCard } from './PlanCard';

interface Props {
  retailer: string;
  /** This retailer's offers, cheapest first. */
  results: CostResult[];
  planById: Map<string, Plan>;
  rankOf: (planId: string) => number;
  best: boolean; // is this the cheapest retailer overall?
  activePlanId?: string;
  selectedPlanId: string | null;
  currentPlanId: string | null;
  onSelect: (id: string | null) => void;
}

export function RetailerGroup({
  retailer,
  results,
  planById,
  rankOf,
  best,
  activePlanId,
  selectedPlanId,
  currentPlanId,
  onSelect,
}: Props) {
  const [open, setOpen] = useState(false);
  const header = results[0];
  const others = results.slice(1);
  const headerPlan = planById.get(header.planId);
  if (!headerPlan) return null;

  const cardProps = (planId: string) => ({
    active: activePlanId === planId,
    pinned: selectedPlanId === planId,
    current: currentPlanId === planId,
    onSelect,
  });

  return (
    <div className="retailer-group">
      <PlanCard plan={headerPlan} result={header} rank={rankOf(header.planId)} best={best} {...cardProps(header.planId)} />

      {others.length > 0 && (
        <button className="more-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open
            ? `Hide ${others.length} other ${retailer} offer${others.length > 1 ? 's' : ''}`
            : `+ ${others.length} more ${retailer} offer${others.length > 1 ? 's' : ''}`}
        </button>
      )}

      {open &&
        others.map((r) => {
          const plan = planById.get(r.planId);
          if (!plan) return null;
          return (
            <div className="nested-offer" key={r.planId}>
              <PlanCard plan={plan} result={r} rank={rankOf(r.planId)} best={false} {...cardProps(r.planId)} />
            </div>
          );
        })}
    </div>
  );
}
