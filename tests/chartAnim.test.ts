import { describe, expect, it } from 'vitest';
import { easeOutCubic, lerpArray, niceTicks } from '../src/lib/chartAnim';

describe('easeOutCubic', () => {
  it('hits the endpoints and clamps', () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(-1)).toBe(0);
    expect(easeOutCubic(2)).toBe(1);
  });
  it('front-loads progress', () => {
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
  });
});

describe('lerpArray', () => {
  it('interpolates element-wise', () => {
    expect(lerpArray([0, 10], [10, 20], 0.5)).toEqual([5, 15]);
  });
  it('grows missing start values from 0 and takes the target length', () => {
    expect(lerpArray([4], [8, 6, 2], 0.5)).toEqual([6, 3, 1]);
    expect(lerpArray([1, 2, 3], [5], 1)).toEqual([5]);
  });
});

describe('niceTicks', () => {
  it('uses 1/2/5 steps and never exceeds max', () => {
    expect(niceTicks(3.7)).toEqual([0, 1, 2, 3]);
    expect(niceTicks(0.6)).toEqual([0, 0.2, 0.4, 0.6]);
    expect(niceTicks(9)).toEqual([0, 2, 4, 6, 8]);
    expect(niceTicks(12)).toEqual([0, 5, 10]);
  });
  it('is float-clean', () => {
    for (const t of niceTicks(0.7)) expect(String(t).length).toBeLessThan(5);
  });
  it('handles degenerate input', () => {
    expect(niceTicks(0)).toEqual([0]);
    expect(niceTicks(NaN)).toEqual([0]);
  });
});
