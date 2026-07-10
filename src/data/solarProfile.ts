// Normalised solar PV generation shape (annual average), scaled by a per-state daily yield.
// The 24 values sum to 1.0; multiply by daily generation to get kWh/hour.

import { SOLAR_DAILY_KWH_PER_KW, type StateCode } from './energyModel';

// A smooth bell centred ~12:30, generation roughly 6am–7pm.
const RAW = [
  0, 0, 0, 0, 0, 0, // 0-5
  0.005, 0.02, 0.05, 0.085, 0.115, 0.135, // 6-11
  0.145, 0.135, 0.115, 0.085, 0.05, 0.02, // 12-17
  0.005, 0, 0, 0, 0, 0, // 18-23
];

const SUM = RAW.reduce((a, b) => a + b, 0);
export const SOLAR_SHAPE: number[] = RAW.map((v) => v / SUM);

/** Daily generation (kWh) hour-by-hour for a `kw` system in a given state (RA per-state yield). */
export function solarGeneration(kw: number, state: StateCode = 'AUS'): number[] {
  const daily = kw * SOLAR_DAILY_KWH_PER_KW[state];
  return SOLAR_SHAPE.map((s) => s * daily);
}
