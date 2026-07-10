import { describe, it, expect } from 'vitest';
import { normalizePlan, type RawPlanDetail } from '../src/lib/normalizePlan';
import { rankPlans } from '../src/lib/costEngine';
import type { Plan, UsageProfile } from '../src/types';
import snapshot from '../src/data/plans.json';

// A representative CDR TOU plan detail (shape matches the real Get Generic Plan Detail).
const rawTou: RawPlanDetail = {
  planId: 'ABC123@VEC',
  displayName: 'Test Saver',
  type: 'MARKET',
  brand: 'agl',
  brandName: 'AGL',
  fuelType: 'ELECTRICITY',
  geography: { distributors: ['Ausgrid'] },
  electricityContract: {
    pricingModel: 'TIME_OF_USE',
    tariffPeriod: [
      {
        rateBlockUType: 'timeOfUseRates',
        dailySupplyCharge: '0.8894',
        timeOfUseRates: [
          {
            type: 'PEAK',
            rates: [{ unitPrice: '0.293' }],
            timeOfUse: [
              { days: ['MON', 'TUE', 'WED', 'THU', 'FRI'], startTime: '15:00', endTime: '21:00' },
            ],
          },
          {
            type: 'OFF_PEAK',
            rates: [{ unitPrice: '0.1755' }],
            timeOfUse: [{ days: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'], startTime: '21:00', endTime: '00:00' }],
          },
        ],
      },
    ],
    controlledLoad: [
      { rateBlockUType: 'singleRate', dailySupplyCharge: '0.05', singleRate: { rates: [{ unitPrice: '0.12' }] } },
    ],
    solarFeedInTariff: [
      { scheme: 'CURRENT', tariffUType: 'singleTariff', singleTariff: { rates: [{ unitPrice: '0.05' }] } },
    ],
  },
};

describe('normalizePlan', () => {
  it('maps a TOU plan to our schema', () => {
    const p = normalizePlan(rawTou)!;
    expect(p.pricingModel).toBe('TIME_OF_USE');
    expect(p.supplyPerDay).toBeCloseTo(0.8894 * 1.1, 4); // ×1.1 GST
    expect(p.retailer).toBe('AGL');
    expect(p.touRates).toHaveLength(2);
    const peak = p.touRates!.find((r) => r.label === 'PEAK')!;
    expect(peak.blocks[0].perKwh).toBeCloseTo(0.293 * 1.1, 4);
    expect(peak.windows[0]).toMatchObject({ dayTypes: ['WEEKDAY'], fromHour: 15, toHour: 21 });
    const off = p.touRates!.find((r) => r.label === 'OFFPEAK')!;
    expect(off.windows[0].toHour).toBe(24); // 00:00 end -> midnight
    expect(p.controlledLoad!.perKwh).toBeCloseTo(0.12 * 1.1, 4);
    expect(p.controlledLoad!.supplyPerDay).toBeCloseTo(0.05 * 1.1, 4);
    expect(p.solarFeedIn?.[0].perKwh).toBeCloseTo(0.05, 4); // FiT is GST-free — unchanged
  });

  it('flags a battery-arbitrage estimate FiT but not a "without battery" estimate', () => {
    const mk = (desc: string): RawPlanDetail => ({
      planId: 'A',
      brandName: 'Amber',
      electricityContract: {
        pricingModel: 'SINGLE_RATE',
        tariffPeriod: [{ rateBlockUType: 'singleRate', singleRate: { rates: [{ unitPrice: '0.3' }] } }],
        solarFeedInTariff: [
          { scheme: 'OTHER', description: desc, tariffUType: 'singleTariff', singleTariff: { rates: [{ unitPrice: '0.21' }] } },
        ],
      },
    });
    const battery = normalizePlan(mk('12 month average estimate, typical solar (8kW) and battery (13kWh) setup'))!;
    const noBattery = normalizePlan(mk('12 month average estimate, typical solar (5kW) without battery'))!;
    expect(battery.solarFeedIn?.[0].batteryOnly).toBe(true);
    expect(noBattery.solarFeedIn?.[0].batteryOnly).toBeFalsy();
  });

  it('treats a 0c TOU band as a free window (Solar Sharer midday)', () => {
    const raw: RawPlanDetail = {
      planId: 'SS1',
      brandName: 'Powershop',
      electricityContract: {
        pricingModel: 'TIME_OF_USE',
        tariffPeriod: [
          {
            rateBlockUType: 'timeOfUseRates',
            timeOfUseRates: [
              { type: 'PEAK', rates: [{ unitPrice: '0.53' }], timeOfUse: [{ days: ['MON'], startTime: '16:00', endTime: '23:59' }] },
              { type: 'SHOULDER2', rates: [{ unitPrice: '0.00' }], timeOfUse: [{ days: ['MON'], startTime: '12:00', endTime: '15:00' }] },
            ],
          },
        ],
      },
    };
    const p = normalizePlan(raw)!;
    expect(p.freeWindows?.[0]).toMatchObject({ fromHour: 12, toHour: 15 });
  });

  it('captures all bands of a time-varying (TOU) feed-in tariff', () => {
    const raw: RawPlanDetail = {
      planId: 'FLOW1',
      brandName: 'Test Energy', // not a wholesale retailer — exercises the generic TOU-FiT parser
      geography: { distributors: ['Ausgrid'] },
      electricityContract: {
        pricingModel: 'SINGLE_RATE',
        tariffPeriod: [{ rateBlockUType: 'singleRate', singleRate: { rates: [{ unitPrice: '0.25' }] } }],
        solarFeedInTariff: [
          {
            scheme: 'OTHER',
            tariffUType: 'timeVaryingTariffs',
            timeVaryingTariffs: [
              { rates: [{ unitPrice: '0.45' }], timeVariations: [{ days: ['MON', 'SAT'], startTime: '17:30', endTime: '19:29' }] },
            ],
          },
          {
            scheme: 'OTHER',
            tariffUType: 'timeVaryingTariffs',
            timeVaryingTariffs: [
              { rates: [{ unitPrice: '0.00' }], timeVariations: [{ days: ['MON', 'SAT'], startTime: '19:30', endTime: '17:29' }] },
            ],
          },
        ],
      },
    };
    const p = normalizePlan(raw)!;
    expect(p.solarFeedIn).toHaveLength(2); // both the 45c peak band AND the 0c band
    const paid = p.solarFeedIn!.find((b) => b.perKwh > 0)!;
    expect(paid.perKwh).toBeCloseTo(0.45, 4);
    expect(paid.windows?.[0]).toMatchObject({ fromHour: 17.5 });
  });

  it('parses eligibility[] into restriction flags (and ignores negated/incidental mentions)', () => {
    const mk = (eligibility: { type?: string; information?: string; description?: string }[]): RawPlanDetail => ({
      planId: 'E',
      brandName: 'AGL',
      electricityContract: {
        pricingModel: 'SINGLE_RATE',
        tariffPeriod: [{ rateBlockUType: 'singleRate', singleRate: { rates: [{ unitPrice: '0.3' }] } }],
        eligibility,
      },
    });
    const partner = normalizePlan(mk([{ type: 'THIRD_PARTY_ONLY', information: 'BP Rewards Member' }]))!;
    expect(partner.restrictions?.thirdPartyOnly).toBe(true);

    // Structured membership enum values map to thirdPartyOnly even with no recognisable free text.
    for (const type of ['ORG_MEMBER', 'LOYALTY_MEMBER', 'SPORT_CLUB_MEMBER']) {
      const m = normalizePlan(mk([{ type, information: 'Eligible members' }]))!;
      expect(m.restrictions?.thirdPartyOnly, `${type} → thirdPartyOnly`).toBe(true);
    }

    const newCust = normalizePlan(mk([{ type: 'OTHER', information: 'New and Moving Customers Only' }]))!;
    expect(newCust.restrictions?.newCustomerOnly).toBe(true);

    const senior = normalizePlan(mk([{ type: 'SENIOR_CARD', information: 'Seniors Card holders' }]))!;
    expect(senior.restrictions?.seniorCard).toBe(true);

    const solar = normalizePlan(mk([{ type: 'OTHER', information: 'Solar System', description: 'must have a solar system installed' }]))!;
    expect(solar.restrictions?.solarRequired).toBe(true);

    // "Non-Solar Eligibility" must NOT be flagged as solar-required.
    const nonSolar = normalizePlan(mk([{ type: 'OTHER', information: 'Non-Solar Eligibility', description: 'for customers without solar' }]))!;
    expect(nonSolar.restrictions?.solarRequired).toBeFalsy();

    // Amber's EXISTING_SOLAR is a price-estimate ASSUMPTION, not a gate — must NOT flag.
    const amberEstimate = normalizePlan(mk([{ type: 'EXISTING_SOLAR', description: 'Usage price estimate based on a typical household solar system of 5kW.' }]))!;
    expect(amberEstimate.restrictions?.solarRequired).toBeFalsy();

    // Flow Power packs a genuine gate AND an estimate caveat into one block. The gate sentence
    // must set solar+battery+EV; the trailing estimate sentence must not suppress it.
    const flow = normalizePlan(mk([{ information:
      'Offer only available to customers with solar panels, battery, EV and smart meter. ' +
      'Usage price estimate based on a typical household solar system of 5kW, battery system of 12.5kWh and an EV.' }]))!;
    expect(flow.restrictions?.solarRequired).toBe(true);
    expect(flow.restrictions?.batteryRequired).toBe(true);
    expect(flow.restrictions?.evRequired).toBe(true);

    // Amber's "No Solar or Battery" estimate caveat is the OPPOSITE of a requirement — the phrase
    // "households without a solar or battery system" must not be read as solar/battery-required.
    const amberNoSolar = normalizePlan(mk([{ information: 'No Solar or Battery', description: 'The pricing estimate is for households without a solar or battery system.' }]))!;
    expect(amberNoSolar.restrictions?.solarRequired).toBeFalsy();
    expect(amberNoSolar.restrictions?.batteryRequired).toBeFalsy();

    // "solar feed-in tariff eligibility" is an incidental FiT mention, NOT a requirement to own panels.
    const fitMention = normalizePlan(mk([{ information: 'Distribution zone', description: 'Applicable to a Residential Customer who agrees to eBilling. See terms for other eligibility criteria, including solar feed-in tariff eligibility.' }]))!;
    expect(fitMention.restrictions?.solarRequired).toBeFalsy();
  });

  it('blends seasonal tariffPeriods by day-coverage (1st Opal peak)', () => {
    const peak = (price: string, start: string, end: string) => ({
      rateBlockUType: 'timeOfUseRates' as const,
      startDate: start,
      endDate: end,
      timeOfUseRates: [
        { type: 'PEAK', rates: [{ unitPrice: price }], timeOfUse: [{ days: ['MON'], startTime: '15:00', endTime: '20:59' }] },
      ],
    });
    const raw: RawPlanDetail = {
      planId: 'OPAL',
      brandName: '1st Energy',
      electricityContract: {
        pricingModel: 'TIME_OF_USE',
        tariffPeriod: [
          peak('0.174', '04-01', '05-31'), // 61 d
          peak('0.437', '06-01', '08-31'), // 92 d
          peak('0.174', '09-01', '10-31'), // 61 d
          peak('0.437', '11-01', '03-31'), // 151 d
        ],
      },
    };
    const p = normalizePlan(raw)!;
    const peakRate = p.touRates!.find((r) => r.label === 'PEAK')!.blocks[0].perKwh;
    // day-weighted (0.174*122 + 0.437*243)/365 ≈ 0.349, then ×1.1 GST ≈ 0.384
    expect(peakRate).toBeGreaterThan(0.36);
    expect(peakRate).toBeLessThan(0.41);
  });

  it('returns null when there is no electricity contract', () => {
    expect(normalizePlan({ planId: 'x' } as RawPlanDetail)).toBeNull();
  });

  it('annualises recurring fees and excludes one-off / conditional ones', () => {
    const raw: RawPlanDetail = {
      planId: 'AMBER1',
      type: 'MARKET',
      brandName: 'Amber',
      geography: { distributors: ['Ausgrid'] },
      electricityContract: {
        pricingModel: 'SINGLE_RATE',
        tariffPeriod: [
          { rateBlockUType: 'singleRate', dailySupplyCharge: '0.9', singleRate: { rates: [{ unitPrice: '0.08' }] } },
        ],
        fees: [
          { term: 'ANNUAL', type: 'MEMBERSHIP', amount: '300.00' },
          { term: '1_TIME', type: 'CONNECTION', amount: '16.50' },
          { term: 'PERCENT_OF_BILL', type: 'CC_PROCESSING', rate: '0.01' },
          { term: 'FIXED', type: 'LATE_PAYMENT', amount: '16.00' },
        ],
      },
    };
    const p = normalizePlan(raw)!;
    expect(p.recurringFeeAnnual).toBeCloseTo(300 * 1.1, 6); // only the ANNUAL membership, ×1.1 GST
  });

  it('parses a free-usage window from incentives (OVO "Free 3")', () => {
    const raw: RawPlanDetail = {
      planId: 'OVO1',
      brandName: 'OVO Energy',
      electricityContract: {
        pricingModel: 'TIME_OF_USE',
        tariffPeriod: [{ rateBlockUType: 'singleRate', singleRate: { rates: [{ unitPrice: '0.3' }] } }],
        incentives: [{ displayName: 'Free 3', description: 'Free electricity between 11am and 2pm everyday.' }],
      },
    };
    const p = normalizePlan(raw)!;
    expect(p.freeWindows).toEqual([{ dayTypes: ['WEEKDAY', 'WEEKEND'], fromHour: 11, toHour: 14 }]);
  });

  it('annualises a monthly fee correctly', () => {
    const raw: RawPlanDetail = {
      planId: 'M1',
      brandName: 'X',
      electricityContract: {
        pricingModel: 'SINGLE_RATE',
        tariffPeriod: [{ rateBlockUType: 'singleRate', singleRate: { rates: [{ unitPrice: '0.3' }] } }],
        fees: [{ term: 'MONTHLY', type: 'MEMBERSHIP', amount: '10' }],
      },
    };
    expect(normalizePlan(raw)!.recurringFeeAnnual).toBeCloseTo(120 * 1.1, 6); // ×1.1 GST
  });

  it('models a variable-wholesale (Amber) plan as a 24×1h TOU + wholesale FiT curve', () => {
    const raw: RawPlanDetail = {
      planId: 'AMB1',
      brandName: 'Amber Electric',
      displayName: 'Amber',
      geography: { distributors: ['Ausgrid'] },
      electricityContract: {
        pricingModel: 'SINGLE_RATE',
        tariffPeriod: [{ rateBlockUType: 'singleRate', singleRate: { rates: [{ unitPrice: '0.27' }] } }],
        solarFeedInTariff: [{ scheme: 'CURRENT', tariffUType: 'singleTariff', singleTariff: { rates: [{ unitPrice: '0.03' }] } }],
      },
    };
    const p = normalizePlan(raw)!;
    expect(p.variableWholesale).toBe(true);
    expect(p.pricingModel).toBe('TIME_OF_USE');
    expect(p.singleRate).toBeUndefined();
    expect(p.touRates).toHaveLength(24);
    expect(p.solarFeedIn).toHaveLength(24);
    // Evening peak rate should exceed the midday trough (wholesale + network both peak in the evening).
    const rate = (h: number) => p.touRates![h].blocks[0].perKwh;
    expect(rate(18)).toBeGreaterThan(rate(11));
  });

  it('does NOT treat an Amber standing offer as variable-wholesale (conventional reference rates)', () => {
    const raw: RawPlanDetail = {
      planId: 'AMBSTD1',
      brandName: 'Amber Electric',
      displayName: 'Standing Offer: TOU',
      type: 'STANDING',
      geography: { distributors: ['Ausgrid'] },
      electricityContract: {
        pricingModel: 'SINGLE_RATE',
        tariffPeriod: [{ rateBlockUType: 'singleRate', singleRate: { rates: [{ unitPrice: '0.3' }] } }],
      },
    };
    const p = normalizePlan(raw)!;
    expect(p.variableWholesale).toBeUndefined();
    expect(p.singleRate).toBeDefined();
    expect(p.touRates).toBeUndefined();
  });

  it('never spot-models Flow Power — its "variable" prices are a monthly pool adjustment, not passthrough', () => {
    const flow = (displayName: string): RawPlanDetail => ({
      planId: 'F',
      brandName: 'Flow Power',
      displayName,
      type: 'MARKET',
      geography: { distributors: ['Ausgrid'] },
      electricityContract: {
        pricingModel: 'SINGLE_RATE',
        tariffPeriod: [{ rateBlockUType: 'singleRate', singleRate: { rates: [{ unitPrice: '0.3' }] } }],
      },
    });
    // Flow Power's pool-based pricing can't be modelled from wholesale, so we keep its published
    // flat CDR rate and never flag it as variable-wholesale — even the "Variable Prices" estimate.
    expect(normalizePlan(flow('Flow Home FY26: Variable Prices (estimate)'))!.variableWholesale).toBeUndefined();
    expect(normalizePlan(flow('Flow Home - Single Rate'))!.variableWholesale).toBeUndefined();
    expect(normalizePlan(flow('Flow Home - TOU'))!.variableWholesale).toBeUndefined();
  });

  it('infers Flow Power hardware requirements from the plan NAME (CDR eligibility is inconsistent/empty)', () => {
    const flow = (displayName: string, eligibility?: { type?: string; information?: string; description?: string }[]): RawPlanDetail => ({
      planId: 'F',
      brandName: 'Flow Power',
      displayName,
      type: 'MARKET',
      geography: { distributors: ['Endeavour'] },
      electricityContract: {
        pricingModel: 'SINGLE_RATE',
        tariffPeriod: [{ rateBlockUType: 'singleRate', singleRate: { rates: [{ unitPrice: '0.3' }] } }],
        eligibility,
      },
    });

    // Empty eligibility[] (the Endeavour bug) — requirement must still come from the name.
    const battSolar = normalizePlan(flow('Flow Home Battery + Solar: Variable Prices (estimate)'))!;
    expect(battSolar.restrictions?.solarRequired).toBe(true);
    expect(battSolar.restrictions?.batteryRequired).toBe(true);
    expect(battSolar.restrictions?.evRequired).toBeFalsy();

    // EXISTING_SOLAR/BATTERY types with estimate-only descriptions (which estimateOnly would suppress)
    // still resolve via the name.
    const withTypes = normalizePlan(flow('Flow Home Battery + Solar: Variable Prices (estimate)', [
      { type: 'EXISTING_SOLAR', description: 'Usage price estimate based on a typical household solar system of 5kW.' },
      { type: 'EXISTING_BATTERY', description: 'Usage price estimate based on a typical household battery system of 12.5kWh.' },
    ]))!;
    expect(withTypes.restrictions?.solarRequired).toBe(true);
    expect(withTypes.restrictions?.batteryRequired).toBe(true);

    // EV in the name → evRequired.
    const ev = normalizePlan(flow('FH Battery + Solar + EV: Variable Prices (estimate)'))!;
    expect(ev.restrictions).toMatchObject({ solarRequired: true, batteryRequired: true, evRequired: true });

    // Conventional Flow plans (no hardware token in the name) stay unrestricted.
    expect(normalizePlan(flow('Flow Home - Single Rate'))!.restrictions).toBeUndefined();
    expect(normalizePlan(flow('Flow Home FY26: Variable Prices (estimate)'))!.restrictions).toBeUndefined();

    // A NON-Flow retailer with "Solar" in the name must NOT be gated (Amber's spot plan assumes solar).
    const amber: RawPlanDetail = {
      planId: 'A', brandName: 'Amber Electric', displayName: 'Amber Solar: Variable Prices', type: 'MARKET',
      geography: { distributors: ['Endeavour'] },
      electricityContract: { pricingModel: 'SINGLE_RATE', tariffPeriod: [{ rateBlockUType: 'singleRate', singleRate: { rates: [{ unitPrice: '0.3' }] } }] },
    };
    expect(normalizePlan(amber)!.restrictions?.solarRequired).toBeFalsy();
  });

  it('leaves an ordinary retailer untouched (not variable-wholesale)', () => {
    const raw: RawPlanDetail = {
      planId: 'ORD1',
      brandName: 'Origin Energy',
      displayName: 'Everyday Variable',
      geography: { distributors: ['Ausgrid'] },
      electricityContract: {
        pricingModel: 'SINGLE_RATE',
        tariffPeriod: [{ rateBlockUType: 'singleRate', singleRate: { rates: [{ unitPrice: '0.3' }] } }],
      },
    };
    const p = normalizePlan(raw)!;
    expect(p.variableWholesale).toBeUndefined();
    expect(p.singleRate).toBeDefined();
  });
});

describe('bundled snapshot integrity', () => {
  const plans = snapshot.plans as unknown as Plan[];

  it('has a substantial number of Ausgrid plans', () => {
    expect(plans.length).toBeGreaterThan(500);
  });

  it('every plan has finite supply and at least one rate', () => {
    for (const p of plans) {
      expect(Number.isFinite(p.supplyPerDay)).toBe(true);
      const hasRate =
        (p.singleRate?.blocks?.length ?? 0) > 0 || (p.touRates?.length ?? 0) > 0;
      expect(hasRate).toBe(true);
    }
  });

  it('ranks the full snapshot without NaN totals', () => {
    const imp = Array.from({ length: 24 }, (_, h) => (h >= 17 && h < 21 ? 1.5 : h >= 9 && h < 15 ? 0.3 : 0.5));
    const exp = Array.from({ length: 24 }, (_, h) => (h >= 9 && h < 15 ? 1.5 : 0));
    const profile: UsageProfile = { import: imp, export: exp, controlledLoadDailyKwh: 4 };
    const ranked = rankPlans(plans, profile, { period: 'quarterly' });
    expect(ranked.length).toBe(plans.length);
    expect(ranked.every((r) => Number.isFinite(r.total))).toBe(true);
    // Sorted ascending
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i].total).toBeGreaterThanOrEqual(ranked[i - 1].total);
    }
  });
});
