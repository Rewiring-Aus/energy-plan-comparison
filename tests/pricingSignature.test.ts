import { describe, it, expect } from 'vitest';
import { pricingSignature } from '../src/lib/plans';
import type { Plan } from '../src/types';

function plan(over: Partial<Plan>): Plan {
  return {
    id: 'p', retailer: 'R', brand: 'r', planName: 'P', planType: 'MARKET', fuelType: 'ELECTRICITY',
    distributors: ['Ausgrid'], supplyPerDay: 1, pricingModel: 'SINGLE_RATE',
    singleRate: { blocks: [{ perKwh: 0.3 }] }, ...over,
  };
}

describe('pricingSignature', () => {
  it('is identical for same-priced plans regardless of name/id (they collapse into one offer)', () => {
    const a = plan({ id: 'a', planName: 'Everyday Saver' });
    const b = plan({ id: 'b', planName: 'Basic Home' });
    expect(pricingSignature(a)).toBe(pricingSignature(b));
  });

  it('differs when any billable field differs (distinct offers stay separate)', () => {
    const base = plan({});
    expect(pricingSignature(plan({ singleRate: { blocks: [{ perKwh: 0.31 }] } }))).not.toBe(pricingSignature(base));
    expect(pricingSignature(plan({ supplyPerDay: 1.05 }))).not.toBe(pricingSignature(base));
    expect(pricingSignature(plan({ recurringFeeAnnual: 300 }))).not.toBe(pricingSignature(base));
  });

  it('keeps different retailers separate even with identical rates (not variants of each other)', () => {
    const x = plan({ retailer: 'Retailer X' });
    const y = plan({ retailer: 'Retailer Y' });
    expect(pricingSignature(x)).not.toBe(pricingSignature(y));
  });

  it('ignores sub-0.0001c float noise in rates', () => {
    const a = plan({ singleRate: { blocks: [{ perKwh: 0.30001 }] } });
    const b = plan({ singleRate: { blocks: [{ perKwh: 0.300012 }] } });
    expect(pricingSignature(a)).toBe(pricingSignature(b));
  });
});
