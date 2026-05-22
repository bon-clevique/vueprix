import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const pagesUpdateMock = vi.fn();
const pagesRetrieveMock = vi.fn();
const blocksAppendMock = vi.fn();
const dataSourcesQueryMock = vi.fn();
vi.mock('@notionhq/client', () => ({
  Client: class {
    pages = { create: vi.fn(), update: pagesUpdateMock, retrieve: pagesRetrieveMock };
    dataSources = { query: dataSourcesQueryMock };
    blocks = { children: { append: blocksAppendMock } };
  },
}));

const xPostMock = vi.fn();
const blueskyPostMock = vi.fn();
const getLatestSelfPostAtMock = vi.fn();
vi.mock('./posters/x.js', () => ({
  xPoster: { name: 'x', post: xPostMock },
}));
vi.mock('./posters/bluesky.js', () => ({
  blueskyPoster: { name: 'bluesky', post: blueskyPostMock },
  getLatestSelfPostAt: getLatestSelfPostAtMock,
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
    dataSourcesQueryMock.mockReset();
    // 既存 single-page test の前提として queryApprovedPageIds は空配列を返す
    // (--page-id 指定時は drain mode 経由しないので呼ばれないはず)。
    dataSourcesQueryMock.mockResolvedValue({ results: [], has_more: false });
    xPostMock.mockReset();
    blueskyPostMock.mockReset();
    getLatestSelfPostAtMock.mockReset();
    appendHistoryMock.mockReset();
    process.env.NOTION_API_KEY = 'secret_xxx';
    process.env.NOTION_VUEPRIX_DATA_SOURCE_ID = 'ds-uuid';
    // 既存 test 全体の前提として「interval gate は素通り」(古い lastPostAt) にしておく。
    // gate 動作自体は別の describe block で個別 verify。
    getLatestSelfPostAtMock.mockResolvedValue(new Date('2026-05-22T00:00:00Z'));
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

  // PR-1 Phase 2: 旧「片方成功で Status=posted」挙動を撤廃。新挙動は per-platform 制御で
  // 「両成功時のみ Status=posted、片方失敗時は approved のまま + 成功 checkbox のみ true」。
  it('marks Status=posted only when both posters succeed', async () => {
    pagesRetrieveMock.mockResolvedValueOnce(buildApprovedPage());
    pagesUpdateMock.mockResolvedValueOnce({});
    xPostMock.mockResolvedValueOnce(undefined);
    blueskyPostMock.mockResolvedValueOnce(undefined);
    const { main } = await import('./publish.js');
    await main(['node', 'publish.ts', '--page-id', '0123456789abcdef0123456789abcdef']);
    expect(pagesUpdateMock).toHaveBeenCalledTimes(1);
    const arg = pagesUpdateMock.mock.calls[0]?.[0] as { properties: Record<string, unknown> };
    expect(arg.properties.Status).toEqual({ status: { name: 'posted' } });
    expect(arg.properties.x_posted).toEqual({ checkbox: true });
    expect(arg.properties.bluesky_posted).toEqual({ checkbox: true });
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

  // PR-1 Phase 2: X 成功 + BSky 失敗時、Status は approved のまま (旧: posted 遷移)、
  // x_posted のみ true、bookmark は X 1 件のみ。次回 publish で BSky retry できる。
  it('keeps Status=approved + sets only x_posted=true + appends only X bookmark when Bluesky fails', async () => {
    pagesRetrieveMock.mockResolvedValueOnce(buildApprovedPage());
    pagesUpdateMock.mockResolvedValueOnce({});
    blocksAppendMock.mockResolvedValueOnce({});
    xPostMock.mockResolvedValueOnce({ url: 'https://twitter.com/i/web/status/111' });
    blueskyPostMock.mockRejectedValueOnce(new Error('bsky down'));
    const { main } = await import('./publish.js');
    await main(['node', 'publish.ts', '--page-id', '0123456789abcdef0123456789abcdef']);
    expect(pagesUpdateMock).toHaveBeenCalledTimes(1);
    const arg = pagesUpdateMock.mock.calls[0]?.[0] as { properties: Record<string, unknown> };
    expect(arg.properties.Status).toBeUndefined();
    expect(arg.properties['投稿日時']).toBeUndefined();
    expect(arg.properties.x_posted).toEqual({ checkbox: true });
    expect(arg.properties.bluesky_posted).toBeUndefined();
    // bookmark は X 1 件のみ
    expect(blocksAppendMock).toHaveBeenCalledTimes(1);
    const blocksArg = blocksAppendMock.mock.calls[0]?.[0] as { children: unknown[] };
    expect(blocksArg.children).toHaveLength(1);
  });

  // PR-1 Phase 2: 新規 3 ケース pin
  // (a) xPosted=true で X poster 未起動 + Bluesky のみ dispatch (両成功で Status=posted)
  it('skips X poster when xPosted=true (re-run with X already posted, retry only Bluesky)', async () => {
    pagesRetrieveMock.mockResolvedValueOnce(
      buildApprovedPage({ x_posted: { checkbox: true } }),
    );
    pagesUpdateMock.mockResolvedValueOnce({});
    blueskyPostMock.mockResolvedValueOnce({ url: 'https://bsky.app/profile/vueprix.bsky.social/post/222' });
    const { main } = await import('./publish.js');
    await main(['node', 'publish.ts', '--page-id', '0123456789abcdef0123456789abcdef']);
    // X poster は起動しない
    expect(xPostMock).not.toHaveBeenCalled();
    // Bluesky のみ dispatch
    expect(blueskyPostMock).toHaveBeenCalledTimes(1);
    // filteredPosters = [bluesky] のみ → allRequiredSucceeded=true → Status=posted
    expect(pagesUpdateMock).toHaveBeenCalledTimes(1);
    const arg = pagesUpdateMock.mock.calls[0]?.[0] as { properties: Record<string, unknown> };
    expect(arg.properties.Status).toEqual({ status: { name: 'posted' } });
    expect(arg.properties.bluesky_posted).toEqual({ checkbox: true });
    // x_posted は触らない (dispatch 対象外、result.x が undefined)
    expect(arg.properties.x_posted).toBeUndefined();
  });

  // (b) 両 xPosted=blueskyPosted=false 起点 + 両成功 → Status=posted + 両 checkbox=true
  it('marks Status=posted when both posters succeed from fresh state', async () => {
    pagesRetrieveMock.mockResolvedValueOnce(buildApprovedPage());
    pagesUpdateMock.mockResolvedValueOnce({});
    xPostMock.mockResolvedValueOnce({ url: 'https://twitter.com/i/web/status/111' });
    blueskyPostMock.mockResolvedValueOnce({ url: 'https://bsky.app/profile/vueprix.bsky.social/post/222' });
    const { main } = await import('./publish.js');
    await main(['node', 'publish.ts', '--page-id', '0123456789abcdef0123456789abcdef']);
    expect(xPostMock).toHaveBeenCalledTimes(1);
    expect(blueskyPostMock).toHaveBeenCalledTimes(1);
    expect(pagesUpdateMock).toHaveBeenCalledTimes(1);
    const arg = pagesUpdateMock.mock.calls[0]?.[0] as { properties: Record<string, unknown> };
    expect(arg.properties.Status).toEqual({ status: { name: 'posted' } });
    expect(arg.properties.x_posted).toEqual({ checkbox: true });
    expect(arg.properties.bluesky_posted).toEqual({ checkbox: true });
  });

  // (c) 両 false 起点 + X 失敗 BSky 成功 → Status=approved 維持 + bluesky_posted=true + BSky bookmark のみ
  it('keeps Status=approved when X fails but BSky succeeds (per-platform retry)', async () => {
    pagesRetrieveMock.mockResolvedValueOnce(buildApprovedPage());
    pagesUpdateMock.mockResolvedValueOnce({});
    blocksAppendMock.mockResolvedValueOnce({});
    xPostMock.mockRejectedValueOnce(new Error('x down'));
    blueskyPostMock.mockResolvedValueOnce({ url: 'https://bsky.app/profile/vueprix.bsky.social/post/222' });
    const { main } = await import('./publish.js');
    await main(['node', 'publish.ts', '--page-id', '0123456789abcdef0123456789abcdef']);
    expect(pagesUpdateMock).toHaveBeenCalledTimes(1);
    const arg = pagesUpdateMock.mock.calls[0]?.[0] as { properties: Record<string, unknown> };
    expect(arg.properties.Status).toBeUndefined();
    expect(arg.properties['投稿日時']).toBeUndefined();
    expect(arg.properties.x_posted).toBeUndefined();
    expect(arg.properties.bluesky_posted).toEqual({ checkbox: true });
    // BSky bookmark のみ
    expect(blocksAppendMock).toHaveBeenCalledTimes(1);
    const blocksArg = blocksAppendMock.mock.calls[0]?.[0] as {
      children: Array<{ type: string; bookmark: { url: string } }>;
    };
    expect(blocksArg.children).toEqual([
      { object: 'block', type: 'bookmark', bookmark: { url: 'https://bsky.app/profile/vueprix.bsky.social/post/222' } },
    ]);
  });

  // PR-1 Phase 2: 両 xPosted=blueskyPosted=true (異常運用) → 何も dispatch せず early return
  it('does nothing when both platforms are already posted (filteredPosters empty)', async () => {
    pagesRetrieveMock.mockResolvedValueOnce(
      buildApprovedPage({
        x_posted: { checkbox: true },
        bluesky_posted: { checkbox: true },
      }),
    );
    const { main } = await import('./publish.js');
    await main(['node', 'publish.ts', '--page-id', '0123456789abcdef0123456789abcdef']);
    expect(xPostMock).not.toHaveBeenCalled();
    expect(blueskyPostMock).not.toHaveBeenCalled();
    expect(pagesUpdateMock).not.toHaveBeenCalled();
    expect(appendHistoryMock).not.toHaveBeenCalled();
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

  it('returns early when 投稿文 exceeds X weighted 280 (prevent silent X data loss)', async () => {
    // X は weighted character count (CJK / emoji = 2、URL = 23 固定) で 280 上限。
    // 旧 gate (`[...str].length > 280`) は code point だったため CJK 多い文を取りこぼしていた。
    // 'あ' × 141 = weighted 282 > 280 で X reject、Bluesky は 300 上限内で成功 → silent data loss。
    const longText = 'あ'.repeat(141);
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

  it('accepts 投稿文 exactly at X weighted 280 (boundary)', async () => {
    // ASCII 'a' × 280 = weighted 280 (上限ちょうど)。
    const exactText = 'a'.repeat(280);
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

  it('refuses real-world buggy row: codepoint 207 / X weighted 292 (regression pin)', async () => {
    // 実バグ row (Index 366 / ミツウロコ麦茶 / 2026-05-16):
    // - codepoint 207 (旧 gate `[...str].length > 280` を通過)
    // - X weighted 292 (URL を markdown link `[url](url)` で書いたため URL が 2 個と認識され
    //   23 × 2 = 46 weighted を消費)
    // → X API のみ reject、Bluesky は 300 上限内で成功 → Status=posted、bookmark 1 件、
    //   X 投稿が永久に失われた。新 gate (post-length.ts の twitter-text 経由) が refuse することを pin。
    const buggyText = `🥤【19%OFF】国産大麦100%のラベルレス麦茶（500ml×24本）<br>通常 ¥1,744 → ¥1,409（¥335安）<br>毎日の水分補給や職場・お出かけ用のまとめ買いにも◎ カフェインゼロで気軽にストック。<br><br>#Amazon でチェック→ [https://amzn.to/4wxeCuh](https://amzn.to/4wxeCuh)<br>#麦茶 #まとめ買い #カフェインゼロ`;
    pagesRetrieveMock.mockResolvedValueOnce(
      buildApprovedPage({
        '投稿文': { rich_text: [{ plain_text: buggyText }] },
      }),
    );
    const { main } = await import('./publish.js');
    await main(['node', 'publish.ts', '--page-id', '0123456789abcdef0123456789abcdef']);
    expect(xPostMock).not.toHaveBeenCalled();
    expect(blueskyPostMock).not.toHaveBeenCalled();
    expect(pagesUpdateMock).not.toHaveBeenCalled();
    expect(appendHistoryMock).not.toHaveBeenCalled();
  });

  it('enters drain mode when --page-id is missing and exits 0 if queue is empty', async () => {
    // drain mode: queryApprovedPageIds は空配列を返す → early return (no throw、no dispatch)
    const { main } = await import('./publish.js');
    await expect(main(['node', 'publish.ts'])).resolves.toBeUndefined();
    expect(pagesRetrieveMock).not.toHaveBeenCalled();
    expect(xPostMock).not.toHaveBeenCalled();
    expect(blueskyPostMock).not.toHaveBeenCalled();
  });

  it('throws when --page-id has no following value (Usage error)', async () => {
    // `--page-id` 単体 (値なし) は明示的にエラー。空文字 (workflow_dispatch の空入力) は drain mode。
    const { main } = await import('./publish.js');
    await expect(main(['node', 'publish.ts', '--page-id'])).rejects.toThrow(/--page-id/);
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

  // PR-B1: fetchPageById の必須 number property null は data quality error として
  // process.exit(1) で fatal にする (silent warn return しない)。
  it('process.exit(1) when セール価格 is null (data quality error, fail-fast)', async () => {
    pagesRetrieveMock.mockResolvedValueOnce(
      buildApprovedPage({ 'セール価格': { number: null } }),
    );
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('__exit__');
    }) as never);
    const { main } = await import('./publish.js');
    await expect(
      main(['node', 'publish.ts', '--page-id', '0123456789abcdef0123456789abcdef']),
    ).rejects.toThrow('__exit__');
    expect(exitSpy).toHaveBeenCalledWith(1);
    // SNS 投稿は行われない
    expect(xPostMock).not.toHaveBeenCalled();
    expect(blueskyPostMock).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  // PR-B1: status 不整合 (e.g. posted で publish 試行) は silent warn return のまま (data quality ではない)。
  it('silent return (no exit) when status is posted (duplicate dispatch race)', async () => {
    pagesRetrieveMock.mockResolvedValueOnce(
      buildApprovedPage({ Status: { status: { name: 'posted' } } }),
    );
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('__exit__');
    }) as never);
    const { main } = await import('./publish.js');
    await expect(
      main(['node', 'publish.ts', '--page-id', '0123456789abcdef0123456789abcdef']),
    ).resolves.toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(xPostMock).not.toHaveBeenCalled();
    expect(blueskyPostMock).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  // Bluesky spam label 対策 (PR: post-interval): interval gate の挙動 pin。
  // shouldPost 単体の境界 test は src/interval-gate.test.ts、ここでは publish.ts への統合を確認。
  describe('Bluesky interval gate', () => {
    it('skips entire publish (no dispatch, no Status update) when last self-post was < 5 min ago', async () => {
      // 1 分前 = required 最小 5 分未満で確実に skip
      const recent = new Date(Date.now() - 1 * 60 * 1000);
      getLatestSelfPostAtMock.mockResolvedValueOnce(recent);
      pagesRetrieveMock.mockResolvedValueOnce(buildApprovedPage());
      const { main } = await import('./publish.js');
      await main(['node', 'publish.ts', '--page-id', '0123456789abcdef0123456789abcdef']);
      // dispatch / history / Status update のいずれも触らない (cron 次回まで approved 据え置き)
      expect(xPostMock).not.toHaveBeenCalled();
      expect(blueskyPostMock).not.toHaveBeenCalled();
      expect(pagesUpdateMock).not.toHaveBeenCalled();
      expect(appendHistoryMock).not.toHaveBeenCalled();
    });

    it('proceeds when last self-post was > 15 min ago (gate passes for any required minutes)', async () => {
      // 20 分前 = required 上限 15 分でも通過
      const old = new Date(Date.now() - 20 * 60 * 1000);
      getLatestSelfPostAtMock.mockResolvedValueOnce(old);
      pagesRetrieveMock.mockResolvedValueOnce(buildApprovedPage());
      pagesUpdateMock.mockResolvedValueOnce({});
      xPostMock.mockResolvedValueOnce(undefined);
      blueskyPostMock.mockResolvedValueOnce(undefined);
      const { main } = await import('./publish.js');
      await main(['node', 'publish.ts', '--page-id', '0123456789abcdef0123456789abcdef']);
      expect(xPostMock).toHaveBeenCalledTimes(1);
      expect(blueskyPostMock).toHaveBeenCalledTimes(1);
    });

    it('fail-safe: skip when getLatestSelfPostAt throws (avoid double-post)', async () => {
      // API 失敗時は誤連投リスク回避のため必ず skip。次回 cron で retry。
      getLatestSelfPostAtMock.mockRejectedValueOnce(new Error('Bluesky getAuthorFeed failed (status 502)'));
      pagesRetrieveMock.mockResolvedValueOnce(buildApprovedPage());
      const { main } = await import('./publish.js');
      await main(['node', 'publish.ts', '--page-id', '0123456789abcdef0123456789abcdef']);
      expect(xPostMock).not.toHaveBeenCalled();
      expect(blueskyPostMock).not.toHaveBeenCalled();
      expect(pagesUpdateMock).not.toHaveBeenCalled();
      expect(appendHistoryMock).not.toHaveBeenCalled();
    });

    it('skips gate (no API call) when blueskyPosted=true (X-only retry doesn\'t need throttle)', async () => {
      pagesRetrieveMock.mockResolvedValueOnce(
        buildApprovedPage({ bluesky_posted: { checkbox: true } }),
      );
      pagesUpdateMock.mockResolvedValueOnce({});
      xPostMock.mockResolvedValueOnce({ url: 'https://twitter.com/i/web/status/111' });
      const { main } = await import('./publish.js');
      await main(['node', 'publish.ts', '--page-id', '0123456789abcdef0123456789abcdef']);
      // Bluesky 側 throttle は無関係 → getLatestSelfPostAt は呼ばれない
      expect(getLatestSelfPostAtMock).not.toHaveBeenCalled();
      // X のみ dispatch
      expect(xPostMock).toHaveBeenCalledTimes(1);
      expect(blueskyPostMock).not.toHaveBeenCalled();
    });

    it('proceeds when getLatestSelfPostAt returns null (no prior posts found)', async () => {
      // 新規アカウント / 全削除直後 → lastPostAt=null は「初回投稿」とみなして gate 通過。
      getLatestSelfPostAtMock.mockResolvedValueOnce(null);
      pagesRetrieveMock.mockResolvedValueOnce(buildApprovedPage());
      pagesUpdateMock.mockResolvedValueOnce({});
      xPostMock.mockResolvedValueOnce(undefined);
      blueskyPostMock.mockResolvedValueOnce(undefined);
      const { main } = await import('./publish.js');
      await main(['node', 'publish.ts', '--page-id', '0123456789abcdef0123456789abcdef']);
      expect(xPostMock).toHaveBeenCalledTimes(1);
      expect(blueskyPostMock).toHaveBeenCalledTimes(1);
    });
  });

  // drain mode (cron */5 起動): page_id 未指定で queryApprovedPageIds の oldest を選んで投稿。
  describe('drain mode', () => {
    it('picks oldest approved page from queryApprovedPageIds and publishes 1', async () => {
      const oldPageId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      // queryApprovedPageIds は 3 件返すが、本 cron では 1 件のみ投稿する (キュー消化)
      dataSourcesQueryMock.mockResolvedValueOnce({
        results: [{ id: oldPageId }, { id: 'b'.repeat(32) }, { id: 'c'.repeat(32) }],
        has_more: false,
      });
      pagesRetrieveMock.mockResolvedValueOnce({
        id: oldPageId,
        properties: buildApprovedPage().properties,
      });
      pagesUpdateMock.mockResolvedValueOnce({});
      xPostMock.mockResolvedValueOnce(undefined);
      blueskyPostMock.mockResolvedValueOnce(undefined);
      const { main } = await import('./publish.js');
      await main(['node', 'publish.ts']);
      // oldest 1 件のみ dispatch
      expect(xPostMock).toHaveBeenCalledTimes(1);
      expect(blueskyPostMock).toHaveBeenCalledTimes(1);
      // pages.retrieve は oldest の page_id で呼ばれている
      expect(pagesRetrieveMock).toHaveBeenCalledWith(
        expect.objectContaining({ page_id: oldPageId }),
      );
    });

    it('exits 0 (no error) when queue is empty', async () => {
      dataSourcesQueryMock.mockResolvedValueOnce({ results: [], has_more: false });
      const { main } = await import('./publish.js');
      await expect(main(['node', 'publish.ts'])).resolves.toBeUndefined();
      expect(pagesRetrieveMock).not.toHaveBeenCalled();
      expect(xPostMock).not.toHaveBeenCalled();
      expect(blueskyPostMock).not.toHaveBeenCalled();
    });
  });
});
