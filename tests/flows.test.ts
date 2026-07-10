import { describe, it, expect } from 'vitest';
import { hourlyFlows, type FlowOptions } from '../src/lib/flows';

const zeros = Array.from({ length: 24 }, () => 0);
const sum = (a: number[], hrs: number[]) => hrs.reduce((s, h) => s + a[h], 0);

// A plan whose cheapest hours are overnight (2–5) and dearest is the 7pm peak — the opposite of
// the default midday soak window, so we can tell whether dispatch actually follows the plan.
const overnightCheap = Array.from({ length: 24 }, (_, h) => (h === 19 ? 0.6 : h >= 2 && h <= 5 ? 0.05 : 0.3));
// Evening consumption spike so the battery must discharge into the peak and recharge each day.
const eveningLoad = zeros.map((_, h) => (h === 19 ? 10 : 0));

const opts = (extra: Partial<FlowOptions>): FlowOptions => ({
  effectiveness: 'realistic',
  batteryKwh: 30,
  batteryGridCharge: true,
  ...extra,
});

describe('plan-aware battery/V2G dispatch', () => {
  it('grid-charges in the selected plan’s cheapest hours, not the default midday window', () => {
    const flows = hourlyFlows(eveningLoad, zeros, false, opts({ dispatchRates: overnightCheap, powerLimitKwh: 7 }));
    const imp = flows.map((f) => f.import);
    // Charging lands in the overnight cheap window...
    expect(sum(imp, [0, 1, 2, 3, 4, 5])).toBeGreaterThan(5);
    // ...and not in the default midday soak hours, which this plan prices normally.
    expect(sum(imp, [10, 11, 12, 13, 14])).toBeCloseTo(0, 6);
  });

  it('caps charge at the 7 kW power limit (vs uncapped C/2)', () => {
    const capped = hourlyFlows(eveningLoad, zeros, false, opts({ dispatchRates: overnightCheap, powerLimitKwh: 7 }));
    const uncapped = hourlyFlows(eveningLoad, zeros, false, opts({ dispatchRates: overnightCheap }));
    const cheap = [2, 3, 4, 5];
    const maxCapped = Math.max(...cheap.map((h) => capped[h].import));
    const maxUncapped = Math.max(...cheap.map((h) => uncapped[h].import));
    expect(maxCapped).toBeLessThanOrEqual(7 + 1e-9);
    expect(maxUncapped).toBeGreaterThan(7); // C/2 = 15 kW/h fills faster than the 7 kW charger
  });

  it('does no grid arbitrage on a flat-rate plan (no cheap hours to exploit)', () => {
    const flat = Array.from({ length: 24 }, () => 0.28);
    const flows = hourlyFlows(eveningLoad, zeros, false, opts({ dispatchRates: flat, powerLimitKwh: 7 }));
    // Total import equals the raw load — nothing charged/arbitraged (round-trip loss can't be beaten).
    expect(sum(flows.map((f) => f.import), Array.from({ length: 24 }, (_, h) => h))).toBeCloseTo(10, 6);
  });
});
