// Default residential time-of-use NETWORK tariffs per DNSP — the tariff a variable-wholesale
// retailer (Amber etc.) effectively passes through per distributor. Used to model those plans as a
// 24×1h TOU: rate[h] = wholesale[h] + network[h] + market charges.
//
// Rates are the NUOS energy component (distribution + transmission + jurisdictional pass-throughs),
// EX-GST, in c/kWh — grossed up ×1.1 downstream in normalizePlan with the wholesale price. Daily
// supply is recorded for reference only: wholesale plans keep their REAL CDR supply charge, so the
// supplyPerDay field here is NOT billed.
//
// Source: each DNSP's AER-approved 2025-26 network price list / SCS pricing model (VIC networks are
// the FY2026-27 schedule, the current one). Figures verified against primary AER/DNSP documents
// (Aug 2026). Windows are applied on all days for simplicity (weekday/weekend is averaged elsewhere).
//
// Tariff choice: where a DNSP now defaults NEW smart-meter connections to a DEMAND tariff (Ausgrid
// EA116, Evoenergy 023), we deliberately model the opt-in/opt-out flat TOU tariff instead — a spot
// plan is billed per-kWh, not on a kVA/kW demand, so the TOU schedule is the right analogue.
//
// Refresh from each DNSP's price list annually.

import type { DayType, TouRate } from '../types';

const ALL: DayType[] = ['WEEKDAY', 'WEEKEND'];
const win = (fromHour: number, toHour: number) => ({ dayTypes: ALL, fromHour, toHour });

export interface NetworkTariff {
  supplyPerDay: number; // $/day network supply charge (reference only — not billed for wholesale plans)
  touRates: TouRate[]; // network energy component, $/kWh, by window
}

// Helper to build a peak/off-peak (± shoulder) network tariff. Rates in c/kWh for readability.
// `shoulder` doubles as the solar-soak/solar-sponge slot: it's a narrow window whose rate can sit
// BELOW off-peak (resolveTouRate picks the narrowest matching window, so it wins over the all-day
// off-peak fallback).
function tou(
  supplyCPerDay: number,
  peakC: number,
  offpeakC: number,
  peakWindows: { fromHour: number; toHour: number }[],
  shoulder?: { c: number; windows: { fromHour: number; toHour: number }[] },
): NetworkTariff {
  const rates: TouRate[] = [
    { label: 'OFFPEAK', blocks: [{ perKwh: offpeakC / 100 }], windows: [win(0, 24)] }, // all-day fallback
    { label: 'PEAK', blocks: [{ perKwh: peakC / 100 }], windows: peakWindows.map((w) => win(w.fromHour, w.toHour)) },
  ];
  if (shoulder) {
    rates.push({
      label: 'SHOULDER',
      blocks: [{ perKwh: shoulder.c / 100 }],
      windows: shoulder.windows.map((w) => win(w.fromHour, w.toHour)),
    });
  }
  return { supplyPerDay: supplyCPerDay / 100, touRates: rates };
}

// Keyed by the exact distributor strings used in plans.json.
export const NETWORK_TARIFFS: Record<string, NetworkTariff> = {
  // ── NSW (2025-26 price lists) ────────────────────────────────────────────────
  // Ausgrid EA025 "Residential ToU" (opt-in flat TOU; default for new smart meters is EA116 demand).
  // Peak 3–9pm is seasonal (Nov–Mar & Jun–Aug only, 8/12 months): annualised over that window,
  // 29.245×8/12 + 5.1535×4/12 ≈ 21.2 c/kWh. Off-peak 5.15. Supply 7.55 metering + 55.34 access.
  Ausgrid: tou(62.89, 21.2, 5.15, [{ fromHour: 15, toHour: 21 }]),
  // Endeavour N71 "Residential Seasonal TOU" (the stated default). Peak 4–8pm business days is
  // seasonal: high 21.796 (Nov–Mar) / low 13.842 (Apr–Oct) → annualised ≈ 17.2. Solar-soak 10am–2pm
  // 3.43. Off-peak 10.49. Supply 63.13.
  Endeavour: tou(63.13, 17.2, 10.49, [{ fromHour: 16, toHour: 20 }], { c: 3.43, windows: [{ fromHour: 10, toHour: 14 }] }),
  // Essential Energy BLNRSS2 "Sun Soaker" (default). Peak 7–10am & 3–10pm daily 16.95; the 10am–3pm
  // solar window is priced as off-peak (5.85), so no separate shoulder. Supply a high 137.76 (rural).
  'Essential Energy': tou(137.76, 16.95, 5.85, [{ fromHour: 7, toHour: 10 }, { fromHour: 15, toHour: 22 }]),
  'Essential Energy Standard': tou(137.76, 16.95, 5.85, [{ fromHour: 7, toHour: 10 }, { fromHour: 15, toHour: 22 }]),
  'Essential Energy Far West': tou(137.76, 16.95, 5.85, [{ fromHour: 7, toHour: 10 }, { fromHour: 15, toHour: 22 }]),

  // ── QLD (2025-26) ────────────────────────────────────────────────────────────
  // Energex 6900 "Residential ToU Energy" (default for new smart meters). Peak 4–9pm 19.37; off-peak
  // (9pm–11am) 4.87; the 11am–4pm solar window is near-free 0.48 (DUOS $0, jurisdictional only).
  // Supply 63.9 (incl 12.1 metering).
  Energex: tou(63.9, 19.37, 4.87, [{ fromHour: 16, toHour: 21 }], { c: 0.48, windows: [{ fromHour: 11, toHour: 16 }] }),
  // Ergon (regional QLD, uniform-tariff area — not researched this cycle; representative estimate).
  Ergon: tou(85, 16, 5, [{ fromHour: 16, toHour: 21 }], { c: 8, windows: [{ fromHour: 21, toHour: 24 }, { fromHour: 0, toHour: 9 }] }),

  // ── VIC (FY2026-27 AER SCS pricing models) — all default to a harmonised TOU: peak 4–9pm,
  // solar-saver 11am–4pm (1.00 c/kWh), off-peak elsewhere; no demand for new residential. ─────────
  Citipower: tou(31.51, 19.76, 4.95, [{ fromHour: 16, toHour: 21 }], { c: 1.0, windows: [{ fromHour: 11, toHour: 16 }] }),
  Powercor: tou(43.84, 22.09, 5.52, [{ fromHour: 16, toHour: 21 }], { c: 1.0, windows: [{ fromHour: 11, toHour: 16 }] }),
  Jemena: tou(33.08, 18.21, 4.55, [{ fromHour: 16, toHour: 21 }], { c: 1.0, windows: [{ fromHour: 11, toHour: 16 }] }),
  'United Energy': tou(31.51, 20.92, 5.22, [{ fromHour: 16, toHour: 21 }], { c: 1.0, windows: [{ fromHour: 11, toHour: 16 }] }),
  'AusNet Services (electricity)': tou(39.81, 26.96, 5.33, [{ fromHour: 16, toHour: 21 }], { c: 1.0, windows: [{ fromHour: 11, toHour: 16 }] }),

  // ── SA (2025-26) ─────────────────────────────────────────────────────────────
  // SA Power Networks RTOU "Residential Time of Use" (default, opt-out). Peak 6–10am & 4pm–12am
  // 18.95; off-peak (12–6am) 9.47; solar-sponge 10am–4pm 4.74. Supply 64.40 (61.85 + 2.55 metering).
  'SA Power Networks': tou(64.4, 18.95, 9.47, [{ fromHour: 6, toHour: 10 }, { fromHour: 16, toHour: 24 }], { c: 4.74, windows: [{ fromHour: 10, toHour: 16 }] }),

  // ── ACT (2025-26) ────────────────────────────────────────────────────────────
  // Evoenergy 017 "New Residential TOU" (opt-out; the demand tariff 023 is the technical default).
  // Peak 7–9am & 5–9pm 16.18; solar-soak 11am–3pm 3.26; off-peak 5.67. Rates incl. ACT LFiT adder.
  // Supply 51.75 (34.98 + 16.77 metering). Prices off NSW1 wholesale.
  Evoenergy: tou(51.75, 16.18, 5.67, [{ fromHour: 7, toHour: 9 }, { fromHour: 17, toHour: 21 }], { c: 3.26, windows: [{ fromHour: 11, toHour: 15 }] }),

  // ── TAS (not researched this cycle; representative estimate) ──────────────────
  TasNetworks: tou(45, 16, 6, [{ fromHour: 7, toHour: 10 }, { fromHour: 16, toHour: 21 }]),
};

/** National-average fallback for any DNSP not in the table above. */
export const DEFAULT_NETWORK_TARIFF: NetworkTariff = tou(80, 16, 5, [{ fromHour: 15, toHour: 21 }]);

export function networkTariffFor(dnsp: string | undefined): NetworkTariff {
  return (dnsp && NETWORK_TARIFFS[dnsp]) || DEFAULT_NETWORK_TARIFF;
}

import type { NemRegion } from './energyModel';

/** NEM wholesale-price region for a distributor (ACT/Evoenergy prices off NSW1). */
export function regionForDnsp(dnsp: string | undefined): NemRegion | null {
  switch (dnsp) {
    case 'Ausgrid':
    case 'Endeavour':
    case 'Essential Energy':
    case 'Essential Energy Standard':
    case 'Essential Energy Far West':
    case 'Evoenergy':
      return 'NSW1';
    case 'Energex':
    case 'Ergon':
      return 'QLD1';
    case 'Citipower':
    case 'Powercor':
    case 'Jemena':
    case 'United Energy':
    case 'AusNet Services (electricity)':
      return 'VIC1';
    case 'SA Power Networks':
      return 'SA1';
    case 'TasNetworks':
      return 'TAS1';
    default:
      return null;
  }
}
