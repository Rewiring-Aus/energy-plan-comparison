import type { BillingPeriod, Behaviours, SolarEffectiveness, UsageProfile } from '../types';
import {
  AIRCON_SHAPE,
  BASE_SHAPE,
  COOKING_SHAPE,
  EV_SHAPES,
  HEATING_SHAPE,
  HOTWATER_SHAPE,
  POOL_SHAPE,
  soakShapeForState,
  applianceDailyKwh,
  type ApplianceKey,
  type HomeInputs,
} from '../data/applianceProfiles';
import { solarGeneration } from '../data/solarProfile';
import type { StateCode } from '../data/energyModel';
import { hourlyFlows } from './flows';

const DAYS_IN_PERIOD: Record<BillingPeriod, number> = {
  annual: 365,
  quarterly: 91.25,
  monthly: 30.4375,
};

/** Convert a period total (kWh) to an average daily kWh. */
export function periodToDailyKwh(total: number, period: BillingPeriod): number {
  return total / DAYS_IN_PERIOD[period];
}
export function dailyToPeriodKwh(daily: number, period: BillingPeriod): number {
  return daily * DAYS_IN_PERIOD[period];
}

export const DEFAULT_BEHAVIOURS: Behaviours = {
  poolTimer: false,
  poolShare: 0.5,
  poolHours: 8,
  hotWaterTimer: false,
  hotWaterShare: 0.8,
  heatPumpTimer: false,
  heatPumpShare: 0.8,
  evScheduled: false,
  evShare: 0.9,
  evHomeDaytime: true,
  v2g: false,
  v2gKwh: 30,
  batteryGridCharge: false,
};

export type ApplianceLoads = Record<ApplianceKey, number[]>;

/** EV/V2G charger inverter limit (kW ≈ kWh/hour) — battery draw and discharge are capped here. */
export const V2G_POWER_KW = 7;

export interface SynthInput {
  home: HomeInputs;
  /** Optional anchor from Tier 1. When set, the composite shape is scaled to match it. */
  baselineDailyKwh?: number;
  includeSolar: boolean;
  effectiveness: SolarEffectiveness;
  behaviours: Behaviours;
  /** Household state (from postcode) — drives RA per-state energy-use & solar-yield figures. */
  state?: StateCode;
  /** Marginal import $/kWh per hour for the selected plan, so V2G/battery arbitrage optimises to it. */
  dispatchRates?: number[];
}

export interface DerivedProfile {
  profile: UsageProfile;
  /** Per-appliance hourly load (kWh) for the stacked chart (one representative day). */
  loads: ApplianceLoads;
  gross: number[];
  /** Gross solar generation per hour (for the chart's solar line). */
  solar: number[];
}

const zeros = () => Array.from({ length: 24 }, () => 0);

/** Blend a natural load shape with the solar-soak window by `share` (0..1). */
function soaked(natural: number[], share: number, soakShape: number[]): number[] {
  const s = Math.max(0, Math.min(1, share));
  return natural.map((v, h) => v * (1 - s) + soakShape[h] * s);
}

/**
 * Derive the billable import/export profile, a per-appliance load breakdown (for the stacked
 * chart), and the gross/solar series — from the home model and the demand-shifting behaviours.
 */
export function synthesizeProfile({
  home,
  baselineDailyKwh,
  includeSolar,
  effectiveness,
  behaviours: b,
  state = 'AUS',
  dispatchRates,
}: SynthInput): DerivedProfile {
  const a = applianceDailyKwh(home, state);
  const soakShape = soakShapeForState(state);
  const onCL = home.hotWater === 'controlled-load';
  const isHeatPump = home.hotWater === 'heat-pump';

  // Pool kWh reflects how long the pump runs (custom setting), ~0.5 kW draw.
  const poolKwh = home.poolPump ? Math.max(0, b.poolHours) * 0.5 : 0;

  // Hot water: controlled-load stays on its own circuit UNLESS a smart timer soaks it.
  const clShiftedToSoak = onCL && b.hotWaterTimer;
  const hotWaterInGross = onCL ? (clShiftedToSoak ? a.hotWater : 0) : a.hotWater;
  const hwTimerOn = isHeatPump ? b.heatPumpTimer : b.hotWaterTimer;
  const hwShare = isHeatPump ? b.heatPumpShare : b.hotWaterShare;
  const hotWaterShape = hwTimerOn ? soaked(HOTWATER_SHAPE, hwShare, soakShape) : HOTWATER_SHAPE;

  // EV: scheduling only soaks well if the car is home midday; otherwise limited.
  const evEffShare = b.evScheduled ? (b.evHomeDaytime ? b.evShare : 0.2) : 0;
  const evShape = b.evScheduled ? soaked(EV_SHAPES[home.evCharge], evEffShare, soakShape) : EV_SHAPES[home.evCharge];

  const poolShape = b.poolTimer ? soaked(POOL_SHAPE, b.poolShare, soakShape) : POOL_SHAPE;

  const contributions: { key: ApplianceKey; shape: number[]; kwh: number }[] = [
    { key: 'base', shape: BASE_SHAPE, kwh: a.base },
    { key: 'hotWater', shape: hotWaterShape, kwh: hotWaterInGross },
    { key: 'cooking', shape: COOKING_SHAPE, kwh: a.cooking },
    { key: 'aircon', shape: AIRCON_SHAPE, kwh: a.aircon },
    { key: 'heating', shape: HEATING_SHAPE, kwh: a.heating },
    { key: 'pool', shape: poolShape, kwh: poolKwh },
    { key: 'ev', shape: evShape, kwh: a.ev },
  ];

  const clDaily = clShiftedToSoak ? 0 : onCL ? a.hotWater : 0;
  const mainDaily = contributions.reduce((s, c) => s + c.kwh, 0);
  const estTotal = mainDaily + clDaily;
  const target = baselineDailyKwh != null && baselineDailyKwh > 0 ? baselineDailyKwh : estTotal;
  const scale = estTotal > 0 ? target / estTotal : 1;

  const loads = {} as ApplianceLoads;
  const gross = zeros();
  for (const c of contributions) {
    const kwh = c.kwh * scale;
    const arr = c.shape.map((s) => s * kwh);
    loads[c.key] = arr;
    for (let h = 0; h < 24; h++) gross[h] += arr[h];
  }

  const solar = includeSolar ? solarGeneration(home.solarKw, state) : zeros();
  const batteryKwh = home.batteryKwh + (b.v2g ? b.v2gKwh : 0);
  const flows = hourlyFlows(gross, solar, includeSolar, {
    effectiveness,
    batteryKwh,
    // V2G implies off-peak→peak arbitrage, so it helps even without solar.
    batteryGridCharge: b.batteryGridCharge || b.v2g,
    dispatchRates,
    // The car's charger caps how fast it can charge/discharge; a fixed home battery is unconstrained here.
    powerLimitKwh: b.v2g ? V2G_POWER_KW : undefined,
  });
  const imp = flows.map((f) => f.import);
  const exp = flows.map((f) => f.export);

  return {
    profile: {
      import: imp,
      export: exp,
      controlledLoadDailyKwh: clDaily * scale,
    },
    loads,
    gross: [...gross],
    solar,
  };
}

/** Sum of an array (e.g. a day's net import). */
export function dailyTotal(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0);
}
