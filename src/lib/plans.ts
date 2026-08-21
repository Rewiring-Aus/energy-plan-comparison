import type { Plan } from '../types';
import type { HomeInputs } from '../data/applianceProfiles';
import type { PlanFilters } from '../store/usageStore';
import snapshot from '../data/plans.json';
import postcodeDnsp from '../data/postcode-dnsp.json';

export const ALL_PLANS = (snapshot as { plans: Plan[] }).plans;
export const PLAN_BY_ID = new Map(ALL_PLANS.map((p) => [p.id, p]));

const POSTCODE_DNSP = postcodeDnsp as Record<string, string>;

/** The distribution network (DNSP) serving a postcode, or null if unknown. */
export function dnspForPostcode(postcode: string): string | null {
  return POSTCODE_DNSP[postcode.trim()] ?? null;
}

/** All distributors that appear in the dataset, sorted. */
export const ALL_DISTRIBUTORS = [...new Set(ALL_PLANS.flatMap((p) => p.distributors))].sort();

/** Plans served by a given distributor. */
export function plansForDnsp(dnsp: string | null): Plan[] {
  if (!dnsp) return ALL_PLANS;
  return ALL_PLANS.filter((p) => p.distributors.includes(dnsp));
}

/** Energy Made Easy plan-page URL. The CDR plan id carries a "@EME"/"@VEC" aggregator-source suffix
 *  that EME's own URL doesn't want; strip it and pass the postcode so the right network is shown. */
export function emePlanUrl(planId: string, postcode: string): string {
  const bareId = planId.split('@')[0];
  return `https://www.energymadeeasy.gov.au/plan?id=${encodeURIComponent(bareId)}&postcode=${encodeURIComponent(postcode)}`;
}

/**
 * A stable signature of everything that determines a plan's cost. Two plans with the same signature
 * are the *same offer* priced identically (a retailer's marketing-name duplicates) and collapse into
 * one row with variants; plans that differ in any billable field are distinct offers shown separately.
 */
export function pricingSignature(plan: Plan): string {
  const r4 = (n: number | undefined) => (n == null ? null : Math.round(n * 1e4) / 1e4);
  const blocks = (bs?: { perKwh: number; upToKwhPerDay?: number }[]) => bs?.map((b) => [r4(b.perKwh), b.upToKwhPerDay ?? null]);
  const wins = (ws?: { dayTypes: string[]; fromHour: number; toHour: number }[]) =>
    ws?.map((w) => [w.dayTypes.join(''), w.fromHour, w.toHour]);
  return JSON.stringify({
    rt: plan.retailer, // variants are same retailer — a white-label match elsewhere is a distinct offer
    vw: !!plan.variableWholesale,
    sup: r4(plan.supplyPerDay),
    fee: r4(plan.recurringFeeAnnual),
    sr: blocks(plan.singleRate?.blocks),
    tou: plan.touRates?.map((t) => [t.label, blocks(t.blocks), wins(t.windows)]),
    cl: plan.controlledLoad ? [r4(plan.controlledLoad.perKwh), r4(plan.controlledLoad.supplyPerDay)] : null,
    fit: plan.solarFeedIn?.map((b) => [r4(b.perKwh), b.batteryOnly ? 1 : 0, wins(b.windows)]),
    dem: plan.demandCharges?.map((d) => [r4(d.perKwPerDay), wins(d.windows)]),
  });
}

/** Whether a plan survives the current filters given the user's home + eligibility answers. */
export function passesFilters(plan: Plan, f: PlanFilters, home: Pick<HomeInputs, 'solarKw' | 'batteryKwh' | 'evCount'>): boolean {
  if (f.tariffTypes.length) {
    // Variable-wholesale plans are their own kind; otherwise single vs time-of-use (demand plans
    // count as time-of-use — the demand charge is handled by its own exclude toggle below).
    const kind = plan.variableWholesale ? 'VARIABLE' : plan.pricingModel === 'SINGLE_RATE' ? 'SINGLE_RATE' : 'TIME_OF_USE';
    if (!f.tariffTypes.includes(kind)) return false;
  }
  if (f.excludeDemand && plan.pricingModel === 'TIME_OF_USE_DEMAND') return false;
  if (f.greenPowerOnly && !plan.greenPower) return false;
  if (f.noLockIn && plan.lockIn) return false;
  if (f.hideIneligible) {
    const r = plan.restrictions;
    if (r) {
      if (r.newCustomerOnly && !f.isNewCustomer) return false;
      if (r.thirdPartyOnly && !f.allowPartnerOffers) return false;
      if (r.solarRequired && home.solarKw <= 0) return false;
      if (r.batteryRequired && home.batteryKwh <= 0) return false;
      if (r.evRequired && home.evCount <= 0) return false;
      if (r.seniorCard && !f.hasSeniorCard) return false;
    }
  }
  return true;
}
