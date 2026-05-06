import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  calcDropPercent,
  isAlreadyPosted,
  isGoodDeal,
  loadPosted,
  markAsPosted,
  prunePosted,
  savePosted,
  type PostedRecord,
} from './filter.js';

describe('isGoodDeal', () => {
  it('returns true when drop meets default 15% threshold', () => {
    expect(isGoodDeal(850, 1000)).toBe(true); // 15% drop exactly
  });

  it('returns false when drop is below threshold', () => {
    expect(isGoodDeal(900, 1000)).toBe(false); // 10% drop
  });

  it('returns true on large drop', () => {
    expect(isGoodDeal(500, 1000)).toBe(true); // 50% drop
  });

  it('returns false for non-positive prices', () => {
    expect(isGoodDeal(0, 1000)).toBe(false);
    expect(isGoodDeal(500, 0)).toBe(false);
    expect(isGoodDeal(-1, 100)).toBe(false);
  });

  it('respects custom threshold', () => {
    expect(isGoodDeal(950, 1000, 5)).toBe(true);
    expect(isGoodDeal(950, 1000, 10)).toBe(false);
  });
});

describe('calcDropPercent', () => {
  it('returns rounded percent', () => {
    expect(calcDropPercent(850, 1000)).toBe(15);
    expect(calcDropPercent(833, 1000)).toBe(17);
  });

  it('returns 0 for zero reference', () => {
    expect(calcDropPercent(500, 0)).toBe(0);
  });
});

describe('isAlreadyPosted', () => {
  const now = new Date('2026-05-06T12:00:00.000Z');

  it('returns false when asin not in record', () => {
    expect(isAlreadyPosted('B000', {}, now)).toBe(false);
  });

  it('returns true within 24h cooldown', () => {
    const posted: PostedRecord = { B000: '2026-05-06T00:00:00.000Z' }; // 12h ago
    expect(isAlreadyPosted('B000', posted, now)).toBe(true);
  });

  it('returns false past 24h cooldown', () => {
    const posted: PostedRecord = { B000: '2026-05-05T00:00:00.000Z' }; // 36h ago
    expect(isAlreadyPosted('B000', posted, now)).toBe(false);
  });

  it('returns false on invalid timestamp', () => {
    const posted: PostedRecord = { B000: 'not-a-date' };
    expect(isAlreadyPosted('B000', posted, now)).toBe(false);
  });
});

describe('markAsPosted', () => {
  it('returns new record with iso timestamp', () => {
    const now = new Date('2026-05-06T12:00:00.000Z');
    const result = markAsPosted('B001', {}, now);
    expect(result).toEqual({ B001: '2026-05-06T12:00:00.000Z' });
  });

  it('does not mutate the original record', () => {
    const original: PostedRecord = { B000: '2026-05-05T00:00:00.000Z' };
    const result = markAsPosted('B001', original, new Date('2026-05-06T12:00:00.000Z'));
    expect(original).toEqual({ B000: '2026-05-05T00:00:00.000Z' });
    expect(result).toHaveProperty('B000');
    expect(result).toHaveProperty('B001');
  });
});

describe('prunePosted', () => {
  it('removes entries older than cooldown window', () => {
    const now = new Date('2026-05-06T12:00:00.000Z');
    const posted: PostedRecord = {
      old: '2026-05-04T00:00:00.000Z', // 60h ago
      recent: '2026-05-06T06:00:00.000Z', // 6h ago
    };
    const result = prunePosted(posted, now);
    expect(result).toEqual({ recent: '2026-05-06T06:00:00.000Z' });
  });

  it('drops invalid timestamps', () => {
    const now = new Date('2026-05-06T12:00:00.000Z');
    const posted: PostedRecord = { bad: 'not-a-date' };
    expect(prunePosted(posted, now)).toEqual({});
  });
});

describe('loadPosted / savePosted', () => {
  let tmpDir: string;
  let tmpFile: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vueprix-'));
    tmpFile = path.join(tmpDir, 'posted.json');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns empty object when file does not exist', async () => {
    const result = await loadPosted(tmpFile);
    expect(result).toEqual({});
  });

  it('roundtrips data through save and load', async () => {
    const data: PostedRecord = { B100: '2026-05-06T12:00:00.000Z' };
    await savePosted(data, tmpFile);
    const result = await loadPosted(tmpFile);
    expect(result).toEqual(data);
  });

  it('returns empty object for non-object json', async () => {
    await fs.writeFile(tmpFile, JSON.stringify(['not', 'an', 'object']), 'utf-8');
    const result = await loadPosted(tmpFile);
    expect(result).toEqual({});
  });
});
