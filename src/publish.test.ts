import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const pagesUpdateMock = vi.fn();
const pagesRetrieveMock = vi.fn();
vi.mock('@notionhq/client', () => ({
  Client: class {
    pages = { create: vi.fn(), update: pagesUpdateMock, retrieve: pagesRetrieveMock };
    dataSources = { query: vi.fn() };
  },
}));

const xPostMock = vi.fn();
const blueskyPostMock = vi.fn();
vi.mock('./posters/x.js', () => ({
  xPoster: { name: 'x', maxChars: 280, post: xPostMock },
}));
vi.mock('./posters/bluesky.js', () => ({
  blueskyPoster: { name: 'bluesky', maxChars: 300, post: blueskyPostMock },
}));

const appendHistoryMock = vi.fn();
vi.mock('./history.js', () => ({
  appendHistory: appendHistoryMock,
}));

describe('publish entrypoint', () => {
  const originalKey = process.env.NOTION_API_KEY;
  const originalDs = process.env.NOTION_VUEPRIX_DATA_SOURCE_ID;

  beforeEach(() => {
    pagesUpdateMock.mockReset();
    pagesRetrieveMock.mockReset();
    xPostMock.mockReset();
    blueskyPostMock.mockReset();
    appendHistoryMock.mockReset();
    process.env.NOTION_API_KEY = 'secret_xxx';
    process.env.NOTION_VUEPRIX_DATA_SOURCE_ID = 'ds-uuid';
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.NOTION_API_KEY;
    else process.env.NOTION_API_KEY = originalKey;
    if (originalDs === undefined) delete process.env.NOTION_VUEPRIX_DATA_SOURCE_ID;
    else process.env.NOTION_VUEPRIX_DATA_SOURCE_ID = originalDs;
  });

  const buildApprovedPage = (overrides: Record<string, unknown> = {}) => ({
    id: 'page-1',
    properties: {
      Status: { select: { name: 'approved' } },
      ASIN: { rich_text: [{ plain_text: 'B0FKL' }] },
      '名前': { title: [{ plain_text: 'sample' }] },
      '投稿文_X': { rich_text: [{ plain_text: 'X text' }] },
      '投稿文_Bluesky': { rich_text: [{ plain_text: 'Bluesky text' }] },
      '理由': { rich_text: [{ plain_text: 'reason' }] },
      'Amazon URL': { url: 'https://amzn.example' },
      'セール価格': { number: 850 },
      '通常価格': { number: 1000 },
      '割引率': { number: 0.15 },
      'カテゴリ': { select: { name: 'food' } },
      DryRun: { checkbox: false },
      ...overrides,
    },
  });

  it('skips posters and marks Status=posted when DryRun=true', async () => {
    pagesRetrieveMock.mockResolvedValueOnce(
      buildApprovedPage({ DryRun: { checkbox: true } }),
    );
    pagesUpdateMock.mockResolvedValueOnce({});
    const { main } = await import('./publish.js');
    await main(['node', 'publish.ts', '--page-id', '0123456789abcdef0123456789abcdef']);
    expect(xPostMock).not.toHaveBeenCalled();
    expect(blueskyPostMock).not.toHaveBeenCalled();
    expect(pagesUpdateMock).toHaveBeenCalledTimes(1);
    const arg = pagesUpdateMock.mock.calls[0]?.[0] as { properties: Record<string, unknown> };
    expect(arg.properties.Status).toEqual({ select: { name: 'posted' } });
  });

  it('does not mark Status=posted when all posters fail', async () => {
    pagesRetrieveMock.mockResolvedValueOnce(buildApprovedPage());
    xPostMock.mockRejectedValueOnce(new Error('x failed'));
    blueskyPostMock.mockRejectedValueOnce(new Error('bsky failed'));
    const { main } = await import('./publish.js');
    await main(['node', 'publish.ts', '--page-id', '0123456789abcdef0123456789abcdef']);
    // history は append される (失敗記録)
    expect(appendHistoryMock).toHaveBeenCalledTimes(1);
    // updateStatusToPosted は呼ばれない (approved のまま残す)
    expect(pagesUpdateMock).not.toHaveBeenCalled();
  });

  it('marks Status=posted when at least one poster succeeds', async () => {
    pagesRetrieveMock.mockResolvedValueOnce(buildApprovedPage());
    pagesUpdateMock.mockResolvedValueOnce({});
    xPostMock.mockResolvedValueOnce(undefined);
    blueskyPostMock.mockRejectedValueOnce(new Error('bsky down'));
    const { main } = await import('./publish.js');
    await main(['node', 'publish.ts', '--page-id', '0123456789abcdef0123456789abcdef']);
    expect(pagesUpdateMock).toHaveBeenCalledTimes(1);
    const arg = pagesUpdateMock.mock.calls[0]?.[0] as { properties: Record<string, unknown> };
    expect(arg.properties.Status).toEqual({ select: { name: 'posted' } });
  });

  it('returns early without throwing when page is not approved', async () => {
    pagesRetrieveMock.mockResolvedValueOnce(
      buildApprovedPage({ Status: { select: { name: 'pending_review' } } }),
    );
    const { main } = await import('./publish.js');
    await expect(
      main(['node', 'publish.ts', '--page-id', '0123456789abcdef0123456789abcdef']),
    ).resolves.toBeUndefined();
    expect(xPostMock).not.toHaveBeenCalled();
    expect(pagesUpdateMock).not.toHaveBeenCalled();
  });

  it('throws when --page-id is missing', async () => {
    const { main } = await import('./publish.js');
    await expect(main(['node', 'publish.ts'])).rejects.toThrow(/--page-id/);
  });

  it('throws when --page-id is not a valid UUID (HIGH-1: script injection guard)', async () => {
    const { main } = await import('./publish.js');
    await expect(
      main(['node', 'publish.ts', '--page-id', 'x"; rm -rf /; echo "']),
    ).rejects.toThrow(/UUID/);
    await expect(
      main(['node', 'publish.ts', '--page-id', 'not-a-uuid']),
    ).rejects.toThrow(/UUID/);
  });

  it('accepts both dashed and undashed UUID formats', async () => {
    pagesRetrieveMock.mockResolvedValue(
      buildApprovedPage({ DryRun: { checkbox: true } }),
    );
    pagesUpdateMock.mockResolvedValue({});
    const { main } = await import('./publish.js');
    await expect(
      main(['node', 'publish.ts', '--page-id', '01234567-89ab-cdef-0123-456789abcdef']),
    ).resolves.toBeUndefined();
    await expect(
      main(['node', 'publish.ts', '--page-id', '0123456789abcdef0123456789abcdef']),
    ).resolves.toBeUndefined();
  });
});
