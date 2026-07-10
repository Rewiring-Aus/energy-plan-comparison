// Household energy-use assumptions ported from Rewiring Australia's 2026 Energy Savings Model
// (github.com/Rewiring-Aus/energy-savings-explorer → src/comparison/data.ts, itself derived from
// "Research/Data/.../Energy savings report data/Model input data" CSVs).
//
// We adopt RA's per-state, per-appliance average daily-kWh table, occupancy scaling curve, and
// per-state solar yield as the source of truth for household energy usage, so this comparison
// tool's estimates line up with RA's published model. We keep our own hourly load *shapes*
// (applianceProfiles.ts) and only take the daily *magnitudes* from here.

export const STATES = ['AUS', 'NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'ACT', 'NT'] as const;
export type StateCode = (typeof STATES)[number];

/**
 * Australian 4-digit postcode → state (Australia Post allocation; ACT carves out of NSW's 2xxx
 * range). Returns null for ranges that don't map to a state (PO-only, overseas). Ported from RA.
 */
export function postcodeToState(postcode: number): StateCode | null {
  if (postcode >= 200 && postcode <= 299) return 'ACT';
  if (postcode >= 2600 && postcode <= 2618) return 'ACT';
  if (postcode >= 2900 && postcode <= 2920) return 'ACT';
  if (
    (postcode >= 1000 && postcode <= 2599) ||
    (postcode >= 2619 && postcode <= 2899) ||
    (postcode >= 2921 && postcode <= 2999)
  )
    return 'NSW';
  if (postcode >= 800 && postcode <= 999) return 'NT';
  if (postcode >= 3000 && postcode <= 3999) return 'VIC';
  if (postcode >= 4000 && postcode <= 4999) return 'QLD';
  if (postcode >= 5000 && postcode <= 5799) return 'SA';
  if (postcode >= 6000 && postcode <= 6797) return 'WA';
  if (postcode >= 7000 && postcode <= 7999) return 'TAS';
  return null;
}

/** NEM region for wholesale prices (WA/NT are not in the NEM → null). ACT prices off NSW1. */
export type NemRegion = 'NSW1' | 'QLD1' | 'VIC1' | 'SA1' | 'TAS1';
export function stateToRegion(state: StateCode): NemRegion | null {
  switch (state) {
    case 'NSW':
    case 'ACT':
      return 'NSW1';
    case 'QLD':
      return 'QLD1';
    case 'VIC':
      return 'VIC1';
    case 'SA':
      return 'SA1';
    case 'TAS':
      return 'TAS1';
    default:
      return null; // AUS/WA/NT
  }
}

export function stateForPostcode(postcode: string | number | undefined): StateCode {
  const n = typeof postcode === 'string' ? Number(postcode) : postcode;
  if (n == null || Number.isNaN(n)) return 'AUS';
  return postcodeToState(n) ?? 'AUS';
}

type EnergyRow = Record<StateCode, number>;

// average_energy_use_by_appliance_and_state.csv (kWh/day) — electric appliance rows only.
// Keyed "Category|Type". Whole-of-household averages at ~2.7 occupants (scaling factor 1.0).
export const ENERGY_USE: Record<string, EnergyRow> = {
  'Space Heating|Electric heat pump': {
    AUS: 3.3, NSW: 2.273, ACT: 8.531, NT: 0.263, QLD: 1.253, SA: 2.745, TAS: 7.362, VIC: 6.007, WA: 1.969,
  },
  'Space Heating|Electric resistance': {
    AUS: 12.8, NSW: 9.09, ACT: 31.2, NT: 1.11, QLD: 5.16, SA: 10.98, TAS: 26.92, VIC: 23.34, WA: 7.87,
  },
  'Space Cooling|Heat pump': {
    AUS: 0.94, NSW: 0.77, ACT: 0.74, NT: 7.58, QLD: 1.89, SA: 0.63, TAS: 0.09, VIC: 0.1, WA: 1.65,
  },
  'Water Heating|Electric heat pump': {
    AUS: 1.83, NSW: 1.76, ACT: 2.0, NT: 1.27, QLD: 1.64, SA: 1.81, TAS: 1.9, VIC: 2.05, WA: 1.84,
  },
  'Water Heating|Electric resistance': {
    AUS: 6.75, NSW: 6.54, ACT: 6.8, NT: 4.99, QLD: 6.28, SA: 6.75, TAS: 6.46, VIC: 7.41, WA: 6.84,
  },
  'Cooktop|Electric resistance': {
    AUS: 0.94, NSW: 0.95, ACT: 0.88, NT: 0.99, QLD: 0.93, SA: 1.0, TAS: 1.0, VIC: 0.92, WA: 0.97,
  },
  'Cooktop|Electric induction': {
    AUS: 0.85, NSW: 0.86, ACT: 0.8, NT: 0.9, QLD: 0.84, SA: 0.91, TAS: 0.91, VIC: 0.83, WA: 0.87,
  },
};

export function energyUse(category: string, type: string, state: StateCode): number {
  return ENERGY_USE[`${category}|${type}`]?.[state] ?? 0;
}

// "Other Cooking" + "Other Electronics": always-electric loads (refrigeration, dishwashers,
// microwave, ovens, uprights, washers & dryers, lighting, other). Pool equipment is excluded.
export const OTHER_ELEC_KWH_DAY: Record<StateCode, number> = {
  AUS: 2.06 + 0.3 + 0.3 + 0.34 + 0.39 + 0.44 + 0.91 + 3.86,
  NSW: 2.07 + 0.3 + 0.3 + 0.34 + 0.39 + 0.44 + 0.91 + 3.97,
  ACT: 1.93 + 0.28 + 0.29 + 0.33 + 0.37 + 0.42 + 0.87 + 3.89,
  NT: 2.17 + 0.31 + 0.32 + 0.36 + 0.41 + 0.46 + 0.95 + 4.11,
  QLD: 2.03 + 0.3 + 0.3 + 0.34 + 0.38 + 0.44 + 0.9 + 3.75,
  SA: 2.21 + 0.32 + 0.32 + 0.36 + 0.41 + 0.46 + 0.96 + 3.79,
  TAS: 2.22 + 0.32 + 0.32 + 0.37 + 0.42 + 0.47 + 0.96 + 3.78,
  VIC: 2.01 + 0.29 + 0.3 + 0.34 + 0.38 + 0.44 + 0.9 + 3.87,
  WA: 2.1 + 0.31 + 0.31 + 0.35 + 0.4 + 0.45 + 0.93 + 3.76,
};

// energy_consumption_scaling_factors.csv — multiply whole-of-household loads by this. Calibrated
// so the ~2.7-occupant national average = 1.0. Linearly interpolated between points.
const SCALING_POINTS: { occupants: number; factor: number }[] = [
  { occupants: 1, factor: 0.56 },
  { occupants: 2, factor: 0.9 },
  { occupants: 2.7, factor: 1.0 },
  { occupants: 3, factor: 1.03 },
  { occupants: 4, factor: 1.07 },
  { occupants: 5, factor: 1.37 },
];

export function getScalingFactor(n: number): number {
  const pts = SCALING_POINTS;
  if (n <= pts[0].occupants) return pts[0].factor;
  if (n >= pts[pts.length - 1].occupants) return pts[pts.length - 1].factor;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (n >= a.occupants && n <= b.occupants) {
      const frac = (n - a.occupants) / (b.occupants - a.occupants);
      return a.factor + frac * (b.factor - a.factor);
    }
  }
  return 1;
}

// solar_lcoe_by_state.csv capacity factor × 24 h — daily generation per installed kW (year 1).
export const SOLAR_DAILY_KWH_PER_KW: Record<StateCode, number> = {
  AUS: 4.3859, NSW: 4.3126, ACT: 4.4549, NT: 5.7797, QLD: 5.0715, SA: 4.3782, TAS: 3.4516, VIC: 3.7567, WA: 4.9536,
};
