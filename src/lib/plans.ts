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
