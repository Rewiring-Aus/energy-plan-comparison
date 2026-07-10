import { useState } from 'react';
import type { CostResult, Plan } from '../../types';
import { RoughBox } from '../ui/RoughBox';
import { useUsageStore } from '../../store/usageStore';

/** Energy Made Easy plan-page URL. The CDR plan id carries a "@EME"/"@VEC" aggregator-source suffix
 *  that EME's own URL doesn't want; strip it and pass the postcode so the right network is shown. */
function emePlanUrl(planId: string, postcode: string): string {
  const bareId = planId.split('@')[0];
  return `https://www.energymadeeasy.gov.au/plan?id=${encodeURIComponent(bareId)}&postcode=${encodeURIComponent(postcode)}`;
}

const MODEL_LABEL: Record<Plan['pricingModel'], string> = {
  SINGLE_RATE: 'Single rate',
  TIME_OF_USE: 'Time of use',
  TIME_OF_USE_DEMAND: 'TOU + demand',
};

function money(v: number): string {
  const r = Math.round(v);
  return r < 0 ? `−$${Math.abs(r).toLocaleString('en-AU')}` : `$${r.toLocaleString('en-AU')}`;
}

interface Props {
  plan: Plan;
  result: CostResult;
  rank: number;
  best: boolean;
  active?: boolean; // currently driving the graph
  pinned?: boolean; // explicitly selected by the user
  current?: boolean; // the user's current plan (savings baseline)
  onSelect?: (id: string | null) => void;
}

export function PlanCard({ plan, result, rank, best, active, pinned, current, onSelect }: Props) {
  const [fixedOpen, setFixedOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const postcode = useUsageStore((s) => s.postcode);
  const b = result.breakdown;
  const r = plan.restrictions;

  return (
    <div
      className={`plan-card${best ? ' best' : ''}${active ? ' active' : ''}${current ? ' current' : ''}`}
      data-plan-id={plan.id}
      onClick={() => onSelect?.(pinned ? null : plan.id)}
    >
      {active && <span className="active-flag">← Active</span>}
      {current && <span className="current-flag">Your plan</span>}
      {best && (
        <RoughBox fill="var(--yellow)" stroke="none" roughness={2.5} seed={99} className="best-flag">
          Cheapest
        </RoughBox>
      )}

      <div className="plan-head">
        <div>
          <div className="plan-name">{plan.planName}</div>
          <div className="plan-retailer">
            {rank > 0 && <span className="plan-rank">#{rank}</span>}
            {rank > 0 ? ' · ' : ''}
            {plan.retailer}
          </div>
          <div className="plan-badges">
            {plan.variableWholesale ? (
              <span className="badge wholesale">Variable / spot</span>
            ) : (
              <span className="badge">{MODEL_LABEL[plan.pricingModel]}</span>
            )}
            {plan.planType === 'STANDING' && <span className="badge standing">Standing offer</span>}
            {plan.greenPower && <span className="badge green">GreenPower</span>}
            {r?.newCustomerOnly && <span className="badge warn">New customers</span>}
            {r?.thirdPartyOnly && <span className="badge warn">Members only</span>}
            {r?.solarRequired && <span className="badge warn">Solar required</span>}
            {r?.batteryRequired && <span className="badge warn">Battery required</span>}
            {r?.seniorCard && <span className="badge warn">Seniors card</span>}
          </div>
          <a
            className="plan-link"
            href={emePlanUrl(plan.id, postcode)}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
          >
            View plan on Energy Made Easy ↗
          </a>
        </div>

        <div className="plan-price">
          {best ? (
            <RoughBox stroke="var(--purple)" strokeWidth={2} roughness={1.8} seed={98} className="price-box">
              <span className="amount">{money(result.total)}</span>
              <span className="per">{result.effectivePerKwh ? `${(result.effectivePerKwh * 100).toFixed(0)}c/kWh` : ''}</span>
            </RoughBox>
          ) : (
            <>
              <span className="amount">{money(result.total)}</span>
              <span className="per">{result.effectivePerKwh ? `${(result.effectivePerKwh * 100).toFixed(0)}c/kWh` : ''}</span>
            </>
          )}
        </div>
      </div>

      <div className="subtotals">
        <button
          className={`subtotal${fixedOpen ? ' open' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            setFixedOpen((o) => !o);
          }}
          aria-expanded={fixedOpen}
        >
          <span className="sub-caret">{fixedOpen ? '▾' : '▸'}</span>
          <span className="sub-label">Fixed costs</span>
          <span className="sub-amount">{money(result.fixedTotal)}</span>
        </button>
        <button
          className={`subtotal${usageOpen ? ' open' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            setUsageOpen((o) => !o);
          }}
          aria-expanded={usageOpen}
        >
          <span className="sub-caret">{usageOpen ? '▾' : '▸'}</span>
          <span className="sub-label">Net usage costs</span>
          <span className="sub-amount">{money(result.usageTotal)}</span>
        </button>
      </div>

      {fixedOpen && (
        <div className="breakdown">
          <div>
            <span>Daily supply charge</span>
            <span className="val">
              {money(b.supply)} <em>({(plan.supplyPerDay * 100).toFixed(1)}c/day)</em>
            </span>
          </div>
          {b.fees > 0 && (
            <div>
              <span>Membership / recurring fees</span>
              <span className="val">{money(b.fees)}</span>
            </div>
          )}
        </div>
      )}

      {usageOpen && (
        <div className="breakdown">
          {b.usageBands.map((band) => (
            <div key={band.key} className={band.cost < 0 ? 'credit' : undefined}>
              <span>
                {band.label}
                {band.detail && <em className="band-detail"> {band.detail}</em>}
              </span>
              <span className="val">{money(band.cost)}</span>
            </div>
          ))}
        </div>
      )}

    </div>
  );
}
