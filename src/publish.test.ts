import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const pagesUpdateMock = vi.fn();
const pagesRetrieveMock = vi.fn();
const blocksAppendMock = vi.fn();
vi.mock('@notionhq/client', () => ({
  Client: class {
    pages = { create: vi.fn(), update: pagesUpdateMock, retrieve: pagesRetrieveMock };
    dataSources = { query: vi.fn() };
    blocks = { children: { append: blocksAppendMock } };
  },
}));

const xPostMock = vi.fn();
const blueskyPostMock = vi.fn();
vi.mock('./posters/x.js', () => ({
  xPoster: { name: 'x', post: xPostMock },
}));
vi.mock('./posters/bluesky.js', () => ({
  blueskyPoster: { name: 'bluesky', post: blueskyPostMock },
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
    blocksAppendMock.mockReset();
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
      Status: { status: { name: 'approved' } },
      ASIN: { rich_text: [{ plain_text: 'B0FKL' }] },
      '名前': { title: [{ plain_text: 'sample' }] },
      '投稿文': { rich_text: [{ plain_text: 'unified post text' }] },
      'Amazon URL': { url: 'https://amzn.example' },
      'セール価格': { number: 850 },
      '通常価格': { number: 1000 },
      '割引率': { number: 0.15 },
      'カテゴリ': { select: { name: 'food' } },
      ...overrides,
    },
  });

  it('sends the same text from 投稿文 property to X and Bluesky', async () => {
    pagesRetrieveMock.mockResolvedValueOnce(buildApprovedPage());
    pagesUpdateMock.mockResolvedValueOnce({});
    xPostMock.mockResolvedValueOnce(undefined);
    blueskyPostMock.mockResolvedValueOnce(undefined);
    const { main } = await import('./publish.js');
    await main(['node', 'publish.ts', '--page-id', '0123456789abcdef0123456789abcdef']);
    expect(xPostMock).toHaveBeenCalledTimes(1);
    expect(blueskyPostMock).toHaveBeenCalledTimes(1);
    const xArg = xPostMock.mock.calls[0]?.[0] as { asin: string; text: string };
    const bskyArg = blueskyPostMock.mock.calls[0]?.[0] as { asin: string; text: string };
    expect(xArg.text).toBe('unified post text');
    expect(bskyArg.text).toBe('unified post text');
    expect(xArg.asin).toBe('B0FKL');
    expect(bskyArg.asin).toBe('B0FKL');
  });

  it('does not mark Status=posted when all posters fail (no failure counter)', async () => {
    pagesRetrieveMock.mockResolvedValueOnce(buildApprovedPage());
    xPostMock.mockRejectedValueOnce(new Error('x failed'));
    blueskyPostMock.mockRejectedValueOnce(new Error('bsky failed'));
    const { main } = await import('./publish.js');
    await main(['node', 'publish.ts', '--page-id', '0123456789abcdef0123456789abcdef']);
    // history は append される (失敗記録)
    expect(appendHistoryMock).toHaveBeenCalledTimes(1);
    // updateStatusToPosted は呼ばれない (approved のまま残す)。
    // incrementFailureCount は廃止されたので pages.update も 1 回も呼ばれない。
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
    expect(arg.properties.Status).toEqual({ status: { name: 'posted' } });
  });

  it('appends X / Bluesky bookmark blocks to the Notion page after posting', async () => {
    pagesRetrieveMock.mockResolvedValueOnce(buildApprovedPage());
    pagesUpdateMock.mockResolvedValueOnce({});
    blocksAppendMock.mockResolvedValueOnce({});
    xPostMock.mockResolvedValueOnce({ url: 'https://twitter.com/i/web/status/111' });
    blueskyPostMock.mockResolvedValueOnce({ url: 'https://bsky.app/profile/vueprix.bsky.social/post/222' });
    const { main } = await import('./publish.js');
    await main(['node', 'publish.ts', '--page-id', '0123456789abcdef0123456789abcdef']);
    expect(blocksAppendMock).toHaveBeenCalledTimes(1);
    const arg = blocksAppendMock.mock.calls[0]?.[0] as {
      block_id: string;
      children: Array<{ type: string; bookmark: { url: string } }>;
    };
    expect(arg.block_id).toBe('0123456789abcdef0123456789abcdef');
    expect(arg.children.map((c) => c.bookmark.url)).toEqual([
      'https://twitter.com/i/web/status/111',
      'https://bsky.app/profile/vueprix.bsky.social/post/222',
    ]);
  });

  it('appends only the X bookmark when Bluesky fails', async () => {
    pagesRetrieveMock.mockResolvedValueOnce(buildApprovedPage());
    pagesUpdateMock.mockResolvedValueOnce({});
    blocksAppendMock.mockResolvedValueOnce({});
    xPostMock.mockResolvedValueOnce({ url: 'https://twitter.com/i/web/status/111' });
    blueskyPostMock.mockRejectedValueOnce(new Error('bsky down'));
    const { main } = await import('./publish.js');
    await main(['node', 'publish.ts', '--page-id', '0123456789abcdef0123456789abcdef']);
    expect(blocksAppendMock).toHaveBeenCalledTimes(1);
    const arg = blocksAppendMock.mock.calls[0]?.[0] as { children: unknown[] };
    expect(arg.children).toHaveLength(1);
  });

  it('returns early without throwing when page is not approved', async () => {
    pagesRetrieveMock.mockResolvedValueOnce(
      buildApprovedPage({ Status: { status: { name: 'backlog' } } }),
    );
    const { main } = await import('./publish.js');
    await expect(
      main(['node', 'publish.ts', '--page-id', '0123456789abcdef0123456789abcdef']),
    ).resolves.toBeUndefined();
    expect(xPostMock).not.toHaveBeenCalled();
    expect(pagesUpdateMock).not.toHaveBeenCalled();
  });

  it('returns early when Status=approved but 投稿日時 already set (二重ガード)', async () => {
    pagesRetrieveMock.mockResolvedValueOnce(
      buildApprovedPage({
        '投稿日時': { date: { start: '2026-05-09T14:00:00.000Z' } },
      }),
    );
    const { main } = await import('./publish.js');
    await expect(
      main(['node', 'publish.ts', '--page-id', '0123456789abcdef0123456789abcdef']),
    ).resolves.toBeUndefined();
    expect(xPostMock).not.toHaveBeenCalled();
    expect(blueskyPostMock).not.toHaveBeenCalled();
    expect(pagesUpdateMock).not.toHaveBeenCalled();
    expect(appendHistoryMock).not.toHaveBeenCalled();
  });

  it('returns early when 投稿文 is empty (Notion AI 運用: 文言未生成のまま approved に遷移)', async () => {
    pagesRetrieveMock.mockResolvedValueOnce(
      buildApprovedPage({
        '投稿文': { rich_text: [{ plain_text: '   ' }] }, // whitespace only
      }),
    );
    const { main } = await import('./publish.js');
    await main(['node', 'publish.ts', '--page-id', '0123456789abcdef0123456789abcdef']);
    expect(xPostMock).not.toHaveBeenCalled();
    expect(blueskyPostMock).not.toHaveBeenCalled();
    expect(pagesUpdateMock).not.toHaveBeenCalled();
    expect(appendHistoryMock).not.toHaveBeenCalled();
  });

  it('returns early when 投稿文 exceeds 280 chars (X char limit; prevent silent X data loss)', async () => {
    // 280 chars 超だと X は失敗 / Bluesky は 300 chars 上限内で成功する。anySucceeded=true で
    // Status=posted に遷移し X への投稿が永久に失われる silent data loss を防ぐため refuse する。
    const longText = 'あ'.repeat(281);
    pagesRetrieveMock.mockResolvedValueOnce(
      buildApprovedPage({
        '投稿文': { rich_text: [{ plain_text: longText }] },
      }),
    );
    const { main } = await import('./publish.js');
    await main(['node', 'publish.ts', '--page-id', '0123456789abcdef0123456789abcdef']);
    expect(xPostMock).not.toHaveBeenCalled();
    expect(blueskyPostMock).not.toHaveBeenCalled();
    expect(pagesUpdateMock).not.toHaveBeenCalled();
    expect(appendHistoryMock).not.toHaveBeenCalled();
  });

  it('accepts 投稿文 exactly at 280 chars (boundary)', async () => {
    const exactText = 'あ'.repeat(280);
    pagesRetrieveMock.mockResolvedValueOnce(
      buildApprovedPage({
        '投稿文': { rich_text: [{ plain_text: exactText }] },
      }),
    );
    pagesUpdateMock.mockResolvedValueOnce({});
    xPostMock.mockResolvedValueOnce(undefined);
    blueskyPostMock.mockResolvedValueOnce(undefined);
    const { main } = await import('./publish.js');
    await main(['node', 'publish.ts', '--page-id', '0123456789abcdef0123456789abcdef']);
    expect(xPostMock).toHaveBeenCalledTimes(1);
    expect(blueskyPostMock).toHaveBeenCalledTimes(1);
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
    pagesRetrieveMock.mockResolvedValue(buildApprovedPage());
    pagesUpdateMock.mockResolvedValue({});
    xPostMock.mockResolvedValue(undefined);
    blueskyPostMock.mockResolvedValue(undefined);
    const { main } = await import('./publish.js');
    await expect(
      main(['node', 'publish.ts', '--page-id', '01234567-89ab-cdef-0123-456789abcdef']),
    ).resolves.toBeUndefined();
    await expect(
      main(['node', 'publish.ts', '--page-id', '0123456789abcdef0123456789abcdef']),
    ).resolves.toBeUndefined();
  });
});
