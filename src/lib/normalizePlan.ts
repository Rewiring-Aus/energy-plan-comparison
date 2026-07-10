// Converts a raw CDR Energy "Get Generic Plan Detail" payload into our compact Plan schema.
// Shared by the fetch script (scripts/fetch-plans.ts) and unit tests.

import type {
  DayType,
  DemandCharge,
  FeedInBand,
  Plan,
  PricingModel,
  RateBlock,
  TimeWindow,
  TouLabel,
  TouRate,
} from '../types';
import { resolveTouRate } from './time';
import { networkTariffFor, regionForDnsp } from '../data/networkTariffs';
import wholesaleData from '../data/wholesale-price.json';

// --- Variable-wholesale (Amber-style spot) modelling -----------------------
const WHOLESALE = (wholesaleData as { curves: Record<string, number[]> }).curves;
const LOSS_FACTOR = 1.05; // grid losses between generation and the home
const MARKET_ADDER = 0.02; // environmental + market charges ($/kWh)
const FIT_FEE = 0.005; // small fee netted off the wholesale export credit ($/kWh)

// --- Raw CDR shapes (only the fields we use) -------------------------------

interface RawRate {
  unitPrice: string;
  volume?: number; // block threshold in kWh for the *period*
}
interface RawTimeOfUse {
  days: string[];
  startTime: string; // "HH:mm"
  endTime: string; // "HH:mm" ("00:00" as endTime == midnight)
}
interface RawTariffRateSet {
  rates: RawRate[];
  type?: string; // PEAK | SHOULDER | OFF_PEAK | OFFPEAK ...
  period?: string; // e.g. "P1D"
  timeOfUse?: RawTimeOfUse[];
}
interface RawTariffPeriod {
  rateBlockUType: 'singleRate' | 'timeOfUseRates' | 'demandCharges';
  dailySupplyCharge?: string;
  startDate?: string; // "MM-DD" — seasonal periods
  endDate?: string; // "MM-DD"
  singleRate?: { rates: RawRate[] };
  timeOfUseRates?: RawTariffRateSet[];
  demandCharges?: Array<{
    amount?: string;
    measurementPeriod?: string; // DAY | MONTH ...
    chargePeriod?: string;
    days?: string[];
    startTime?: string;
    endTime?: string;
  }>;
}

const MONTH_CUM = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
function dayOfYear(mmdd: string): number {
  const [m, d] = mmdd.split('-').map(Number);
  return (MONTH_CUM[(m || 1) - 1] ?? 0) + (d || 1);
}
/** Days covered by a "MM-DD".."MM-DD" range (inclusive, wraps the year). */
function seasonDays(tp: RawTariffPeriod): number {
  if (!tp.startDate || !tp.endDate) return 365;
  const a = dayOfYear(tp.startDate);
  const b = dayOfYear(tp.endDate);
  return b >= a ? b - a + 1 : 365 - a + 1 + b;
}

/**
 * Plans can carry several *seasonal* tariffPeriods (e.g. 1st Opal: winter/summer peak 43.7c but
 * autumn/spring peak 17.4c). Picking the first silently under- or over-prices. Blend them into one
 * effective period by day-weighting each rate — grouped by band type + time window.
 */
function mergeTariffPeriods(periods: RawTariffPeriod[]): RawTariffPeriod {
  if (periods.length <= 1) return periods[0];
  const base = periods[0];
  const weights = periods.map(seasonDays);
  const wavg = (vals: number[], ws: number[]) => {
    let n = 0,
      w = 0;
    vals.forEach((v, i) => {
      if (Number.isFinite(v)) {
        n += v * ws[i];
        w += ws[i];
      }
    });
    return w ? n / w : 0;
  };

  if (base.rateBlockUType === 'timeOfUseRates') {
    // Group each period's TOU bands by type + window signature.
    const groups = new Map<string, { set: RawTariffRateSet; prices: number[][]; ws: number[] }>();
    periods.forEach((tp, i) => {
      for (const set of tp.timeOfUseRates ?? []) {
        const sig =
          (set.type ?? '') + (set.timeOfUse ?? []).map((t) => `${t.startTime}-${t.endTime}`).join(',');
        let g = groups.get(sig);
        if (!g) groups.set(sig, (g = { set, prices: [], ws: [] }));
        g.prices.push(set.rates.map((r) => Number(r.unitPrice)));
        g.ws.push(weights[i]);
      }
    });
    const merged: RawTariffRateSet[] = [];
    for (const g of groups.values()) {
      const nBlocks = Math.max(...g.prices.map((p) => p.length));
      const rates: RawRate[] = [];
      for (let bi = 0; bi < nBlocks; bi++) {
        const price = wavg(g.prices.map((p) => p[bi]), g.ws);
        rates.push({ unitPrice: String(price), volume: g.set.rates[bi]?.volume });
      }
      merged.push({ ...g.set, rates });
    }
    return { ...base, timeOfUseRates: merged };
  }

  if (base.rateBlockUType === 'singleRate') {
    const nBlocks = Math.max(...periods.map((p) => p.singleRate?.rates.length ?? 0));
    const rates: RawRate[] = [];
    for (let bi = 0; bi < nBlocks; bi++) {
      const price = wavg(
        periods.map((p) => Number(p.singleRate?.rates[bi]?.unitPrice)).filter((x) => Number.isFinite(x)),
        weights,
      );
      rates.push({ unitPrice: String(price), volume: base.singleRate?.rates[bi]?.volume });
    }
    return { ...base, singleRate: { rates } };
  }

  return base; // demand-only: keep first
}
interface RawControlledLoad {
  rateBlockUType: 'singleRate' | 'timeOfUseRates';
  dailySupplyCharge?: string;
  singleRate?: { rates: RawRate[] };
  timeOfUseRates?: RawTariffRateSet[];
}
interface RawSolarFiT {
  scheme?: string;
  description?: string;
  tariffUType: 'singleTariff' | 'timeVaryingTariffs';
  singleTariff?: { rates: RawRate[] };
  timeVaryingTariffs?: Array<{
    rates: RawRate[];
    timeVariations?: RawTimeOfUse[];
  }>;
}

/**
 * A feed-in rate that is an estimate *assuming a battery* (e.g. Amber's wholesale FiT for an
 * 8kW+13kWh arbitrage setup). Such a rate is only achievable via battery export, so we don't
 * credit it against direct solar export. An explicit "without battery" estimate is genuine.
 */
function isBatteryEstimateFit(desc?: string): boolean {
  const d = (desc || '').toLowerCase();
  const isEstimate = /\bestimate\b|\baverage\b/.test(d);
  const assumesBattery = /\bbattery\b/.test(d) && !/without (a )?battery|no battery/.test(d);
  return isEstimate && assumesBattery;
}
interface RawFee {
  type?: string; // MEMBERSHIP | LATE_PAYMENT | CONNECTION | ...
  term?: string; // 1_TIME | DAILY | WEEKLY | MONTHLY | BIANNUAL | ANNUAL | PERCENT_OF_BILL ...
  amount?: string;
  rate?: string;
}
interface RawBenefit {
  displayName?: string;
  description?: string;
}
interface RawEligibility {
  type?: string; // NEW_CUSTOMER | EXISTING_CUST | THIRD_PARTY_ONLY | SENIOR_CARD | EXISTING_SOLAR | ...
  information?: string;
  description?: string;
}
interface RawElectricityContract {
  pricingModel?: string;
  isFixed?: boolean;
  tariffPeriod?: RawTariffPeriod[];
  controlledLoad?: RawControlledLoad[];
  solarFeedInTariff?: RawSolarFiT[];
  fees?: RawFee[];
  incentives?: RawBenefit[];
  discounts?: RawBenefit[];
  eligibility?: RawEligibility[];
  greenPowerCharges?: unknown;
}

/** Parse the CDR eligibility[] list into structured restriction flags. */
function parseRestrictions(elig: RawEligibility[]): {
  restrictions?: import('../types').PlanRestrictions;
  notes: string[];
} {
  const notes: string[] = [];
  const r = {
    newCustomerOnly: false,
    thirdPartyOnly: false,
    solarRequired: false,
    batteryRequired: false,
    evRequired: false,
    seniorCard: false,
  };

  // A sentence that GATES eligibility ("only available to customers with…", "you must have…",
  // "net metered solar…") as opposed to a pricing-ESTIMATE assumption ("usage estimate based on a
  // typical 5kW solar system"). Retailers like Flow Power put BOTH in one eligibility block — a real
  // hardware requirement AND an estimate caveat — so we split into sentences and only trust gate
  // sentences for the solar/battery/EV requirements. Amber tags plans EXISTING_SOLAR but its text is
  // just an estimate assumption (no gate sentence), so those must NOT read as a requirement.
  // NB: the "with"/"to"/"for" tokens end in \b so they don't match inside "without"/"together" —
  // "households without a solar or battery system" is an estimate caveat, NOT a gate.
  const isGate = (s: string) =>
    /only available|available (only )?(to|for)\b|must (have|own|be)|you (need|must)|require|eligib|customers? (with\b|who)|households? with\b|net metered|qualifying solar/.test(s);
  const isEstimate = (s: string) => /estimate|based on|typical|assum|average/.test(s);

  for (const e of elig) {
    const type = (e.type || '').toUpperCase();
    const text = `${e.information ?? ''} ${e.description ?? ''}`.toLowerCase();
    if (e.information) notes.push(e.information);

    // Membership/partner gating: the CDR enum carries this cleanly (ORG_MEMBER, LOYALTY_MEMBER,
    // SPORT_CLUB_MEMBER, THIRD_PARTY_ONLY — 983 plans across the national set), so prefer the
    // structured type. The free-text matcher is a fallback for retailers who use type=OTHER.
    if (
      type === 'THIRD_PARTY_ONLY' || type === 'ORG_MEMBER' || type === 'LOYALTY_MEMBER' || type === 'SPORT_CLUB_MEMBER' ||
      /member|rewards|velocity|partner|qantas|nrma|racv|bp /.test(text)
    )
      r.thirdPartyOnly = true;
    if (type === 'NEW_CUSTOMER' || /new (and moving |residential )?customer|new to|moving in|move-?in/.test(text))
      r.newCustomerOnly = true;
    if (type === 'SENIOR_CARD' || type === 'PENSIONER' || /senior|pension|concession/.test(text))
      r.seniorCard = true;

    // Hardware requirements (solar/battery/EV). NB the CDR enum is sparse here — `type: OTHER`
    // outnumbers the typed values ~9:1, EXISTING_SOLAR covers only ~1/3 of real solar gates, and
    // there is NO EV type at all — so this free-text pass is load-bearing, not decoration. It is
    // deliberately FROZEN: do not add more heuristics chasing new phrasings. When it's wrong, LOOSEN
    // (fewer false positives), never tighten. As the AER fills in EXISTING_* over time this shrinks.
    // Only a GATE sentence counts, never a pricing-estimate assumption
    // (e.g. "the pricing estimate is for households without a solar or battery system").
    const gates = text.split(/[.;]+/).map((s) => s.trim()).filter((s) => s && isGate(s) && !isEstimate(s));
    // Suppress the CDR type flag when the ONLY textual evidence is an estimate assumption (Amber).
    // Empty text keeps the flag — ENGIE/EnergyAustralia/AGL tag EXISTING_SOLAR with no note at all.
    const estimateOnly = text.trim() !== '' && isEstimate(text) && gates.length === 0;

    if (type === 'EXISTING_SOLAR' && !estimateOnly) r.solarRequired = true;
    if (type === 'EXISTING_BATTERY' && !estimateOnly) r.batteryRequired = true;
    // Within a gate sentence, only OWNING the hardware counts — "solar (pv|system|panel)" or an
    // ownership verb near the keyword. This rejects incidental mentions like "solar feed-in tariff
    // eligibility" (that's about FiT eligibility, not a requirement to have panels).
    const OWN = String.raw`(with|have|having|own|owning|existing|install(ed|ing)?|require[sd]?|qualifying)\b[\w\s,&()/-]{0,40}?\b`;
    for (const s of gates) {
      const solarOwn = new RegExp(`\\bsolar[- ](pv|system|panel|panels|customer|inverter|installation)|${OWN}solar\\b`).test(s);
      if (solarOwn && !/non-?solar|without (a |an )?solar|no solar\b/.test(s)) r.solarRequired = true;
      const batteryOwn = new RegExp(`\\bbatter(y|ies)[- ]?(system|storage|pack)|${OWN}batter`).test(s);
      if (batteryOwn && !/without (a |an )?batter|no batter/.test(s)) r.batteryRequired = true;
      if (
        (/\bev\b|\bevs\b|electric vehicle/.test(s)) &&
        !/without (an? )?(ev|electric vehicle)|no (ev|electric vehicle)/.test(s)
      )
        r.evRequired = true;
    }
  }
  const any =
    r.newCustomerOnly || r.thirdPartyOnly || r.solarRequired || r.batteryRequired || r.evRequired || r.seniorCard;
  return { restrictions: any ? r : undefined, notes };
}
export interface RawPlanDetail {
  planId: string;
  displayName?: string;
  type?: string; // STANDING | MARKET | REGULATED
  brand?: string;
  brandName?: string;
  fuelType?: string;
  planUrl?: string;
  geography?: { distributors?: string[] };
  electricityContract?: RawElectricityContract;
}

// --- Helpers ----------------------------------------------------------------

const WEEKDAY_DAYS = new Set(['MON', 'TUE', 'WED', 'THU', 'FRI']);
const WEEKEND_DAYS = new Set(['SAT', 'SUN']);

/** "HH:mm" -> hour as a float 0..24. "00:00" as an end-time becomes 24. */
function parseHour(t: string, isEnd: boolean): number {
  const [h, m] = t.split(':').map(Number);
  const v = h + (m || 0) / 60;
  if (isEnd && v === 0) return 24;
  return v;
}

function daysToDayTypes(days: string[]): DayType[] {
  const out = new Set<DayType>();
  for (const d of days) {
    const u = d.toUpperCase();
    if (WEEKDAY_DAYS.has(u)) out.add('WEEKDAY');
    if (WEEKEND_DAYS.has(u)) out.add('WEEKEND');
  }
  return out.size ? [...out] : ['WEEKDAY', 'WEEKEND'];
}

function toWindows(tou?: RawTimeOfUse[]): TimeWindow[] {
  if (!tou || !tou.length) {
    return [{ dayTypes: ['WEEKDAY', 'WEEKEND'], fromHour: 0, toHour: 24 }];
  }
  return tou.map((t) => ({
    dayTypes: daysToDayTypes(t.days),
    fromHour: parseHour(t.startTime, false),
    toHour: parseHour(t.endTime, true),
  }));
}

/** CDR rates carry a per-period `volume` threshold; we bill per day so use it as a daily cap. */
function toBlocks(rates: RawRate[]): RateBlock[] {
  return rates
    .map((r) => ({
      perKwh: Number(r.unitPrice),
      upToKwhPerDay: r.volume != null ? Number(r.volume) : undefined,
    }))
    .filter((b) => Number.isFinite(b.perKwh));
}

function normTouLabel(type?: string): TouLabel {
  const u = (type || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (u.includes('PEAK') && u.includes('OFF')) return 'OFFPEAK';
  if (u === 'OFFPEAK') return 'OFFPEAK';
  if (u.includes('SHOULDER')) return 'SHOULDER';
  if (u.includes('CONTROLLED')) return 'OFFPEAK';
  return 'PEAK';
}

function mapPricingModel(m?: string): PricingModel {
  const u = (m || '').toUpperCase();
  if (u.includes('DEMAND')) return 'TIME_OF_USE_DEMAND';
  if (u.includes('TIME')) return 'TIME_OF_USE';
  return 'SINGLE_RATE';
}

/** Annualise a recurring fee. Returns 0 for one-off (1_TIME) or conditional (PERCENT*) fees. */
const FEE_TERM_PER_YEAR: Record<string, number> = {
  DAILY: 365,
  WEEKLY: 52,
  MONTHLY: 12,
  BIANNUAL: 2,
  ANNUAL: 1,
};
function annualiseFee(fee: RawFee): number {
  const mult = FEE_TERM_PER_YEAR[(fee.term || '').toUpperCase()];
  if (!mult) return 0; // 1_TIME / PERCENT_OF_BILL / unknown -> excluded
  const amount = Number(fee.amount);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return amount * mult;
}

/**
 * Detect "free usage window" plans (e.g. OVO "Free 3" 11am–2pm). These benefits live in the
 * incentives/discounts free-text, not the tariff rates, so we parse a daily time range from any
 * description that mentions "free" and treat those hours as $0 import.
 */
function to24(hour: number, ampm: string): number {
  const h = hour % 12;
  return ampm.toLowerCase() === 'pm' ? h + 12 : h;
}
function parseFreeWindows(benefits: RawBenefit[]): TimeWindow[] {
  const windows: TimeWindow[] = [];
  const re = /(\d{1,2})\s*(am|pm)?\s*(?:and|to|until|[-–—])\s*(\d{1,2})\s*(am|pm)/gi;
  for (const b of benefits) {
    const text = `${b.displayName ?? ''} ${b.description ?? ''}`;
    if (!/free/i.test(text)) continue;
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(text))) {
      const endAp = m[4];
      const startAp = m[2] ?? endAp; // "11am and 2pm" -> startAp 'am'; "11 to 2pm" -> fall back to end's
      const from = to24(Number(m[1]), startAp);
      const to = to24(Number(m[3]), endAp);
      if (Number.isFinite(from) && Number.isFinite(to) && to > from && to - from <= 12) {
        windows.push({ dayTypes: ['WEEKDAY', 'WEEKEND'], fromHour: from, toHour: to });
      }
    }
    if (windows.length) break; // first matching benefit wins
  }
  return windows;
}

/** Demand amounts are typically $/kW/month or $/kW/day; normalise to per-day. */
function demandPerDay(amount: number, measurementPeriod?: string): number {
  const p = (measurementPeriod || '').toUpperCase();
  if (p.includes('MONTH')) return amount / 30.4375;
  if (p.includes('YEAR') || p.includes('ANNUM')) return amount / 365;
  return amount; // assume per-day
}

// --- Main -------------------------------------------------------------------

/**
 * A spot-passthrough plan (Amber, GloBird WHOLESAVE). "variable" alone is too broad
 * (many ordinary market plans say "variable rate"), so we require an explicit wholesale/spot marker.
 * Flow Power has monthly pool-based pricing (not spot passthrough) — excluded here, treated as flat rate.
 */
function isVariableWholesale(raw: RawPlanDetail): boolean {
  // Standing/regulated offers are the DMO *reference* tariff — always conventional set rates, never
  // spot. Amber/Flow publish these alongside their market products (e.g. "Standing Offer: TOU").
  if (raw.type === 'STANDING' || raw.type === 'REGULATED') return false;
  const brand = `${raw.brandName ?? ''} ${raw.brand ?? ''}`.toLowerCase();
  const displayName = (raw.displayName ?? '').toLowerCase();

  // Flow Power uses monthly pool-based adjustments, not spot passthrough — exclude it.
  if (/\bflow\s*power\b/.test(brand)) return false;

  // Retailers whose ENTIRE market book is spot-passthrough (their plan names don't always say so).
  if (/\bamber\b|powerclub|localvolts/.test(brand)) return true;
  // Everyone else sells wholesale on SPECIFIC plans only, so match the plan name — e.g.
  // GloBird's spot plan is "WHOLESAVE". "variable" alone is too broad (many ordinary market plans
  // are "variable rate"), so require "wholesale"/"spot"/wholesave/real-time markers.
  return /\bwholesale\b|\bspot\b|wholesave|real[- ]?time/.test(`${brand} ${displayName}`);
}

/**
 * Flow Power names its hardware-gated products descriptively ("Flow Home Battery + Solar",
 * "FH Battery + Solar + EV") but its structured CDR eligibility is INCONSISTENT: some plan instances
 * carry EXISTING_SOLAR/EXISTING_BATTERY type flags, others under the same name carry none, and the
 * descriptions are estimate assumptions that our estimateOnly guard suppresses (to avoid Amber false
 * positives). The plan NAME is the one reliable, per-instance signal, so infer the solar/battery/EV
 * requirement from it. **Scoped to Flow Power** — a general name rule would wrongly gate Amber and
 * other retailers' "Solar"-named spot plans, where the hardware is assumed for the estimate, not required.
 */
function nameRequirements(raw: RawPlanDetail): Partial<import('../types').PlanRestrictions> | null {
  const brand = `${raw.brandName ?? ''} ${raw.brand ?? ''}`.toLowerCase();
  if (!/\bflow[\s-]*power\b/.test(brand)) return null;
  const name = (raw.displayName ?? '').toLowerCase();
  const out: Partial<import('../types').PlanRestrictions> = {};
  if (/\bsolar\b/.test(name)) out.solarRequired = true;
  if (/\bbattery\b/.test(name)) out.batteryRequired = true;
  if (/\bev\b/.test(name)) out.evRequired = true;
  return Object.keys(out).length ? out : null;
}

/**
 * Replace a variable-wholesale plan's flat CDR estimate with a 24×1h TOU built from the wholesale
 * price curve (per NEM region) + the DNSP's default network tariff + market charges, plus a
 * wholesale feed-in curve (Amber pays ~spot for exports). Leaves the plan untouched outside the NEM.
 */
function applyWholesaleModel(plan: Plan): void {
  const dnsp = plan.distributors?.[0];
  const region = regionForDnsp(dnsp);
  const curve = region ? WHOLESALE[region] : undefined;
  if (!curve || curve.length !== 24) return; // WA/NT or missing data — keep the flat estimate
  const net = networkTariffFor(dnsp);
  const netAt = (h: number) => resolveTouRate(net.touRates, h, 'WEEKDAY')?.blocks[0]?.perKwh ?? 0;
  const hourWindow = (h: number): TimeWindow => ({ dayTypes: ['WEEKDAY', 'WEEKEND'], fromHour: h, toHour: h + 1 });

  plan.variableWholesale = true;
  plan.pricingModel = 'TIME_OF_USE';
  plan.singleRate = undefined;
  plan.freeWindows = undefined;
  // Keep the plan's REAL published daily supply charge (from the CDR, set above) — it already
  // bundles network + retail supply and matches Energy Made Easy. Only the per-kWh energy rate is
  // synthesized from wholesale + network; the network-tariff supply figure is not used here.
  plan.touRates = curve.map((w, h) => ({
    label: 'OFFPEAK' as TouLabel,
    blocks: [{ perKwh: w * LOSS_FACTOR + netAt(h) + MARKET_ADDER }],
    windows: [hourWindow(h)],
  }));
  plan.solarFeedIn = curve.map((w, h) => ({ perKwh: Math.max(0, w - FIT_FEE), windows: [hourWindow(h)] }));
}

// CDR / AER Product Reference Data rates are GST-EXCLUSIVE (the AER's own price lists are labelled
// "excl GST"; the customer-facing DMO is "inc. GST"). Gross every charge up by 10% so totals and
// displayed c/kWh match real retail offers. Solar feed-in is GST-FREE for residential customers, so
// it is left untouched.
const GST = 1.1;
function applyGst(plan: Plan): void {
  const grossBlocks = (blocks?: RateBlock[]) => blocks?.forEach((b) => (b.perKwh *= GST));
  if (plan.singleRate) grossBlocks(plan.singleRate.blocks);
  plan.touRates?.forEach((r) => grossBlocks(r.blocks));
  plan.supplyPerDay *= GST;
  if (plan.controlledLoad) {
    plan.controlledLoad.perKwh *= GST;
    if (plan.controlledLoad.supplyPerDay != null) plan.controlledLoad.supplyPerDay *= GST;
  }
  plan.demandCharges?.forEach((d) => (d.perKwPerDay *= GST));
  if (plan.recurringFeeAnnual != null) plan.recurringFeeAnnual *= GST;
  // plan.solarFeedIn: intentionally NOT grossed — residential feed-in is GST-free.
}

export function normalizePlan(raw: RawPlanDetail): Plan | null {
  const c = raw.electricityContract;
  if (!c) return null;

  // The CDR allows multiple seasonal tariffPeriods; we use the first (full-year is typical).
  // Blend seasonal tariffPeriods into one effective period (day-weighted).
  const tp = c.tariffPeriod?.length ? mergeTariffPeriods(c.tariffPeriod) : undefined;
  if (!tp) return null;

  const plan: Plan = {
    id: raw.planId,
    retailer: raw.brandName || raw.brand || 'Unknown',
    brand: raw.brand || '',
    planName: raw.displayName || raw.planId,
    planType: raw.type === 'STANDING' || raw.type === 'REGULATED' ? 'STANDING' : 'MARKET',
    fuelType: 'ELECTRICITY',
    distributors: raw.geography?.distributors ?? [],
    supplyPerDay: Number(tp.dailySupplyCharge ?? 0),
    pricingModel: mapPricingModel(c.pricingModel),
    planUrl: raw.planUrl,
  };

  if (tp.rateBlockUType === 'singleRate' && tp.singleRate) {
    plan.singleRate = { blocks: toBlocks(tp.singleRate.rates) };
    plan.pricingModel = 'SINGLE_RATE';
  } else if (tp.rateBlockUType === 'timeOfUseRates' && tp.timeOfUseRates) {
    plan.touRates = tp.timeOfUseRates.map<TouRate>((r) => ({
      label: normTouLabel(r.type),
      blocks: toBlocks(r.rates),
      windows: toWindows(r.timeOfUse),
    }));
    if (plan.pricingModel === 'SINGLE_RATE') plan.pricingModel = 'TIME_OF_USE';
    // A 0c TOU band is a free-usage window (e.g. Powershop/Momentum "Solar Sharer" midday).
    const freeFromTou = plan.touRates
      .filter((r) => r.blocks.every((b) => b.perKwh === 0))
      .flatMap((r) => r.windows);
    if (freeFromTou.length) plan.freeWindows = [...(plan.freeWindows ?? []), ...freeFromTou];
  } else if (tp.rateBlockUType === 'demandCharges' && tp.singleRate) {
    // Some demand plans carry the energy rate as singleRate alongside demand.
    plan.singleRate = { blocks: toBlocks(tp.singleRate.rates) };
  }

  // Demand charges (best-effort).
  if (tp.demandCharges?.length) {
    plan.demandCharges = tp.demandCharges
      .map<DemandCharge>((d) => ({
        perKwPerDay: demandPerDay(Number(d.amount ?? 0), d.measurementPeriod),
        windows:
          d.startTime && d.endTime
            ? [
                {
                  dayTypes: daysToDayTypes(d.days ?? []),
                  fromHour: parseHour(d.startTime, false),
                  toHour: parseHour(d.endTime, true),
                },
              ]
            : [{ dayTypes: ['WEEKDAY', 'WEEKEND'], fromHour: 0, toHour: 24 }],
      }))
      .filter((d) => Number.isFinite(d.perKwPerDay) && d.perKwPerDay > 0);
    if (plan.demandCharges.length) plan.pricingModel = 'TIME_OF_USE_DEMAND';
  }

  // Controlled load (use the cheapest single-rate block as the CL rate).
  const cl = c.controlledLoad?.[0];
  if (cl) {
    const rates = cl.singleRate?.rates ?? cl.timeOfUseRates?.[0]?.rates;
    if (rates?.length) {
      const cheapest = Math.min(...rates.map((r) => Number(r.unitPrice)).filter(Number.isFinite));
      if (Number.isFinite(cheapest)) {
        plan.controlledLoad = {
          perKwh: cheapest,
          supplyPerDay: cl.dailySupplyCharge ? Number(cl.dailySupplyCharge) : undefined,
        };
      }
    }
  }

  // Solar feed-in: collect ALL bands from the current scheme. A retailer's TOU FiT is
  // expressed as several entries (e.g. a peak band + a 0c "all other times" band), so we
  // must keep them all — a single rate applied flat would massively over-credit export.
  const fitEntries = c.solarFeedInTariff ?? [];
  if (fitEntries.length) {
    const hasCurrent = fitEntries.some((f) => (f.scheme || '').toUpperCase() === 'CURRENT');
    const targetScheme = hasCurrent ? 'CURRENT' : (fitEntries[0].scheme || '').toUpperCase();
    const selected = fitEntries.filter((f) => (f.scheme || '').toUpperCase() === targetScheme);

    const bands: FeedInBand[] = [];
    for (const f of selected) {
      const batteryOnly = isBatteryEstimateFit(f.description);
      if (f.tariffUType === 'singleTariff' && f.singleTariff?.rates?.length) {
        bands.push({ perKwh: Number(f.singleTariff.rates[0].unitPrice), batteryOnly }); // all-day
      } else if (f.timeVaryingTariffs?.length) {
        for (const t of f.timeVaryingTariffs) {
          bands.push({
            perKwh: Number(t.rates[0]?.unitPrice ?? 0),
            windows: t.timeVariations ? toWindows(t.timeVariations) : undefined,
            batteryOnly,
          });
        }
      }
    }
    if (bands.length) plan.solarFeedIn = bands;
  }

  // Recurring/ongoing fees (e.g. Amber membership). One-off & conditional fees excluded.
  if (c.fees?.length) {
    const annual = c.fees.reduce((s, f) => s + annualiseFee(f), 0);
    if (annual > 0) plan.recurringFeeAnnual = annual;
  }

  // Free-usage windows (e.g. OVO "Free 3") live in incentives/discounts, not the rates.
  // Merge with any 0c-TOU-band windows already detected above (e.g. "Solar Sharer").
  const freeWindows = parseFreeWindows([...(c.incentives ?? []), ...(c.discounts ?? [])]);
  if (freeWindows.length) plan.freeWindows = [...(plan.freeWindows ?? []), ...freeWindows];

  // Eligibility restrictions, GreenPower, and lock-in — for the filter checkboxes.
  if (c.eligibility?.length) {
    const { restrictions, notes } = parseRestrictions(c.eligibility);
    if (restrictions) plan.restrictions = restrictions;
    if (notes.length) plan.eligibilityNotes = notes;
  }
  // Flow Power's requirement lives in the plan NAME (its structured CDR eligibility is inconsistent).
  const nameReq = nameRequirements(raw);
  if (nameReq) {
    plan.restrictions = {
      newCustomerOnly: false, thirdPartyOnly: false, solarRequired: false,
      batteryRequired: false, evRequired: false, seniorCard: false,
      ...plan.restrictions, // keep anything parsed from eligibility[]…
      ...nameReq, //           …then OR in the name-derived requirements (only ever sets true)
    };
  }
  if (c.greenPowerCharges) plan.greenPower = true;
  const hasExitFee = c.fees?.some((f) => /EXIT|TERMIN/i.test(f.type ?? ''));
  if (c.isFixed || hasExitFee) plan.lockIn = true;

  // Amber-style spot plans: replace the flat CDR estimate with a wholesale + network 24×1h TOU.
  if (isVariableWholesale(raw)) applyWholesaleModel(plan);

  // GST last, so it grosses the synthesized wholesale rates too (network + wholesale are ex-GST).
  applyGst(plan);

  return plan;
}
