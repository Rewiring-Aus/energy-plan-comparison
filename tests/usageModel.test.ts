import { describe, it, expect } from 'vitest';
import { synthesizeProfile, periodToDailyKwh, DEFAULT_BEHAVIOURS } from '../src/lib/usageModel';
import { DEFAULT_HOME } from '../src/data/applianceProfiles';
import type { Behaviours, SolarEffectiveness } from '../src/types';

const baseInput = {
  home: DEFAULT_HOME,
  includeSolar: false,
  effectiveness: 'realistic' as SolarEffectiveness,
  behaviours: DEFAULT_BEHAVIOURS,
};

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const withBehaviour = (patch: Partial<Behaviours>): Behaviours => ({ ...DEFAULT_BEHAVIOURS, ...patch });

describe('net profile derivation', () => {
  it('with no solar, import total ≈ gross consumption (matches baseline)', () => {
    const targetDaily = periodToDailyKwh(1800, 'quarterly');
    const d = synthesizeProfile({ ...baseInput, baselineDailyKwh: targetDaily });
    const net = sum(d.profile.import) + d.profile.controlledLoadDailyKwh;
    expect(net).toBeCloseTo(targetDaily, 4);
    expect(sum(d.profile.export)).toBe(0);
  });

  it('routes controlled-load hot water into its own bucket', () => {
    const d = synthesizeProfile({ ...baseInput, home: { ...DEFAULT_HOME, hotWater: 'controlled-load' } });
    expect(d.profile.controlledLoadDailyKwh).toBeGreaterThan(0);
  });

  it('exposes a per-appliance load breakdown summing to gross', () => {
    const home = { ...DEFAULT_HOME, poolPump: true, evCount: 1, evKmPerWeek: 200 };
    const d = synthesizeProfile({ ...baseInput, home });
    for (let h = 0; h < 24; h++) {
      const stacked = (['base', 'hotWater', 'cooking', 'aircon', 'heating', 'pool', 'ev'] as const).reduce(
        (s, k) => s + d.loads[k][h],
        0,
      );
      expect(stacked).toBeCloseTo(d.gross[h], 6);
    }
  });
});

describe('solar effectiveness (rainy-day residual)', () => {
  const solarHome = { ...DEFAULT_HOME, solarKw: 6.6 };
  const midday = [10, 11, 12, 13, 14];
  const derive = (e: SolarEffectiveness) =>
    synthesizeProfile({ ...baseInput, home: solarHome, includeSolar: true, effectiveness: e }).profile;
  const dailyImport = (e: SolarEffectiveness) => derive(e).import.reduce((s, n) => s + n, 0);
  const middayImport = (e: SolarEffectiveness) => midday.reduce((s, h) => s + derive(e).import[h], 0);
  const middayExport = (e: SolarEffectiveness) => midday.reduce((s, h) => s + derive(e).export[h], 0);

  it('leaves more grid import as effectiveness drops (rainy-day residual)', () => {
    expect(dailyImport('conservative')).toBeGreaterThan(dailyImport('optimistic'));
  });
  it('shows a non-zero residual midday import even on Realistic', () => {
    expect(middayImport('realistic')).toBeGreaterThan(0);
    expect(middayImport('conservative')).toBeGreaterThan(middayImport('optimistic'));
  });
  it('optimistic exports more midday than conservative', () => {
    expect(middayExport('optimistic')).toBeGreaterThan(middayExport('conservative'));
  });
});

describe('behaviours: shifting load into the solar soak window', () => {
  const soak = [11, 12, 13];

  it('EV scheduling moves charging into the midday window', () => {
    const home = { ...DEFAULT_HOME, evCount: 1, evKmPerWeek: 250, evCharge: 'evening' as const };
    const soakEv = (b: Behaviours) => {
      const d = synthesizeProfile({ ...baseInput, home, behaviours: b });
      return soak.reduce((s, h) => s + d.loads.ev[h], 0);
    };
    expect(soakEv(withBehaviour({ evScheduled: true }))).toBeGreaterThan(soakEv(DEFAULT_BEHAVIOURS));
  });

  it('a hot-water timer soaks hot water and cuts evening import (with solar)', () => {
    const home = { ...DEFAULT_HOME, solarKw: 6.6 };
    const evening = [17, 18, 19, 20];
    const eveningImport = (b: Behaviours) => {
      const d = synthesizeProfile({ ...baseInput, home, includeSolar: true, behaviours: b });
      return evening.reduce((s, h) => s + d.profile.import[h], 0);
    };
    expect(eveningImport(withBehaviour({ hotWaterTimer: true }))).toBeLessThan(eveningImport(DEFAULT_BEHAVIOURS));
  });

  it('a controlled-load smart timer moves hot water off the CL circuit into gross load', () => {
    const home = { ...DEFAULT_HOME, hotWater: 'controlled-load' as const };
    const off = synthesizeProfile({ ...baseInput, home, behaviours: DEFAULT_BEHAVIOURS });
    const on = synthesizeProfile({ ...baseInput, home, behaviours: withBehaviour({ hotWaterTimer: true }) });
    expect(off.profile.controlledLoadDailyKwh).toBeGreaterThan(0);
    expect(on.profile.controlledLoadDailyKwh).toBe(0);
    expect(soak.reduce((s, h) => s + on.loads.hotWater[h], 0)).toBeGreaterThan(0);
  });

  it('V2G adds usable battery capacity, lowering evening import', () => {
    const home = { ...DEFAULT_HOME, solarKw: 6.6, evCount: 1, evKmPerWeek: 150 };
    const evening = [18, 19, 20];
    const eveningImport = (b: Behaviours) => {
      const d = synthesizeProfile({ ...baseInput, home, includeSolar: true, behaviours: b });
      return evening.reduce((s, h) => s + d.profile.import[h], 0);
    };
    expect(eveningImport(withBehaviour({ v2g: true, v2gKwh: 30 }))).toBeLessThan(eveningImport(DEFAULT_BEHAVIOURS));
  });

  it('V2G still helps WITHOUT solar via off-peak→peak arbitrage', () => {
    const home = { ...DEFAULT_HOME, evCount: 1, evKmPerWeek: 150 }; // no solar
    const evening = [18, 19, 20];
    const eveningImport = (b: Behaviours) => {
      const p = synthesizeProfile({ ...baseInput, home, includeSolar: false, behaviours: b }).profile;
      return evening.reduce((s, h) => s + p.import[h], 0);
    };
    expect(eveningImport(withBehaviour({ v2g: true }))).toBeLessThan(eveningImport(DEFAULT_BEHAVIOURS));
  });
});
