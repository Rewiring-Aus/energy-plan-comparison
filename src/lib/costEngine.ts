import type {
  BillingPeriod,
  CostResult,
  DayType,
  FeedInBand,
  Plan,
  RateBlock,
  TimeWindow,
  TouLabel,
  UsageBand,
  UsageProfile,
} from '../types';
import { hourInWindow, planHourlyImportRates, resolveFitRate, resolveTouRate } from './time';
import { synthesizeProfile, type SynthInput } from './usageModel';

// Representative annual day mix (Australia ~261 weekdays / 104 weekend days).
const WEEKDAY_DAYS = 261;
const WEEKEND_DAYS = 104;
const TOTAL_DAYS = WEEKDAY_DAYS + WEEKEND_DAYS;

const PERIOD_FRACTION: Record<BillingPeriod, number> = {
  annual: 1,
  quarterly: 1 / 4,
  monthly: 1 / 12,
};

/** Weekday/weekend day counts for a billing period (matches how usage is aggregated + scaled). */
export function billingDays(period: BillingPeriod): { weekday: number; weekend: number } {
  const f = PERIOD_FRACTION[period];
  return { weekday: WEEKDAY_DAYS * f, weekend: WEEKEND_DAYS * f };
}

export interface CostOptions {
  period: BillingPeriod;
}

const TOU_BAND_LABEL: Record<TouLabel, string> = {
  PEAK: 'Peak',
  SHOULDER: 'Shoulder',
  OFFPEAK: 'Off-peak',
};

/** Cost (dollars) to consume `kwh` whose cumulative daily total *starts* at `priorKwh`. */
function chargeBlocks(blocks: RateBlock[], priorKwh: number, kwh: number): number {
  if (kwh <= 0) return 0;
  if (blocks.length === 1 || blocks[0].upToKwhPerDay == null) {
    return kwh * blocks[0].perKwh;
  }
  const sorted = [...blocks].sort(
    (a, b) => (a.upToKwhPerDay ?? Infinity) - (b.upToKwhPerDay ?? Infinity),
  );
  let remaining = kwh;
  let cursor = priorKwh;
  let cost = 0;
  for (const b of sorted) {
    if (remaining <= 0) break;
    const cap = b.upToKwhPerDay ?? Infinity;
    const roomInBlock = cap - cursor;
    if (roomInBlock <= 0) continue;
    const take = Math.min(remaining, roomInBlock);
    cost += take * b.perKwh;
    remaining -= take;
    cursor += take;
  }
  if (remaining > 0) cost += remaining * sorted[sorted.length - 1].perKwh; // safety
  return cost;
}

interface DayResult {
  usageByBand: Record<string, number>; // keyed by TOU label or 'ANYTIME'
  exportCredit: number; // dollars credited for the day (FiT applied per hour)
  importKwh: number;
  peakDemand: number;
}

/** Bill a single representative day given expected hourly grid import + export (both ≥ 0). */
function chargeDay(plan: Plan, importArr: number[], exportArr: number[], dayType: DayType): DayResult {
  const usageByBand: Record<string, number> = {};
  let exportCredit = 0;
  let importKwh = 0;
  let peakDemand = 0;
  const cum: Record<string, number> = {};

  for (let h = 0; h < 24; h++) {
    const imp = Math.max(0, importArr[h] ?? 0);
    const exp = Math.max(0, exportArr[h] ?? 0);

    if (exp > 0 && plan.solarFeedIn?.length) {
      exportCredit += exp * resolveFitRate(plan.solarFeedIn, h, dayType);
    }
    if (imp <= 0) continue;
    importKwh += imp;
    peakDemand = Math.max(peakDemand, imp);

    // Free-usage window (e.g. OVO "Free 3"): imported kWh here is billed at $0.
    if (plan.freeWindows?.some((w) => hourInWindow(h, dayType, w))) {
      usageByBand.FREE = (usageByBand.FREE ?? 0) + 0;
      continue;
    }

    if (plan.touRates?.length) {
      const rate = resolveTouRate(plan.touRates, h, dayType);
      if (rate) {
        // Key by the distinct band (label + index) so different rates that share a coarse
        // label (e.g. CovaU's 7c afternoon shoulder vs 24c overnight shoulder) stay separate.
        const key = `${rate.label}#${plan.touRates.indexOf(rate)}`;
        const prior = cum[key] ?? 0;
        usageByBand[key] = (usageByBand[key] ?? 0) + chargeBlocks(rate.blocks, prior, imp);
        cum[key] = prior + imp;
        continue;
      }
    }
    const blocks = plan.singleRate?.blocks ?? plan.touRates?.[0]?.blocks;
    if (blocks?.length) {
      const prior = cum.single ?? 0;
      usageByBand.ANYTIME = (usageByBand.ANYTIME ?? 0) + chargeBlocks(blocks, prior, imp);
      cum.single = prior + imp;
    }
  }

  // Demand: peak import within any demand window (kW ≈ kWh/hour).
  if (plan.demandCharges?.length) {
    let dPeak = 0;
    for (const dc of plan.demandCharges) {
      for (let h = 0; h < 24; h++) {
        if (dc.windows.some((w) => w.dayTypes.includes(dayType) && h >= Math.floor(w.fromHour) && h < Math.ceil(w.toHour))) {
          dPeak = Math.max(dPeak, Math.max(0, importArr[h] ?? 0));
        }
      }
    }
    peakDemand = dPeak;
  }

  return { usageByBand, exportCredit, importKwh, peakDemand };
}

// ---- Window / band formatting --------------------------------------------------

function fmtHour(h: number): string {
  const hh = Math.floor(h) % 24;
  const mm = Math.round((h - Math.floor(h)) * 60);
  let hr = hh % 12;
  if (hr === 0) hr = 12;
  const ap = hh < 12 ? 'am' : 'pm';
  return mm ? `${hr}:${String(mm).padStart(2, '0')}${ap}` : `${hr}${ap}`;
}

function dayText(dayTypes: DayType[]): string {
  const wd = dayTypes.includes('WEEKDAY');
  const we = dayTypes.includes('WEEKEND');
  if (wd && we) return 'every day';
  if (wd) return 'weekdays';
  if (we) return 'weekends';
  return '';
}

function formatWindows(windows: TimeWindow[]): string {
  const parts = windows
    .filter((w) => !(w.fromHour === 0 && w.toHour === 24))
    .map((w) => `${fmtHour(w.fromHour)}–${fmtHour(w.toHour)} ${dayText(w.dayTypes)}`.trim());
  return [...new Set(parts)].join('; ');
}

/** Human summary of feed-in bands, e.g. "45.0c 5:30pm–7:29pm · 0c otherwise". */
function fitDetail(bands: FeedInBand[]): string {
  const paid = bands.filter((b) => b.perKwh > 0);
  if (!paid.length) return '0c/kWh';
  // Variable wholesale (24 hourly bands): show min–max range instead of listing all hours
  if (bands.length >= 24) {
    const rates = bands.map((b) => b.perKwh * 100).sort((a, b) => a - b);
    const min = rates[0];
    const max = rates[rates.length - 1];
    return min === max ? `${min.toFixed(0)}c/kWh` : `${min.toFixed(0)}–${max.toFixed(0)}c with hourly variation`;
  }
  const txt = paid
    .map((b) => `${(b.perKwh * 100).toFixed(1)}c ${b.windows ? formatWindows(b.windows) : 'all day'}`.trim())
    .join('; ');
  const hasZero = bands.some((b) => b.perKwh <= 0) || paid.some((b) => b.windows);
  return hasZero ? `${txt} · 0c otherwise` : txt;
}

/** The $/kWh a plan charges general usage at a given hour (TOU-aware, else single/flat). */
function rateAtHour(plan: Plan, hour: number, dayType: DayType): number {
  if (plan.touRates?.length) {
    const r = resolveTouRate(plan.touRates, hour, dayType);
    if (r) return r.blocks[0]?.perKwh ?? 0;
  }
  return plan.singleRate?.blocks[0]?.perKwh ?? plan.touRates?.[0]?.blocks[0]?.perKwh ?? 0;
}

export function computeCost(plan: Plan, profile: UsageProfile, opts: CostOptions): CostResult {
  // One representative day, billed under both day types and weighted by the annual day mix — so a
  // plan whose windows differ weekday vs weekend still bills at the correct day-count-weighted rate.
  const wd = chargeDay(plan, profile.import, profile.export, 'WEEKDAY');
  const we = chargeDay(plan, profile.import, profile.export, 'WEEKEND');

  const supply = plan.supplyPerDay * TOTAL_DAYS;
  const fees = plan.recurringFeeAnnual ?? 0;

  const bandKeys = new Set([...Object.keys(wd.usageByBand), ...Object.keys(we.usageByBand)]);
  let usage = 0;
  const annualByBand: Record<string, number> = {};
  for (const k of bandKeys) {
    const v = (wd.usageByBand[k] ?? 0) * WEEKDAY_DAYS + (we.usageByBand[k] ?? 0) * WEEKEND_DAYS;
    annualByBand[k] = v;
    usage += v;
  }

  const solarCredit = -(wd.exportCredit * WEEKDAY_DAYS + we.exportCredit * WEEKEND_DAYS) || 0;

  // Controlled-load hot-water slice (occupant-based, only when the user chose off-peak electric
  // hot water). Plans that *offer* a CL tariff bill it at the cheap CL rate; plans that don't
  // still bill it — at their normal overnight rate — so hot water is never free.
  let controlledLoad = 0;
  let clRate = 0;
  let clLabel = 'Controlled load';
  if (profile.controlledLoadDailyKwh > 0) {
    const clKwh = profile.controlledLoadDailyKwh;
    if (plan.controlledLoad) {
      clRate = plan.controlledLoad.perKwh;
      controlledLoad = clKwh * clRate * TOTAL_DAYS + (plan.controlledLoad.supplyPerDay ?? 0) * TOTAL_DAYS;
    } else {
      clRate = rateAtHour(plan, 2, 'WEEKDAY'); // billed at the plan's overnight rate
      controlledLoad = clKwh * clRate * TOTAL_DAYS;
      clLabel = 'Hot water (overnight)';
    }
  }

  let demand = 0;
  if (plan.demandCharges?.length) {
    for (const dc of plan.demandCharges) {
      demand += Math.max(wd.peakDemand, we.peakDemand) * dc.perKwPerDay * TOTAL_DAYS;
    }
  }

  const f = PERIOD_FRACTION[opts.period];

  // --- Build itemised usage bands (one chip per distinct TOU band) ---
  const usageBands: UsageBand[] = [];
  const touBands = (plan.touRates ?? [])
    .map((rate, i) => ({ rate, key: `${rate.label}#${i}` }))
    .filter((b) => annualByBand[b.key] != null)
    .sort((a, b) => annualByBand[b.key] - annualByBand[a.key]); // dearest first
  if (plan.variableWholesale) {
    // The 24 hourly bands would clutter the breakdown — collapse them into one line.
    const total = touBands.reduce((s, b) => s + (annualByBand[b.key] ?? 0), 0);
    usageBands.push({
      key: 'WHOLESALE',
      label: 'Variable wholesale usage',
      cost: total * f,
      detail: 'varies each hour with the spot price',
    });
  } else {
    for (const { rate, key } of touBands) {
      const c = rate.blocks[0]?.perKwh;
      const windows = formatWindows(rate.windows);
      usageBands.push({
        key,
        label: TOU_BAND_LABEL[rate.label],
        cost: annualByBand[key] * f,
        detail: [c != null ? `${(c * 100).toFixed(1)}c/kWh` : '', windows].filter(Boolean).join(' · '),
      });
    }
  }
  if (annualByBand.FREE != null) {
    usageBands.push({
      key: 'FREE',
      label: 'Free hours',
      cost: 0,
      detail: plan.freeWindows ? `${formatWindows(plan.freeWindows)} · 0c/kWh` : '0c/kWh',
    });
  }
  if (annualByBand.ANYTIME != null) {
    const c = plan.singleRate?.blocks[0]?.perKwh ?? plan.touRates?.[0]?.blocks[0]?.perKwh;
    usageBands.push({
      key: 'ANYTIME',
      label: 'Usage',
      cost: annualByBand.ANYTIME * f,
      detail: c != null ? `${(c * 100).toFixed(1)}c/kWh` : undefined,
    });
  }
  if (controlledLoad > 0) {
    usageBands.push({
      key: 'CONTROLLED_LOAD',
      label: clLabel,
      cost: controlledLoad * f,
      detail: `${(clRate * 100).toFixed(1)}c/kWh`,
    });
  }
  if (demand > 0) {
    usageBands.push({
      key: 'DEMAND',
      label: 'Demand charge',
      cost: demand * f,
      detail: plan.demandCharges?.[0] ? formatWindows(plan.demandCharges[0].windows) : undefined,
    });
  }
  if (solarCredit < 0) {
    usageBands.push({
      key: 'SOLAR',
      label: 'Solar feed-in credit',
      cost: solarCredit * f,
      detail: plan.solarFeedIn ? fitDetail(plan.solarFeedIn) : undefined,
    });
  }

  const fixedAnnual = supply + fees;
  const usageAnnual = usage + controlledLoad + demand + solarCredit;
  const annualTotal = fixedAnnual + usageAnnual;
  const annualImport =
    wd.importKwh * WEEKDAY_DAYS + we.importKwh * WEEKEND_DAYS + profile.controlledLoadDailyKwh * TOTAL_DAYS;

  return {
    planId: plan.id,
    total: annualTotal * f,
    fixedTotal: fixedAnnual * f,
    usageTotal: usageAnnual * f,
    breakdown: {
      supply: supply * f,
      usage: usage * f,
      controlledLoad: controlledLoad * f,
      demand: demand * f,
      fees: fees * f,
      solarCredit: solarCredit * f,
      usageBands,
    },
    effectivePerKwh: annualImport > 0 ? annualTotal / annualImport : 0,
  };
}

/** Compute and rank all plans cheapest-first. */
export function rankPlans(plans: Plan[], profile: UsageProfile, opts: CostOptions): CostResult[] {
  return plans.map((p) => computeCost(p, profile, opts)).sort((a, b) => a.total - b.total);
}

/** Cost one plan against a battery/V2G dispatch optimised to ITS OWN rates. */
export function costPlanOptimised(plan: Plan, base: Omit<SynthInput, 'dispatchRates'>, opts: CostOptions): CostResult {
  const dispatchRates = planHourlyImportRates(plan, 'WEEKDAY');
  const profile = synthesizeProfile({ ...base, dispatchRates }).profile;
  return computeCost(plan, profile, opts);
}

/**
 * Rank plans where each plan is costed against a battery/V2G dispatch optimised to its own rates —
 * the correct comparison when arbitrage is on (each plan gets its best-case schedule, so selecting
 * one plan doesn't distort the others). ~0.02 ms/plan; a full DNSP set (~1200 plans) is ~20 ms.
 */
export function rankPlansOptimised(plans: Plan[], base: Omit<SynthInput, 'dispatchRates'>, opts: CostOptions): CostResult[] {
  return plans.map((p) => costPlanOptimised(p, base, opts)).sort((a, b) => a.total - b.total);
}
