import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { appendHistory, readRecentAsins, type PostHistoryEntry } from './history.js';

const sampleEntry = (overrides: Partial<PostHistoryEntry> = {}): PostHistoryEntry => ({
  timestamp: '2026-05-06T12:00:00.000Z',
  runId: '1714987200000-ab12',
  asin: 'B000',
  title: 'sample product',
  currentPrice: 850,
  referencePrice: 1000,
  dropPercent: 15,
  source: 'fixed',
  category: 'fixed-list',
  posters: { x: true, bluesky: true },
  ...overrides,
});

describe('appendHistory', () => {
  let tmpDir: string;
  let tmpFile: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vueprix-history-'));
    tmpFile = path.join(tmpDir, 'post-history.jsonl');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('appends a single line ending with newline', async () => {
    await appendHistory(sampleEntry(), tmpFile);
    const content = await fs.readFile(tmpFile, 'utf-8');
    expect(content.endsWith('\n')).toBe(true);
    expect(content.split('\n').filter(Boolean)).toHaveLength(1);
  });

  it('does not destroy previous lines when appending again', async () => {
    await appendHistory(sampleEntry({ asin: 'A1' }), tmpFile);
    await appendHistory(sampleEntry({ asin: 'A2' }), tmpFile);
    const content = await fs.readFile(tmpFile, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).asin).toBe('A1');
    expect(JSON.parse(lines[1]!).asin).toBe('A2');
  });

  it('creates parent directory when it does not exist', async () => {
    const nested = path.join(tmpDir, 'a', 'b', 'history.jsonl');
    await appendHistory(sampleEntry(), nested);
    const content = await fs.readFile(nested, 'utf-8');
    expect(JSON.parse(content.trim()).asin).toBe('B000');
  });

  it('truncates very long titles to 200 chars and removes newlines', async () => {
    const longTitle = `${'あ'.repeat(300)}\nbreak\rline`;
    await appendHistory(sampleEntry({ title: longTitle }), tmpFile);
    const parsed = JSON.parse((await fs.readFile(tmpFile, 'utf-8')).trim());
    expect(parsed.title.length).toBe(200);
    expect(parsed.title).not.toMatch(/[\r\n]/);
  });
});

// PR-A3: post-history.jsonl から cooldown 内 ASIN を抽出する secondary 二重投稿ガード。
describe('readRecentAsins', () => {
  let tmpDir: string;
  let tmpFile: string;
  const now = new Date('2026-05-14T12:00:00.000Z');

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vueprix-history-recent-'));
    tmpFile = path.join(tmpDir, 'post-history.jsonl');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns empty Set when file does not exist (ENOENT fail-safe)', async () => {
    const missing = path.join(tmpDir, 'never-created.jsonl');
    const result = await readRecentAsins(now, 24, missing);
    expect(result).toEqual(new Set());
  });

  it('includes ASINs within cooldown window (timestamp >= now - cooldownHours)', async () => {
    // cooldown 24h、cutoff = 2026-05-13T12:00:00.000Z
    await appendHistory(
      sampleEntry({ asin: 'B0RECENT', timestamp: '2026-05-14T00:00:00.000Z' }),  // 12h ago (内)
      tmpFile,
    );
    const result = await readRecentAsins(now, 24, tmpFile);
    expect(result.has('B0RECENT')).toBe(true);
  });

  it('excludes ASINs outside cooldown window', async () => {
    await appendHistory(
      sampleEntry({ asin: 'B0OLD000', timestamp: '2026-05-12T00:00:00.000Z' }),  // 60h ago (外)
      tmpFile,
    );
    await appendHistory(
      sampleEntry({ asin: 'B0RECENT', timestamp: '2026-05-14T00:00:00.000Z' }),
      tmpFile,
    );
    const result = await readRecentAsins(now, 24, tmpFile);
    expect(result.has('B0OLD000')).toBe(false);
    expect(result.has('B0RECENT')).toBe(true);
  });

  it('skips malformed JSON lines and continues parsing the rest', async () => {
    const good = JSON.stringify(sampleEntry({ asin: 'B0GOOD00', timestamp: '2026-05-14T00:00:00.000Z' }));
    const malformed = '{not valid json';
    const partial = JSON.stringify({ timestamp: '2026-05-14T00:00:00.000Z' });  // asin 欠落
    const badTs = JSON.stringify({ asin: 'B0BADTS0', timestamp: 'not-a-date' });
    await fs.writeFile(tmpFile, [good, malformed, partial, badTs, ''].join('\n'), 'utf-8');
    const result = await readRecentAsins(now, 24, tmpFile);
    expect(result.has('B0GOOD00')).toBe(true);
    expect(result.has('B0BADTS0')).toBe(false);
    expect(result.size).toBe(1);
  });

  it('boundary: entry exactly at cutoff (= now - cooldownHours) is included', async () => {
    await appendHistory(
      sampleEntry({ asin: 'B0EDGE00', timestamp: '2026-05-13T12:00:00.000Z' }),  // 24h ちょうど
      tmpFile,
    );
    const result = await readRecentAsins(now, 24, tmpFile);
    expect(result.has('B0EDGE00')).toBe(true);
  });
});
