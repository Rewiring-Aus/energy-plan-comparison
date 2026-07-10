import { describe, it, expect } from 'vitest';
import { computeCost, costPlanOptimised, rankPlansOptimised } from '../src/lib/costEngine';
import { resolveTouRate, hourInWindow, planHourlyImportRates } from '../src/lib/time';
import { synthesizeProfile, DEFAULT_BEHAVIOURS } from '../src/lib/usageModel';
import { DEFAULT_HOME } from '../src/data/applianceProfiles';
import type { Plan, UsageProfile, TouRate } from '../src/types';

const DAYS = 365;
const opts = { period: 'annual' as const };

const flat = (v: number) => Array.from({ length: 24 }, () => v);

/** Build a profile from a signed net array (+ import, − export) for test convenience. */
function netProfile(net: number[], controlledLoadDailyKwh = 0): UsageProfile {
  const imp = net.map((n) => Math.max(0, n));
  const exp = net.map((n) => Math.max(0, -n));
  return { import: imp, export: exp, controlledLoadDailyKwh };
}

function base(over: Partial<Plan>): Plan {
  return {
    id: 'p', retailer: 'Test', brand: 't', planName: 'P', planType: 'MARKET',
    fuelType: 'ELECTRICITY', distributors: ['Ausgrid'], supplyPerDay: 0,
    pricingModel: 'SINGLE_RATE', ...over,
  };
}

describe('single-rate plan', () => {
  const plan = base({ supplyPerDay: 1.0, singleRate: { blocks: [{ perKwh: 0.3 }] } });

  it('charges net import × rate + supply over the year', () => {
    const r = computeCost(plan, netProfile(flat(1)), opts); // 24 kWh/day import
    expect(r.breakdown.supply).toBeCloseTo(1.0 * DAYS, 4);
    expect(r.breakdown.usage).toBeCloseTo(24 * 0.3 * DAYS, 4);
    expect(r.total).toBeCloseTo(365 + 24 * 0.3 * 365, 4);
  });

  it('scales to monthly billing period', () => {
    const annual = computeCost(plan, netProfile(flat(1)), opts).total;
    const monthly = computeCost(plan, netProfile(flat(1)), { period: 'monthly' }).total;
    expect(monthly).toBeCloseTo(annual / 12, 6);
  });
});

describe('tiered/block single rate', () => {
  const plan = base({ singleRate: { blocks: [{ perKwh: 0.2, upToKwhPerDay: 10 }, { perKwh: 0.4 }] } });
  it('applies first 10 kWh/day cheap, remainder dearer', () => {
    const r = computeCost(plan, netProfile(flat(1)), opts); // 24 kWh/day
    expect(r.breakdown.usage).toBeCloseTo(7.6 * DAYS, 4); // 10@.2 + 14@.4
  });
});

describe('time-of-use plan', () => {
  const touRates: TouRate[] = [
    { label: 'PEAK', blocks: [{ perKwh: 0.5 }], windows: [{ dayTypes: ['WEEKDAY', 'WEEKEND'], fromHour: 14, toHour: 20 }] },
    { label: 'OFFPEAK', blocks: [{ perKwh: 0.1 }], windows: [{ dayTypes: ['WEEKDAY', 'WEEKEND'], fromHour: 0, toHour: 24 }] },
  ];
  const plan = base({ pricingModel: 'TIME_OF_USE', touRates });

  it('resolves the narrowest matching window', () => {
    expect(resolveTouRate(touRates, 15, 'WEEKDAY')?.label).toBe('PEAK');
    expect(resolveTouRate(touRates, 3, 'WEEKDAY')?.label).toBe('OFFPEAK');
  });

  it('bills peak hours at peak rate, others off-peak', () => {
    const r = computeCost(plan, netProfile(flat(1)), opts);
    expect(r.breakdown.usage).toBeCloseTo((6 * 0.5 + 18 * 0.1) * DAYS, 4);
  });

  it('shifting net import out of peak reduces cost', () => {
    const peaky = flat(0); peaky[16] = 10;
    const shifted = flat(0); shifted[3] = 10;
    const peakCost = computeCost(plan, netProfile(peaky), opts).total;
    const shiftedCost = computeCost(plan, netProfile(shifted), opts).total;
    expect(shiftedCost).toBeLessThan(peakCost);
    expect(peakCost).toBeCloseTo(10 * 0.5 * DAYS, 4);
    expect(shiftedCost).toBeCloseTo(10 * 0.1 * DAYS, 4);
  });

  it('emits a band per TOU label with rate + time detail summing to usageTotal', () => {
    const r = computeCost(plan, netProfile(flat(1)), opts);
    const peak = r.breakdown.usageBands.find((b) => b.key.startsWith('PEAK'))!;
    expect(peak.detail).toContain('2pm–8pm');
    expect(peak.detail).toContain('50.0c/kWh');
    const sum = r.breakdown.usageBands.reduce((a, b) => a + b.cost, 0);
    expect(sum).toBeCloseTo(r.usageTotal, 4);
  });

  it('keeps two bands with the same coarse label separate (CovaU 7c vs 24c shoulder)', () => {
    const plan = base({
      pricingModel: 'TIME_OF_USE',
      touRates: [
        { label: 'PEAK', blocks: [{ perKwh: 0.44 }], windows: [{ dayTypes: ['WEEKDAY', 'WEEKEND'], fromHour: 16, toHour: 21 }] },
        { label: 'SHOULDER', blocks: [{ perKwh: 0.07 }], windows: [{ dayTypes: ['WEEKDAY', 'WEEKEND'], fromHour: 14, toHour: 16 }] },
        { label: 'SHOULDER', blocks: [{ perKwh: 0.24 }], windows: [{ dayTypes: ['WEEKDAY', 'WEEKEND'], fromHour: 21, toHour: 14 }] },
      ],
    });
    const r = computeCost(plan, netProfile(flat(1)), opts);
    const shoulders = r.breakdown.usageBands.filter((b) => b.key.startsWith('SHOULDER'));
    expect(shoulders).toHaveLength(2);
    expect(shoulders.some((b) => b.detail?.includes('7.0c/kWh'))).toBe(true);
    expect(shoulders.some((b) => b.detail?.includes('24.0c/kWh'))).toBe(true);
  });
});

describe('solar feed-in (export in the net line)', () => {
  const plan = base({ singleRate: { blocks: [{ perKwh: 0.3 }] }, solarFeedIn: [{ perKwh: 0.05 }] });

  it('credits net export and bills only net import', () => {
    // net = −2 every hour (export 2 kWh/h), never importing
    const r = computeCost(plan, netProfile(flat(-2)), opts);
    expect(r.breakdown.usage).toBe(0);
    expect(r.breakdown.solarCredit).toBeCloseTo(-(2 * 24 * DAYS) * 0.05, 4);
  });
});

describe('battery-arbitrage estimate FiT (Amber 21c)', () => {
  const plan = base({ singleRate: { blocks: [{ perKwh: 0.3 }] }, solarFeedIn: [{ perKwh: 0.21, batteryOnly: true }] });
  it('does not credit direct solar export at the battery-only estimate rate', () => {
    const r = computeCost(plan, netProfile(flat(-2)), opts); // export 2 kWh/h
    expect(r.breakdown.solarCredit).toBe(0);
  });
  it('a normal (no-battery) estimate FiT still credits solar export', () => {
    const ok = base({ singleRate: { blocks: [{ perKwh: 0.3 }] }, solarFeedIn: [{ perKwh: 0.0331 }] });
    const r = computeCost(ok, netProfile(flat(-2)), opts);
    expect(r.breakdown.solarCredit).toBeCloseTo(-(2 * 24 * DAYS) * 0.0331, 4);
  });
});

describe('time-of-use feed-in (Flow Power 45c peak window only)', () => {
  const plan = base({
    singleRate: { blocks: [{ perKwh: 0.3 }] },
    solarFeedIn: [
      { perKwh: 0.45, windows: [{ dayTypes: ['WEEKDAY', 'WEEKEND'], fromHour: 17, toHour: 19 }] },
      { perKwh: 0, windows: [{ dayTypes: ['WEEKDAY', 'WEEKEND'], fromHour: 19, toHour: 17 }] },
    ],
  });

  it('credits only export inside the 45c window, not midday', () => {
    const net = flat(0); net[12] = -4; net[18] = -4; // export midday + 6pm
    const r = computeCost(plan, netProfile(net), opts);
    expect(r.breakdown.solarCredit).toBeCloseTo(-(4 * 0.45) * DAYS, 4); // only 6pm earns
  });
});

describe('free-usage window (OVO "Free 3")', () => {
  const plan = base({
    pricingModel: 'TIME_OF_USE',
    touRates: [
      { label: 'OFFPEAK', blocks: [{ perKwh: 0.35 }], windows: [{ dayTypes: ['WEEKDAY', 'WEEKEND'], fromHour: 0, toHour: 24 }] },
    ],
    freeWindows: [{ dayTypes: ['WEEKDAY', 'WEEKEND'], fromHour: 11, toHour: 14 }],
  });

  it('bills import inside the free window at $0', () => {
    const inFree = flat(0); inFree[12] = 5; // 5 kWh at noon (free)
    const outFree = flat(0); outFree[20] = 5; // 5 kWh at 8pm (off-peak)
    expect(computeCost(plan, netProfile(inFree), opts).breakdown.usage).toBeCloseTo(0, 6);
    expect(computeCost(plan, netProfile(outFree), opts).breakdown.usage).toBeCloseTo(5 * 0.35 * DAYS, 4);
  });

  it('exposes a Free hours band', () => {
    const p = flat(0); p[12] = 5;
    const r = computeCost(plan, netProfile(p), opts);
    expect(r.breakdown.usageBands.find((b) => b.key === 'FREE')?.detail).toContain('11am–2pm');
  });
});

describe('controlled load', () => {
  const clPlan = base({ singleRate: { blocks: [{ perKwh: 0.3 }] }, controlledLoad: { perKwh: 0.15, supplyPerDay: 0.05 } });

  it('bills the CL slice on the CL rate plus CL supply when the plan offers one', () => {
    const r = computeCost(clPlan, netProfile(flat(0), 8), opts);
    expect(r.breakdown.controlledLoad).toBeCloseTo((8 * 0.15 + 0.05) * DAYS, 4);
  });

  it('bills the hot-water slice at the overnight rate (never free) when the plan has no CL tariff', () => {
    // single-rate plan without a CL tariff: 8 kWh/day billed at the flat 30c
    const flatPlan = base({ singleRate: { blocks: [{ perKwh: 0.3 }] } });
    const r = computeCost(flatPlan, netProfile(flat(0), 8), opts);
    expect(r.breakdown.controlledLoad).toBeCloseTo(8 * 0.3 * DAYS, 4);
    expect(r.breakdown.usageBands.find((b) => b.key === 'CONTROLLED_LOAD')?.label).toBe('Hot water (overnight)');
  });

  it('a CL tariff is cheaper than no CL tariff for the same hot-water slice', () => {
    const flatPlan = base({ singleRate: { blocks: [{ perKwh: 0.3 }] } });
    const withCl = computeCost(clPlan, netProfile(flat(0), 8), opts).breakdown.controlledLoad;
    const withoutCl = computeCost(flatPlan, netProfile(flat(0), 8), opts).breakdown.controlledLoad;
    expect(withCl).toBeLessThan(withoutCl);
  });
});

describe('demand charge (best-effort)', () => {
  const plan = base({
    pricingModel: 'TIME_OF_USE_DEMAND', singleRate: { blocks: [{ perKwh: 0.2 }] },
    demandCharges: [{ perKwPerDay: 0.1, windows: [{ dayTypes: ['WEEKDAY'], fromHour: 14, toHour: 20 }] }],
  });
  it('charges peak net import within the demand window', () => {
    const net = flat(0); net[16] = 5; net[2] = 9; // 9 outside window ignored
    const r = computeCost(plan, netProfile(net), opts);
    expect(r.breakdown.demand).toBeCloseTo(5 * 0.1 * DAYS, 4);
  });
});

describe('recurring fees + fixed/usage split', () => {
  const plan = base({ supplyPerDay: 1.0, singleRate: { blocks: [{ perKwh: 0.3 }] }, recurringFeeAnnual: 120, solarFeedIn: [{ perKwh: 0.05 }] });

  it('adds the annual fee and splits fixed vs usage', () => {
    const r = computeCost(plan, netProfile(flat(1)), opts);
    expect(r.breakdown.fees).toBeCloseTo(120, 6);
    expect(r.fixedTotal).toBeCloseTo(1.0 * DAYS + 120, 4);
    expect(r.usageTotal).toBeCloseTo(r.breakdown.usage + r.breakdown.solarCredit, 6);
    expect(r.fixedTotal + r.usageTotal).toBeCloseTo(r.total, 6);
  });

  it('scales the fee to the monthly period', () => {
    const r = computeCost(plan, netProfile(flat(0)), { period: 'monthly' });
    expect(r.breakdown.fees).toBeCloseTo(10, 6);
  });
});

describe('hourInWindow edge cases', () => {
  it('treats toHour as exclusive and handles midnight wrap', () => {
    expect(hourInWindow(20, 'WEEKDAY', { dayTypes: ['WEEKDAY'], fromHour: 14, toHour: 20 })).toBe(false);
    expect(hourInWindow(19, 'WEEKDAY', { dayTypes: ['WEEKDAY'], fromHour: 14, toHour: 20 })).toBe(true);
    expect(hourInWindow(23, 'WEEKDAY', { dayTypes: ['WEEKDAY'], fromHour: 22, toHour: 6 })).toBe(true);
    expect(hourInWindow(3, 'WEEKDAY', { dayTypes: ['WEEKDAY'], fromHour: 22, toHour: 6 })).toBe(true);
    expect(hourInWindow(10, 'WEEKDAY', { dayTypes: ['WEEKDAY'], fromHour: 22, toHour: 6 })).toBe(false);
  });
});

describe('per-plan battery/V2G optimisation', () => {
  // Two TOU plans with the same peak but opposite cheap windows.
  const touPlan = (id: string, cheapFrom: number, cheapTo: number, cheapRate: number): Plan =>
    base({
      id,
      pricingModel: 'TIME_OF_USE',
      touRates: [
        { label: 'SHOULDER', blocks: [{ perKwh: 0.3 }], windows: [{ dayTypes: ['WEEKDAY', 'WEEKEND'], fromHour: 0, toHour: 24 }] },
        { label: 'OFFPEAK', blocks: [{ perKwh: cheapRate }], windows: [{ dayTypes: ['WEEKDAY', 'WEEKEND'], fromHour: cheapFrom, toHour: cheapTo }] },
        { label: 'PEAK', blocks: [{ perKwh: 0.6 }], windows: [{ dayTypes: ['WEEKDAY', 'WEEKEND'], fromHour: 17, toHour: 20 }] },
      ],
    });
  const midday = touPlan('midday', 10, 14, 0.0); // free solar-soak window
  const overnight = touPlan('overnight', 1, 6, 0.05); // traditional off-peak

  const synthBase = {
    home: { ...DEFAULT_HOME, solarKw: 6.6, evCount: 1, evKmPerWeek: 200 },
    includeSolar: true,
    effectiveness: 'realistic' as const,
    behaviours: { ...DEFAULT_BEHAVIOURS, v2g: true, v2gKwh: 30 },
    state: 'NSW' as const,
  };

  const costUnder = (plan: Plan, dispatchPlan: Plan) =>
    computeCost(plan, synthesizeProfile({ ...synthBase, dispatchRates: planHourlyImportRates(dispatchPlan, 'WEEKDAY') }).profile, opts).total;

  it('ranks each plan against its OWN optimal dispatch (never worse than a rival plan’s schedule)', () => {
    const ranked = rankPlansOptimised([midday, overnight], synthBase, opts);
    expect(ranked).toHaveLength(2);
    expect(ranked[0].total).toBeLessThanOrEqual(ranked[1].total); // sorted cheapest-first

    // Each plan optimised to its own rates costs ≤ the same plan under the rival's dispatch.
    expect(costPlanOptimised(midday, synthBase, opts).total).toBeLessThanOrEqual(costUnder(midday, overnight) + 1e-6);
    expect(costPlanOptimised(overnight, synthBase, opts).total).toBeLessThanOrEqual(costUnder(overnight, midday) + 1e-6);
  });
});

describe('weekday/weekend day-count weighting (single representative day)', () => {
  it('bills a weekday-only-peak plan at the day-count-weighted average', () => {
    const plan = base({
      pricingModel: 'TIME_OF_USE',
      touRates: [
        { label: 'PEAK', blocks: [{ perKwh: 0.5 }], windows: [{ dayTypes: ['WEEKDAY'], fromHour: 0, toHour: 24 }] },
        { label: 'OFFPEAK', blocks: [{ perKwh: 0.1 }], windows: [{ dayTypes: ['WEEKEND'], fromHour: 0, toHour: 24 }] },
      ],
    });
    // 24 kWh/day billed peak on the 261 weekdays and off-peak on the 104 weekend days.
    const r = computeCost(plan, netProfile(flat(1)), opts);
    expect(r.breakdown.usage).toBeCloseTo(24 * 0.5 * 261 + 24 * 0.1 * 104, 4);
  });
});
