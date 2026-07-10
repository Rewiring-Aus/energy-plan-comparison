import { describe, it, expect } from 'vitest';
import { applianceDailyKwh, DEFAULT_HOME } from '../src/data/applianceProfiles';
import {
  OTHER_ELEC_KWH_DAY,
  SOLAR_DAILY_KWH_PER_KW,
  energyUse,
  getScalingFactor,
  postcodeToState,
  stateForPostcode,
} from '../src/data/energyModel';

describe('RA 2026 energy-model alignment', () => {
  const occ = getScalingFactor(DEFAULT_HOME.occupants); // 3 occupants → 1.03

  it('drives appliance kWh from RA per-state figures × occupancy scaling', () => {
    const a = applianceDailyKwh(
      { ...DEFAULT_HOME, hotWater: 'electric-storage', heating: 'reverse-cycle', cooking: 'electric', aircon: 'some' },
      'NSW',
    );
    expect(a.base).toBeCloseTo(OTHER_ELEC_KWH_DAY.NSW * occ, 6);
    expect(a.hotWater).toBeCloseTo(energyUse('Water Heating', 'Electric resistance', 'NSW') * occ, 6);
    expect(a.cooking).toBeCloseTo(energyUse('Cooktop', 'Electric resistance', 'NSW') * occ, 6);
    expect(a.aircon).toBeCloseTo(energyUse('Space Cooling', 'Heat pump', 'NSW') * occ, 6);
    expect(a.heating).toBeCloseTo(energyUse('Space Heating', 'Electric heat pump', 'NSW') * occ, 6);
  });

  it('heat-pump water uses the heat-pump row (much lower than resistance)', () => {
    const hp = applianceDailyKwh({ ...DEFAULT_HOME, hotWater: 'heat-pump' }, 'VIC');
    expect(hp.hotWater).toBeCloseTo(energyUse('Water Heating', 'Electric heat pump', 'VIC') * occ, 6);
    const res = applianceDailyKwh({ ...DEFAULT_HOME, hotWater: 'electric-storage' }, 'VIC');
    expect(hp.hotWater).toBeLessThan(res.hotWater);
  });

  it('gas/solar appliances contribute no electricity', () => {
    const a = applianceDailyKwh({ ...DEFAULT_HOME, hotWater: 'gas', heating: 'gas', cooking: 'gas', aircon: 'none' }, 'NSW');
    expect(a.hotWater).toBe(0);
    expect(a.heating).toBe(0);
    expect(a.cooking).toBe(0);
    expect(a.aircon).toBe(0);
  });

  it('occupancy scaling is calibrated to 1.0 at the 2.7-occupant average', () => {
    expect(getScalingFactor(2.7)).toBeCloseTo(1.0, 6);
    expect(getScalingFactor(1)).toBeCloseTo(0.56, 6);
    expect(getScalingFactor(5)).toBeCloseTo(1.37, 6);
    expect(getScalingFactor(1)).toBeLessThan(getScalingFactor(4));
  });

  it('state matters: VIC heat-pump heating far exceeds QLD', () => {
    const vic = applianceDailyKwh({ ...DEFAULT_HOME, heating: 'reverse-cycle' }, 'VIC').heating;
    const qld = applianceDailyKwh({ ...DEFAULT_HOME, heating: 'reverse-cycle' }, 'QLD').heating;
    expect(vic).toBeGreaterThan(qld);
  });

  it('ducted cooling exceeds a single split', () => {
    const some = applianceDailyKwh({ ...DEFAULT_HOME, aircon: 'some' }, 'NSW').aircon;
    const ducted = applianceDailyKwh({ ...DEFAULT_HOME, aircon: 'ducted' }, 'NSW').aircon;
    expect(ducted).toBeGreaterThan(some);
  });

  it('resolves postcodes to states, with a national fallback', () => {
    expect(postcodeToState(2000)).toBe('NSW');
    expect(postcodeToState(3000)).toBe('VIC');
    expect(postcodeToState(4000)).toBe('QLD');
    expect(postcodeToState(2600)).toBe('ACT');
    expect(stateForPostcode('9999')).toBe('AUS');
    expect(stateForPostcode(undefined)).toBe('AUS');
  });

  it('per-state solar yield differs (NT sunniest, TAS least of the mainland set)', () => {
    expect(SOLAR_DAILY_KWH_PER_KW.NT).toBeGreaterThan(SOLAR_DAILY_KWH_PER_KW.NSW);
    expect(SOLAR_DAILY_KWH_PER_KW.TAS).toBeLessThan(SOLAR_DAILY_KWH_PER_KW.NSW);
  });
});
