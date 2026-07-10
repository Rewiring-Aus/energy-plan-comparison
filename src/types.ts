// Core domain types for the bill comparison tool.
// All monetary rates are stored in **dollars** (e.g. 0.293 = 29.3c/kWh, 0.8894 = 88.94c/day)
// matching the CDR Energy API unit convention.

export type DayType = 'WEEKDAY' | 'WEEKEND';

export type TouLabel = 'PEAK' | 'SHOULDER' | 'OFFPEAK';

/** A contiguous time-of-day window. `toHour` of 24 means end-of-day (midnight). */
export interface TimeWindow {
  dayTypes: DayType[];
  fromHour: number; // 0..24
  toHour: number; // 0..24 (exclusive); 24 == midnight
}

/** A tiered/block rate. `upToKwhPerDay` undefined => final (unbounded) block. */
export interface RateBlock {
  perKwh: number; // dollars
  upToKwhPerDay?: number;
}

export interface TouRate {
  label: TouLabel;
  blocks: RateBlock[];
  windows: TimeWindow[];
}

export interface DemandCharge {
  perKwPerDay: number; // dollars per kW per day (normalised from monthly/period)
  windows: TimeWindow[];
}

/** A solar feed-in rate. No `windows` => applies all day. */
export interface FeedInBand {
  perKwh: number;
  windows?: TimeWindow[];
  /**
   * Rate is an estimate that assumes battery arbitrage (e.g. Amber's wholesale FiT for an
   * 8kW+13kWh setup). It only applies to battery exports, not direct solar export, so the
   * engine credits direct solar export at 0c for these bands.
   */
  batteryOnly?: boolean;
}

export type PricingModel = 'SINGLE_RATE' | 'TIME_OF_USE' | 'TIME_OF_USE_DEMAND';

/** Eligibility restrictions that gate who can take a plan. */
export interface PlanRestrictions {
  newCustomerOnly: boolean;
  thirdPartyOnly: boolean; // partner / membership / third-party gated
  solarRequired: boolean;
  batteryRequired: boolean;
  evRequired: boolean; // requires an EV / electric vehicle (e.g. Flow Power's EV plans)
  seniorCard: boolean; // seniors / pensioner / concession
}

export interface Plan {
  id: string;
  retailer: string;
  brand: string;
  planName: string;
  planType: 'STANDING' | 'MARKET';
  fuelType: 'ELECTRICITY';
  distributors: string[];
  supplyPerDay: number; // dollars/day
  pricingModel: PricingModel;
  singleRate?: { blocks: RateBlock[] };
  touRates?: TouRate[];
  demandCharges?: DemandCharge[];
  controlledLoad?: { perKwh: number; supplyPerDay?: number };
  /** Feed-in tariff bands. A band with no `windows` applies all day; multiple bands = TOU FiT. */
  solarFeedIn?: FeedInBand[];
  /** Free-usage windows (e.g. OVO "Free 3" 11am–2pm) — import billed at $0 in these hours. */
  freeWindows?: TimeWindow[];
  /** Sum of ongoing/recurring fees (e.g. Amber membership), annualised to dollars/year. */
  recurringFeeAnnual?: number;
  /** Eligibility restrictions parsed from the CDR eligibility[] list. */
  restrictions?: PlanRestrictions;
  /** Human-readable eligibility notes for display (the CDR `information` labels). */
  eligibilityNotes?: string[];
  /** Plan offers GreenPower. */
  greenPower?: boolean;
  /** Fixed-term / lock-in (has an exit fee or is a fixed contract). */
  lockIn?: boolean;
  /** Modelled as a 24×1h TOU from the wholesale curve + network tariff (Amber-style spot plans). */
  variableWholesale?: boolean;
  /** AER plan landing page for "view plan". */
  planUrl?: string;
}

/**
 * The user's billable profile: expected grid **import** and **export** per hour (length-24,
 * kWh/hour, both ≥ 0). Solar/battery and weather (sunny/cloudy blend) are baked in during
 * derivation, so a solar home can both import (cloudy days) and export (sunny days) in the same
 * hour on average. The engine bills import (by TOU) and credits export (by FiT).
 */
export interface UsageProfile {
  import: number[]; // length 24, kWh/hour drawn from the grid (one representative day)
  export: number[]; // length 24, kWh/hour sent to the grid
  /** Daily kWh billed on a separate controlled-load circuit (e.g. off-peak hot water). */
  controlledLoadDailyKwh: number;
}

/** How much of the idealised solar/battery benefit to count (rainy-day realism). */
export type SolarEffectiveness = 'optimistic' | 'realistic' | 'conservative';

/** Per-appliance demand-shaping behaviours (shift load into the local solar-soak window). */
export interface Behaviours {
  poolTimer: boolean;
  poolShare: number; // fraction of pool load moved into the soak window
  poolHours: number; // hours/day the pump currently runs (customises pool kWh)
  hotWaterTimer: boolean; // electric / off-peak storage
  hotWaterShare: number;
  heatPumpTimer: boolean;
  heatPumpShare: number;
  evScheduled: boolean;
  evShare: number;
  evHomeDaytime: boolean; // is the car home to charge midday?
  v2g: boolean; // vehicle-to-grid: EV acts as a home battery
  v2gKwh: number; // usable V2G capacity
  batteryGridCharge: boolean; // home battery tops up from off-peak grid
}

export type BillingPeriod = 'monthly' | 'quarterly' | 'annual';

/** A single line in the net-usage breakdown (a TOU band, controlled load, demand, or solar credit). */
export interface UsageBand {
  key: string;
  label: string;
  cost: number; // dollars for the period (credits are negative)
  detail?: string; // e.g. "29c/kWh · 2pm–8pm weekdays"
}

export interface CostBreakdown {
  supply: number;
  usage: number;
  controlledLoad: number;
  demand: number;
  fees: number; // recurring/membership fees
  solarCredit: number; // negative or zero
  /** Itemised net-usage lines (energy bands + controlled load + demand + solar credit). */
  usageBands: UsageBand[];
}

export interface CostResult {
  planId: string;
  total: number; // dollars for the selected billing period
  fixedTotal: number; // supply + recurring fees
  usageTotal: number; // usage + controlled load + demand + solar credit
  breakdown: CostBreakdown;
  effectivePerKwh: number; // dollars per imported kWh
}
