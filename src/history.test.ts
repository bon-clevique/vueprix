import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { appendHistory, type PostHistoryEntry } from './history.js';

const sampleEntry = (overrides: Partial<PostHistoryEntry> = {}): PostHistoryEntry => ({
  timestamp: '2026-05-06T12:00:00.000Z',
  runId: '1714987200000-ab12',
  asin: 'B000',
  title: 'sample product',
  currentPrice: 850,
  referencePrice: 1000,
  dropPercent: 15,
  source: 'fixed',
  reason: 'test reason',
  dryRun: true,
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
