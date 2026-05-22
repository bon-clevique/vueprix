import { describe, expect, it } from 'vitest';
import { computeRequiredMinutes, elapsedMinutes, shouldPost } from './interval-gate.js';

describe('shouldPost', () => {
  const now = new Date('2026-05-22T12:00:00Z');

  it('returns true when lastPostAt is null (no prior post)', () => {
    expect(shouldPost(null, now, 5)).toBe(true);
    expect(shouldPost(null, now, 15)).toBe(true);
  });

  it('returns false when elapsed < required (3 min elapsed, 5 min required)', () => {
    const last = new Date(now.getTime() - 3 * 60 * 1000);
    expect(shouldPost(last, now, 5)).toBe(false);
  });

  it('returns true when elapsed exactly equals required (boundary)', () => {
    const last = new Date(now.getTime() - 5 * 60 * 1000);
    expect(shouldPost(last, now, 5)).toBe(true);
  });

  it('returns true when elapsed >= required (10 min elapsed, 5 min required)', () => {
    const last = new Date(now.getTime() - 10 * 60 * 1000);
    expect(shouldPost(last, now, 5)).toBe(true);
  });

  it('returns false at upper required bound when elapsed just under 15 min', () => {
    // 14分59秒 経過 + 15 分要求 → false
    const last = new Date(now.getTime() - (14 * 60 + 59) * 1000);
    expect(shouldPost(last, now, 15)).toBe(false);
  });

  it('returns true at upper required bound when elapsed >= 15 min', () => {
    const last = new Date(now.getTime() - 15 * 60 * 1000);
    expect(shouldPost(last, now, 15)).toBe(true);
  });
});

describe('computeRequiredMinutes', () => {
  it('returns 5 when rng=0 (lower bound)', () => {
    expect(computeRequiredMinutes(() => 0)).toBe(5);
  });

  it('returns close to 15 when rng→1 (upper bound, exclusive of 15)', () => {
    // Math.random は [0, 1) のため厳密 15 にはならない
    expect(computeRequiredMinutes(() => 0.9999999)).toBeCloseTo(15, 4);
    expect(computeRequiredMinutes(() => 0.9999999)).toBeLessThan(15);
  });

  it('returns 10 when rng=0.5 (midpoint)', () => {
    expect(computeRequiredMinutes(() => 0.5)).toBe(10);
  });

  it('stays within [5, 15) for any rng output', () => {
    for (let i = 0; i < 100; i += 1) {
      const v = computeRequiredMinutes(() => Math.random());
      expect(v).toBeGreaterThanOrEqual(5);
      expect(v).toBeLessThan(15);
    }
  });
});

describe('elapsedMinutes', () => {
  it('returns 0 when same instant', () => {
    const t = new Date('2026-05-22T12:00:00Z');
    expect(elapsedMinutes(t, t)).toBe(0);
  });

  it('returns 7.5 for 7 min 30 sec elapsed', () => {
    const now = new Date('2026-05-22T12:00:00Z');
    const last = new Date(now.getTime() - 7.5 * 60 * 1000);
    expect(elapsedMinutes(last, now)).toBe(7.5);
  });

  it('rounds to 1 decimal place (CI log readability)', () => {
    const now = new Date('2026-05-22T12:00:00Z');
    // 1分3秒 = 1.05 分 → 1.1 (round to 1 decimal)
    const last = new Date(now.getTime() - 63 * 1000);
    expect(elapsedMinutes(last, now)).toBe(1.1);
  });
});
