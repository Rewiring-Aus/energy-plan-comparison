import type { DayType, FeedInBand, Plan, TimeWindow, TouRate } from '../types';

/** Does an integer hour [h, h+1) fall inside a time window? Handles midnight-wrap windows. */
export function hourInWindow(hour: number, dayType: DayType, w: TimeWindow): boolean {
  if (!w.dayTypes.includes(dayType)) return false;
  const from = Math.floor(w.fromHour);
  const to = Math.ceil(w.toHour);
  if (from <= to) return hour >= from && hour < to;
  // wraps past midnight (e.g. 22:00 -> 06:00)
  return hour >= from || hour < to;
}

/**
 * Pick the TOU rate that applies at a given hour/day-type.
 * Prefers the most specific (narrowest) matching window; falls back to the first
 * rate whose window list is empty/all-day, then to PEAK as a safe default.
 */
export function resolveTouRate(rates: TouRate[], hour: number, dayType: DayType): TouRate | undefined {
  let best: TouRate | undefined;
  let bestSpan = Infinity;
  for (const r of rates) {
    for (const w of r.windows) {
      if (hourInWindow(hour, dayType, w)) {
        const span = windowSpan(w);
        if (span < bestSpan) {
          bestSpan = span;
          best = r;
        }
      }
    }
  }
  if (best) return best;
  // No explicit match — prefer a rate that has an all-day/empty window.
  return rates.find((r) => r.windows.some((w) => windowSpan(w) >= 24)) ?? rates[0];
}

function windowSpan(w: TimeWindow): number {
  const span = w.toHour - w.fromHour;
  return span > 0 ? span : 24 + span;
}

/**
 * The marginal $/kWh a plan charges general usage at each hour of the day (24 values, TOU-aware,
 * else single/flat). Uses the first (lowest-threshold) block — e.g. a Solar Sharer free window
 * reads as 0c. Used to optimise battery/V2G charge & discharge windows against a chosen plan.
 */
export function planHourlyImportRates(plan: Plan, dayType: DayType): number[] {
  return Array.from({ length: 24 }, (_, h) => {
    if (plan.touRates?.length) {
      const r = resolveTouRate(plan.touRates, h, dayType);
      if (r) return r.blocks[0]?.perKwh ?? 0;
    }
    return plan.singleRate?.blocks[0]?.perKwh ?? plan.touRates?.[0]?.blocks[0]?.perKwh ?? 0;
  });
}

/**
 * Feed-in rate ($/kWh) that applies to export at a given hour/day-type.
 * Prefers the narrowest matching windowed band; a band with no windows is the
 * all-day fallback; returns 0 if nothing covers this hour (e.g. peak-only FiT).
 */
export function resolveFitRate(bands: FeedInBand[], hour: number, dayType: DayType): number {
  let best: FeedInBand | undefined;
  let bestSpan = Infinity;
  let allDay: FeedInBand | undefined;
  for (const b of bands) {
    // Battery-arbitrage estimates don't apply to direct solar export (the export we model).
    if (b.batteryOnly) continue;
    if (!b.windows || b.windows.length === 0) {
      allDay = b;
      continue;
    }
    for (const w of b.windows) {
      if (hourInWindow(hour, dayType, w)) {
        const span = windowSpan(w);
        if (span < bestSpan) {
          bestSpan = span;
          best = b;
        }
      }
    }
  }
  if (best) return best.perKwh;
  if (allDay) return allDay.perKwh;
  return 0;
}
