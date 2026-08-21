import { useState } from 'react';
import type { CostResult, Plan } from '../../types';
import { PlanCard } from './PlanCard';
import { emePlanUrl } from '../../lib/plans';
import { useUsageStore } from '../../store/usageStore';

interface Props {
  /** The representative (simplest-named) plan of this offer. */
  plan: Plan;
  result: CostResult;
  /** Other plans priced identically to `plan` — the same offer under different marketing names. */
  variants: Plan[];
  rank: number;
  best: boolean;
  active: boolean;
  pinned: boolean;
  onSelect: (id: string | null) => void;
}

/** One distinct offer: the representative plan card, plus a collapsible list of same-price variants. */
export function OfferRow({ plan, result, variants, rank, best, active, pinned, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const postcode = useUsageStore((s) => s.postcode);

  return (
    <div className="offer-row">
      <PlanCard plan={plan} result={result} rank={rank} best={best} active={active} pinned={pinned} onSelect={onSelect} />

      {variants.length > 0 && (
        <>
          <button className="more-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            {open
              ? `Hide ${variants.length} other plan${variants.length > 1 ? 's' : ''} at this price`
              : `+ ${variants.length} other plan${variants.length > 1 ? 's' : ''} at this price`}
          </button>
          {open && (
            <ul className="variant-list">
              {variants.map((v) => (
                <li key={v.id}>
                  <span className="variant-name">{v.planName}</span>
                  <a className="plan-link" href={emePlanUrl(v.id, postcode)} target="_blank" rel="noreferrer">
                    view ↗
                  </a>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
