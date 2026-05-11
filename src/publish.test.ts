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
      // PR-8: Status は status type (旧: select)
      Status: { status: { name: 'approved' } },
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
      ...overrides,
    },
  });

  it('does not mark Status=posted when all posters fail, but increments failure count', async () => {
    // fetchPageById の retrieve + incrementFailureCount の retrieve の 2 回分
    pagesRetrieveMock.mockResolvedValueOnce(buildApprovedPage());
    pagesRetrieveMock.mockResolvedValueOnce({
      id: 'page-1',
      properties: { '投稿失敗回数': { number: 0 } },
    });
    pagesUpdateMock.mockResolvedValueOnce({});
    xPostMock.mockRejectedValueOnce(new Error('x failed'));
    blueskyPostMock.mockRejectedValueOnce(new Error('bsky failed'));
    const { main } = await import('./publish.js');
    await main(['node', 'publish.ts', '--page-id', '0123456789abcdef0123456789abcdef']);
    // history は append される (失敗記録)
    expect(appendHistoryMock).toHaveBeenCalledTimes(1);
    // updateStatusToPosted は呼ばれない (approved のまま残す)。
    // ただし incrementFailureCount の update が 1 回呼ばれる。
    expect(pagesUpdateMock).toHaveBeenCalledTimes(1);
    const arg = pagesUpdateMock.mock.calls[0]?.[0] as { properties: Record<string, unknown> };
    // failure count = 1 (前回 0 + 1)、blocked 未到達なので Status update なし
    expect(arg.properties['投稿失敗回数']).toEqual({ number: 1 });
    expect(arg.properties.Status).toBeUndefined();
    // 最終エラー は dispatch result (poster→bool map) の JSON 文字列
    const richText = arg.properties['最終エラー'] as {
      rich_text: Array<{ text: { content: string } }>;
    };
    const content = richText.rich_text[0]?.text.content ?? '';
    expect(content).toBe('{"x":false,"bluesky":false}');
  });

  it('transitions Status=blocked after MAX_PUBLISH_FAILURES (3rd consecutive failure)', async () => {
    pagesRetrieveMock.mockResolvedValueOnce(buildApprovedPage());
    // 既に 2 回失敗済 → 3 回目で blocked
    pagesRetrieveMock.mockResolvedValueOnce({
      id: 'page-1',
      properties: { '投稿失敗回数': { number: 2 } },
    });
    pagesUpdateMock.mockResolvedValueOnce({});
    xPostMock.mockRejectedValueOnce(new Error('x failed'));
    blueskyPostMock.mockRejectedValueOnce(new Error('bsky failed'));
    const { main } = await import('./publish.js');
    await main(['node', 'publish.ts', '--page-id', '0123456789abcdef0123456789abcdef']);
    expect(pagesUpdateMock).toHaveBeenCalledTimes(1);
    const arg = pagesUpdateMock.mock.calls[0]?.[0] as { properties: Record<string, unknown> };
    expect(arg.properties['投稿失敗回数']).toEqual({ number: 3 });
    // PR-8: Status は status type
    expect(arg.properties.Status).toEqual({ status: { name: 'blocked' } });
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
    // PR-8: Status は status type
    expect(arg.properties.Status).toEqual({ status: { name: 'posted' } });
  });

  it('returns early without throwing when page is not approved', async () => {
    pagesRetrieveMock.mockResolvedValueOnce(
      // PR-8: Status は status type
      buildApprovedPage({ Status: { status: { name: 'pending_review' } } }),
    );
    const { main } = await import('./publish.js');
    await expect(
      main(['node', 'publish.ts', '--page-id', '0123456789abcdef0123456789abcdef']),
    ).resolves.toBeUndefined();
    expect(xPostMock).not.toHaveBeenCalled();
    expect(pagesUpdateMock).not.toHaveBeenCalled();
  });

  it('returns early when Status=approved but 投稿日時 already set (二重ガード)', async () => {
    // posted→approved 戻し race のシミュレーション。
    // Status は approved だが「投稿日時」が既にセット済 → fetchPageById は通すが
    // publish.ts の追加 guard で early return → posters 未呼び出し + Status update なし。
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

  it('returns early when 理由 is empty (Notion AI 運用: 文言未生成のまま approved に遷移した場合)', async () => {
    // ドラフト作成時に 理由 / 投稿文_X / 投稿文_Bluesky は '' で入る。Notion AI で文言を
    // 埋めずに approved にすると buildPostText が空 reason で壊れた投稿を生成する。
    // publish 側 guard で early return することを確認。Status は approved のまま残し再投稿を許す。
    pagesRetrieveMock.mockResolvedValueOnce(
      buildApprovedPage({
        '理由': { rich_text: [{ plain_text: '   ' }] }, // whitespace only
      }),
    );
    const { main } = await import('./publish.js');
    await main(['node', 'publish.ts', '--page-id', '0123456789abcdef0123456789abcdef']);
    expect(xPostMock).not.toHaveBeenCalled();
    expect(blueskyPostMock).not.toHaveBeenCalled();
    expect(pagesUpdateMock).not.toHaveBeenCalled();
    expect(appendHistoryMock).not.toHaveBeenCalled();
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
    // PR-8: DryRun 廃止後は posters 成功シナリオで両 UUID 形式が受理されることを確認。
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
