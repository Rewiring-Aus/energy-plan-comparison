// Derives the expected hourly grid import/export for a home, blending a sunny and a cloudy
// representative day (weighted by a clear-sky fraction tied to the effectiveness preset) and
// applying the battery model. Blending two sub-days is what produces a realistic *residual*
// midday import for solar homes: on cloudy days you draw from the grid even at noon.

import type { SolarEffectiveness } from '../types';

const BATTERY_ROUNDTRIP = 0.9;
/** Fraction of generation a heavily overcast day produces (vs a clear day). */
const CLOUDY_SOLAR_FACTOR = 0.15;

/** Share of days that are effectively sunny — lower = more rainy-day grid residual. */
export const CLEAR_SKY_FRACTION: Record<SolarEffectiveness, number> = {
  optimistic: 0.95,
  realistic: 0.8,
  conservative: 0.62,
};

/**
 * Hours the battery grid-charges when topping up. It charges in the *midday solar-soak* window,
 * not overnight — because on the plans this tool is about (Solar Sharer, OVO "Free 3", and solar
 * self-consumption) midday is the cheap/free window, whereas overnight is often the pricier
 * off-peak. Charging midday and discharging the evening peak is the winning arbitrage.
 */
export const CHARGE_HOURS = [10, 11, 12, 13, 14];

export interface FlowOptions {
  effectiveness: SolarEffectiveness;
  batteryKwh: number;
  batteryGridCharge: boolean;
  /**
   * Marginal import $/kWh for each hour of the plan the battery is being optimised for (24 values).
   * When present, grid top-up happens in that plan's cheapest profitable hours instead of the
   * default midday window — so V2G/battery arbitrage follows the *selected* TOU plan.
   */
  dispatchRates?: number[];
  /** Max charge/discharge per hour (kWh ≈ kW). V2G is inverter-limited to ~7 kW. */
  powerLimitKwh?: number;
}

export interface HourFlow {
  import: number;
  export: number;
}

/** Rates within this ($/kWh) of the day's cheapest count as the same "cheapest tier". */
const CHEAP_TIER_TOLERANCE = 0.02;

/**
 * Which hours to grid-charge in, given the plan's hourly rates. Charges only in the day's cheapest
 * rate tier (e.g. a Solar Sharer free window, or a traditional off-peak block) — never mixing in a
 * pricier hour, which the forward sim would otherwise fill early and waste money on. If even the
 * cheapest hour can't beat the peak after round-trip loss (a flat/near-flat plan), it charges
 * nothing — there's no arbitrage to be had.
 */
function pickChargeHours(rates: number[]): number[] {
  const maxRate = Math.max(...rates);
  const minRate = Math.min(...rates);
  if (minRate >= maxRate * BATTERY_ROUNDTRIP) return [];
  return rates.map((r, h) => ({ r, h })).filter((x) => x.r <= minRate + CHEAP_TIER_TOLERANCE).map((x) => x.h);
}

/** One representative day's grid import/export given a solar level (two-pass battery cycle). */
function simulateDay(
  consumption: number[],
  solar: number[],
  cap: number,
  batteryGridCharge: boolean,
  chargeHours: number[],
  powerLimit: number,
): HourFlow[] {
  const out: HourFlow[] = Array.from({ length: 24 }, () => ({ import: 0, export: 0 }));
  const perHourChargeLimit = cap > 0 ? Math.min(cap * 0.5, powerLimit) : 0;
  let soc = 0;
  const passes = cap > 0 ? 2 : 1;
  for (let pass = 0; pass < passes; pass++) {
    for (let h = 0; h < 24; h++) {
      const cons = consumption[h] ?? 0;
      const gen = solar[h] ?? 0;
      const self = Math.min(cons, gen);
      let surplus = gen - self;
      let deficit = cons - self;
      let gridCharge = 0;
      if (cap > 0) {
        const charge = Math.min(surplus, cap - soc, perHourChargeLimit);
        soc += charge * BATTERY_ROUNDTRIP;
        surplus -= charge;
        const discharge = Math.min(deficit, soc, powerLimit);
        soc -= discharge;
        deficit -= discharge;
        if (batteryGridCharge && chargeHours.includes(h)) {
          gridCharge = Math.min(cap - soc, perHourChargeLimit);
          soc += gridCharge * BATTERY_ROUNDTRIP;
        }
      }
      if (pass === passes - 1) {
        out[h] = { import: deficit + gridCharge, export: surplus };
      }
    }
  }
  return out;
}

/**
 * Expected hourly import/export, blending a sunny day and a cloudy day by the clear-sky
 * fraction. With no solar both sub-days are identical (import = consumption).
 */
export function hourlyFlows(
  consumption: number[],
  solarGross: number[],
  includeSolar: boolean,
  opts: FlowOptions,
): HourFlow[] {
  const cap = Math.max(0, opts.batteryKwh);
  const zeros = new Array(24).fill(0);
  const powerLimit = opts.powerLimitKwh ?? Infinity;
  // Grid top-up window: follow the selected plan's cheapest hours if we have its rates,
  // else the default midday solar-soak window.
  const chargeHours = opts.dispatchRates ? pickChargeHours(opts.dispatchRates) : CHARGE_HOURS;
  // No solar: no sunny/cloudy blend needed. A battery still helps via off-peak grid arbitrage.
  if (!includeSolar) {
    if (cap <= 0) return consumption.map((c) => ({ import: Math.max(0, c), export: 0 }));
    return simulateDay(consumption, zeros, cap, opts.batteryGridCharge, chargeHours, powerLimit);
  }
  const clear = CLEAR_SKY_FRACTION[opts.effectiveness];
  // On a sunny day, free solar fills the battery — grid top-up would only pre-empt that (and, on a
  // plan whose cheap window is overnight, block the day's solar from being stored). So grid top-up
  // applies on the low-solar (cloudy) sub-day only; the sunny day just self-consumes and stores solar.
  const sunny = simulateDay(consumption, solarGross, cap, false, chargeHours, powerLimit);
  const cloudy = simulateDay(
    consumption,
    solarGross.map((s) => s * CLOUDY_SOLAR_FACTOR),
    cap,
    opts.batteryGridCharge,
    chargeHours,
    powerLimit,
  );
  return sunny.map((s, h) => ({
    import: clear * s.import + (1 - clear) * cloudy[h].import,
    export: clear * s.export + (1 - clear) * cloudy[h].export,
  }));
}
