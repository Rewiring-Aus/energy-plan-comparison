// Default residential time-of-use NETWORK (distribution/DUOS) tariffs per DNSP — the "default
// tariff Amber (and other variable-wholesale retailers) assigns per distributor". Used to model
// variable-wholesale plans as a 24×1h TOU: rate[h] = wholesale[h] + network[h] + fees.
//
// Windows: from WATTever's "Time-of-use periods by network" table. Rates + daily supply: from the
// DNSPs' 2025-26 network price lists — REPRESENTATIVE figures (the network energy component in
// $/kWh, and daily supply in $/day), rounded and calibrated to plausible all-in totals. These are
// approximate; refresh from each DNSP's AER-approved price list annually. Windows use all days
// (weekday/weekend is averaged out elsewhere).

import type { DayType, TouRate } from '../types';

const ALL: DayType[] = ['WEEKDAY', 'WEEKEND'];
const win = (fromHour: number, toHour: number) => ({ dayTypes: ALL, fromHour, toHour });

export interface NetworkTariff {
  supplyPerDay: number; // $/day network supply charge
  touRates: TouRate[]; // network energy component, $/kWh, by window
}

// Helper to build a peak/off-peak (± shoulder) network tariff. Rates in c/kWh for readability.
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
  // NSW
  Ausgrid: tou(110, 21, 4, [{ fromHour: 15, toHour: 21 }]),
  Endeavour: tou(95, 16, 3, [{ fromHour: 13, toHour: 20 }], { c: 6, windows: [{ fromHour: 7, toHour: 13 }, { fromHour: 20, toHour: 22 }] }),
  'Essential Energy': tou(110, 16, 4, [{ fromHour: 17, toHour: 20 }], { c: 6, windows: [{ fromHour: 7, toHour: 17 }, { fromHour: 20, toHour: 22 }] }),
  'Essential Energy Standard': tou(110, 16, 4, [{ fromHour: 17, toHour: 20 }], { c: 6, windows: [{ fromHour: 7, toHour: 17 }, { fromHour: 20, toHour: 22 }] }),
  'Essential Energy Far West': tou(120, 16, 4, [{ fromHour: 17, toHour: 20 }], { c: 6, windows: [{ fromHour: 7, toHour: 17 }, { fromHour: 20, toHour: 22 }] }),
  // QLD
  Energex: tou(75, 18, 3, [{ fromHour: 16, toHour: 21 }], { c: 8, windows: [{ fromHour: 21, toHour: 24 }, { fromHour: 0, toHour: 11 }] }),
  Ergon: tou(85, 16, 5, [{ fromHour: 16, toHour: 21 }], { c: 8, windows: [{ fromHour: 21, toHour: 24 }, { fromHour: 0, toHour: 9 }] }),
  // VIC (five distributors, similar structure — low supply, evening peak)
  Citipower: tou(38, 13, 4, [{ fromHour: 15, toHour: 21 }]),
  Powercor: tou(45, 13, 4, [{ fromHour: 15, toHour: 21 }]),
  Jemena: tou(42, 13, 4, [{ fromHour: 15, toHour: 21 }]),
  'United Energy': tou(40, 13, 4, [{ fromHour: 15, toHour: 21 }]),
  'AusNet Services (electricity)': tou(48, 14, 4, [{ fromHour: 15, toHour: 21 }]),
  // SA — "solar sponge" cheap window 10am–4pm; peak morning + evening
  'SA Power Networks': tou(52, 18, 5, [{ fromHour: 6, toHour: 10 }, { fromHour: 16, toHour: 24 }], { c: 8, windows: [{ fromHour: 0, toHour: 6 }] }),
  // ACT
  Evoenergy: tou(38, 14, 5, [{ fromHour: 7, toHour: 9 }, { fromHour: 17, toHour: 20 }]),
  // TAS
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
