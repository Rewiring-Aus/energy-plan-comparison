import { describe, it, expect, beforeEach } from 'vitest';
import { useUsageStore } from '../src/store/usageStore';

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const store = () => useUsageStore.getState();

describe('manual profile (drag-to-edit the billed chart)', () => {
  beforeEach(() => {
    store().resetManual();
    store().setHome({ occupants: 3 });
  });

  it('keep-total shift preserves the daily import total (moves energy in time)', () => {
    const before = sum(store().profile.import);
    store().setManualImport(19, 0, true);
    const mp = store().manualProfile;
    expect(mp).not.toBeNull();
    expect(mp!.import[19]).toBeCloseTo(0, 5);
    expect(sum(mp!.import)).toBeCloseTo(before, 4);
  });

  it('free edit sets the hour and changes the total', () => {
    const before = sum(store().profile.import);
    const h19 = store().profile.import[19];
    store().setManualImport(19, 0, false);
    const mp = store().manualProfile!;
    expect(mp.import[19]).toBe(0);
    expect(sum(mp.import)).toBeCloseTo(before - h19, 5);
  });

  it('successive edits compound on the existing override', () => {
    store().setManualImport(12, 5, false);
    store().setManualImport(13, 6, false);
    const mp = store().manualProfile!;
    expect(mp.import[12]).toBe(5);
    expect(mp.import[13]).toBe(6);
  });

  it('leaves the export array untouched when editing import', () => {
    const exp = [...store().profile.export];
    store().setManualImport(8, 9, false);
    const mp = store().manualProfile!;
    expect(mp.import[8]).toBe(9);
    expect(mp.export).toEqual(exp);
  });

  it('resetManual clears the override', () => {
    store().setManualImport(12, 5, false);
    expect(store().manualProfile).not.toBeNull();
    store().resetManual();
    expect(store().manualProfile).toBeNull();
  });

  it('a usage-input change (home) clears the override, but selecting a plan keeps it', () => {
    store().setManualImport(12, 5, false);
    store().setSelectedPlan('some-plan-id');
    expect(store().manualProfile).not.toBeNull(); // shopping the scenario across plans
    store().setHome({ occupants: 4 });
    expect(store().manualProfile).toBeNull(); // re-derived → hand edits invalidated
  });
});
