// Canonical normalised 24-hour load shapes (each sums to 1.0) for the home-model
// appliances, plus helpers to estimate typical daily kWh from the home inputs.
// Figures are representative Australian averages — intended for a sensible default
// shape the user then refines, not metering-grade accuracy.

import { OTHER_ELEC_KWH_DAY, energyUse, getScalingFactor, type StateCode } from './energyModel';

function norm(a: number[]): number[] {
  const s = a.reduce((x, y) => x + y, 0) || 1;
  return a.map((v) => v / s);
}

/** Always-on plug loads, fridge, standby — fairly flat with small evening lift. */
export const BASE_SHAPE = norm([
  3, 3, 3, 3, 3, 3.5, 4, 4.5, 4.5, 4, 4, 4, 4, 4, 4, 4.5, 5, 6, 7, 7, 6.5, 5.5, 4.5, 3.5,
]);

/** Cooking — breakfast and (larger) dinner peaks. */
export const COOKING_SHAPE = norm([
  0, 0, 0, 0, 0, 0, 0.5, 1.5, 1, 0, 0, 0.5, 1, 0.3, 0, 0, 0.5, 2, 4, 3, 1, 0.2, 0, 0,
]);

/** Heat-pump / electric storage hot water — heats early morning + small evening top-up. */
export const HOTWATER_SHAPE = norm([
  0.5, 0.5, 0.5, 1, 2, 3, 3, 2, 1, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 1, 1.5, 1.5, 1, 0.8, 0.6, 0.5,
]);

/** Air-conditioning — afternoon build, evening peak. */
export const AIRCON_SHAPE = norm([
  0.5, 0.3, 0.2, 0.2, 0.2, 0.2, 0.3, 0.5, 0.5, 0.5, 0.8, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4, 3.5, 2.5, 1.5, 1, 0.7,
]);

/** Space heating — morning + evening peaks. */
export const HEATING_SHAPE = norm([
  1, 0.8, 0.6, 0.6, 0.8, 1.5, 3, 3.5, 2.5, 1.5, 1, 0.8, 0.8, 0.8, 1, 1.5, 2.5, 3.5, 4, 3.5, 2.5, 2, 1.5, 1.2,
]);

/** Pool pump — runs midday. */
export const POOL_SHAPE = norm([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0,
]);

/** The local solar-soak window: midday, when rooftop solar floods the grid (11am–2pm). */
export const SOAK_SHAPE = norm([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]);
export const SOAK_HOURS = [11, 12, 13];

/** South Australia's solar glut runs later — the soak/solar-sharer window is 12–3pm there. */
export const SA_SOAK_SHAPE = norm([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]);
export const SA_SOAK_HOURS = [12, 13, 14];

/** The solar-soak window shape for a state (SA shifts later; everyone else uses the default). */
export function soakShapeForState(state?: string): number[] {
  return state === 'SA' ? SA_SOAK_SHAPE : SOAK_SHAPE;
}
/** Human label for the soak window, e.g. "11am–2pm" (default) or "12–3pm" (SA). */
export function soakWindowLabel(state?: string): string {
  return state === 'SA' ? '12–3pm' : '11am–2pm';
}

export type ApplianceKey = 'base' | 'hotWater' | 'cooking' | 'aircon' | 'heating' | 'pool' | 'ev';

/** Display metadata for the stacked-load chart + legend, drawn bottom→top in this order. */
export const APPLIANCE_META: { key: ApplianceKey; label: string; color: string }[] = [
  { key: 'base', label: 'Everything else', color: '#9aa0a6' },
  { key: 'hotWater', label: 'Hot water', color: '#2b6fb0' },
  { key: 'cooking', label: 'Cooking', color: '#e0a020' },
  { key: 'aircon', label: 'Air-con', color: '#17a2b8' },
  { key: 'heating', label: 'Heating', color: '#c0392b' },
  { key: 'pool', label: 'Pool pump', color: '#1f9e8f' },
  { key: 'ev', label: 'EV charging', color: '#7b3fe4' },
];

export type EvCharge = 'day' | 'evening' | 'overnight';
export const EV_SHAPES: Record<EvCharge, number[]> = {
  day: norm([0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
  evening: norm([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0]),
  overnight: norm([1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1]),
};

// ---- Typical daily kWh estimates (gross, before solar) ----------------------

export type HotWaterType = 'gas' | 'electric-storage' | 'heat-pump' | 'controlled-load' | 'solar';
export type HeatingType = 'none' | 'gas' | 'reverse-cycle' | 'resistive';
export type CookingType = 'gas' | 'electric';
export type AirconLevel = 'none' | 'some' | 'ducted';

export interface HomeInputs {
  occupants: number;
  hotWater: HotWaterType;
  heating: HeatingType;
  cooking: CookingType;
  aircon: AirconLevel;
  poolPump: boolean;
  evCount: number;
  evKmPerWeek: number;
  evCharge: EvCharge;
  solarKw: number;
  batteryKwh: number;
}

export const DEFAULT_HOME: HomeInputs = {
  occupants: 3,
  hotWater: 'electric-storage',
  heating: 'reverse-cycle',
  cooking: 'electric',
  aircon: 'some',
  poolPump: false,
  evCount: 0,
  evKmPerWeek: 0,
  evCharge: 'overnight',
  solarKw: 0,
  batteryKwh: 0,
};

const EV_KWH_PER_KM = 0.18;

// Ducted air-con runs more than a single split; RA's "Space Cooling" figure is a whole-of-state
// average (no intensity dimension), so we anchor "some" to it and lift "ducted" modestly. This
// multiplier is our own extension on top of the RA figure, not from RA.
const DUCTED_COOLING_MULTIPLIER = 1.8;

/**
 * Daily kWh per appliance category, from the home inputs and the household's state. Magnitudes
 * come from Rewiring Australia's 2026 Energy Savings Model (per-state per-appliance averages ×
 * occupancy scaling); see [[energyModel]]. Pool and EV are our own additions (RA excludes them).
 */
export function applianceDailyKwh(h: HomeInputs, state: StateCode = 'AUS') {
  const occ = getScalingFactor(h.occupants);
  const scaled = (kwh: number) => kwh * occ;

  const base = scaled(OTHER_ELEC_KWH_DAY[state]);

  let hotWater = 0;
  if (h.hotWater === 'electric-storage' || h.hotWater === 'controlled-load')
    hotWater = scaled(energyUse('Water Heating', 'Electric resistance', state));
  else if (h.hotWater === 'heat-pump') hotWater = scaled(energyUse('Water Heating', 'Electric heat pump', state));
  // gas / solar hot water => ~0 electric

  const cooking = h.cooking === 'electric' ? scaled(energyUse('Cooktop', 'Electric resistance', state)) : 0;

  const cooling = energyUse('Space Cooling', 'Heat pump', state);
  const aircon = h.aircon === 'ducted' ? scaled(cooling * DUCTED_COOLING_MULTIPLIER) : h.aircon === 'some' ? scaled(cooling) : 0;

  let heating = 0;
  if (h.heating === 'reverse-cycle') heating = scaled(energyUse('Space Heating', 'Electric heat pump', state));
  else if (h.heating === 'resistive') heating = scaled(energyUse('Space Heating', 'Electric resistance', state));
  // gas / none => ~0 electric

  const pool = h.poolPump ? 4 : 0;

  const ev = (h.evCount * h.evKmPerWeek * EV_KWH_PER_KM) / 7;

  return { base, hotWater, cooking, aircon, heating, pool, ev };
}

/** Total estimated gross daily kWh (before solar) for the home inputs. */
export function estimatedDailyKwh(h: HomeInputs, state: StateCode = 'AUS'): number {
  const a = applianceDailyKwh(h, state);
  return a.base + a.hotWater + a.cooking + a.aircon + a.heating + a.pool + a.ev;
}
