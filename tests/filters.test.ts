import { describe, it, expect } from 'vitest';
import { passesFilters } from '../src/lib/plans';
import type { PlanFilters } from '../src/store/usageStore';
import type { Plan } from '../src/types';

const BASE_FILTERS: PlanFilters = {
  hideIneligible: true,
  hasSeniorCard: false,
  isNewCustomer: false,
  allowPartnerOffers: false,
  tariffTypes: [],
  greenPowerOnly: false,
  noLockIn: false,
  excludeDemand: false,
};

function plan(over: Partial<Plan>): Plan {
  return {
    id: 'p', retailer: 'R', brand: 'r', planName: 'P', planType: 'MARKET', fuelType: 'ELECTRICITY',
    distributors: ['Ausgrid'], supplyPerDay: 1, pricingModel: 'SINGLE_RATE',
    singleRate: { blocks: [{ perKwh: 0.3 }] }, ...over,
  };
}
const noSolar = { solarKw: 0, batteryKwh: 0 };

describe('passesFilters', () => {
  it('hides partner-only and new-customer-only offers by default', () => {
    expect(passesFilters(plan({ restrictions: rest({ thirdPartyOnly: true }) }), BASE_FILTERS, noSolar)).toBe(false);
    expect(passesFilters(plan({ restrictions: rest({ newCustomerOnly: true }) }), BASE_FILTERS, noSolar)).toBe(false);
  });

  it('unlocks them when the user opts in', () => {
    expect(
      passesFilters(plan({ restrictions: rest({ thirdPartyOnly: true }) }), { ...BASE_FILTERS, allowPartnerOffers: true }, noSolar),
    ).toBe(true);
    expect(
      passesFilters(plan({ restrictions: rest({ newCustomerOnly: true }) }), { ...BASE_FILTERS, isNewCustomer: true }, noSolar),
    ).toBe(true);
  });

  it('hides solar/battery-required plans unless the home has them', () => {
    const p = plan({ restrictions: rest({ solarRequired: true }) });
    expect(passesFilters(p, BASE_FILTERS, noSolar)).toBe(false);
    expect(passesFilters(p, BASE_FILTERS, { solarKw: 6.6, batteryKwh: 0 })).toBe(true);
  });

  it('hides seniors plans unless the user has a card', () => {
    const p = plan({ restrictions: rest({ seniorCard: true }) });
    expect(passesFilters(p, BASE_FILTERS, noSolar)).toBe(false);
    expect(passesFilters(p, { ...BASE_FILTERS, hasSeniorCard: true }, noSolar)).toBe(true);
  });

  it('respects tariff-type, greenpower and no-lock-in filters', () => {
    expect(passesFilters(plan({ pricingModel: 'SINGLE_RATE' }), { ...BASE_FILTERS, tariffTypes: ['TIME_OF_USE'] }, noSolar)).toBe(false);
    expect(passesFilters(plan({ greenPower: false }), { ...BASE_FILTERS, greenPowerOnly: true }, noSolar)).toBe(false);
    expect(passesFilters(plan({ lockIn: true }), { ...BASE_FILTERS, noLockIn: true }, noSolar)).toBe(false);
  });

  it('turning off hideIneligible shows restricted plans', () => {
    const p = plan({ restrictions: rest({ thirdPartyOnly: true }) });
    expect(passesFilters(p, { ...BASE_FILTERS, hideIneligible: false }, noSolar)).toBe(true);
  });

  it('treats variable-wholesale as its own tariff kind', () => {
    const variable = plan({ pricingModel: 'TIME_OF_USE', variableWholesale: true });
    expect(passesFilters(variable, { ...BASE_FILTERS, tariffTypes: ['VARIABLE'] }, noSolar)).toBe(true);
    expect(passesFilters(variable, { ...BASE_FILTERS, tariffTypes: ['TIME_OF_USE'] }, noSolar)).toBe(false);
    // A plain TOU plan is NOT variable.
    expect(passesFilters(plan({ pricingModel: 'TIME_OF_USE' }), { ...BASE_FILTERS, tariffTypes: ['VARIABLE'] }, noSolar)).toBe(false);
  });

  it('excludeDemand drops demand plans (which still count as time-of-use for the tariff chips)', () => {
    const demand = plan({ pricingModel: 'TIME_OF_USE_DEMAND' });
    expect(passesFilters(demand, { ...BASE_FILTERS, excludeDemand: true }, noSolar)).toBe(false);
    expect(passesFilters(demand, { ...BASE_FILTERS, excludeDemand: false }, noSolar)).toBe(true);
    expect(passesFilters(demand, { ...BASE_FILTERS, tariffTypes: ['TIME_OF_USE'] }, noSolar)).toBe(true);
  });
});

function rest(over: Partial<NonNullable<Plan['restrictions']>>): Plan['restrictions'] {
  return { newCustomerOnly: false, thirdPartyOnly: false, solarRequired: false, batteryRequired: false, seniorCard: false, ...over };
}
