import { Client } from '@notionhq/client';
import type { NotionCategory } from './category.js';
import {
  APPROVAL_SLA_HOURS,
  COOLDOWN_HOURS,
  EXPIRE_WARN_THRESHOLD,
  MAX_PUBLISH_FAILURES,
  MAX_QUERY_PAGES,
} from './config.js';
import { logger } from './logger.js';

// Notion DB「vueprix 投稿文」schema (Phase 1 で 2026-05-09 / 2026-05-10 / 2026-05-11 に拡張済):
//   - 名前 (title): 商品名
//   - 理由 (rich_text): 投稿文の「なぜ買うか」一文 (Notion AI で生成)
//   - ASIN (rich_text)
//   - 投稿文_X (rich_text)
//   - 投稿文_Bluesky (rich_text)
//   - Status (status: pending_review/approved/rejected/posted/expired/blocked) — PR-8 で select → status type に変更
//   - 候補生成日時 (date)
//   - 投稿日時 (date)
//   - サクラチェッカーURL (url)
//   - Amazon URL (url)
//   - 通常価格 / セール価格 (number, yen)
//   - 割引率 (number, percent)
//   - カテゴリ (select: food/health/pc-desk/gaming/audio/fixed-list)
//   - 投稿失敗回数 (number): publish 失敗連続カウンタ。MAX_PUBLISH_FAILURES に達すると Status=blocked
//   - 最終エラー (rich_text): 直近の publish 失敗内容 (truncate 1900)
//   - 関連ガイドライン (relation, optional)
//
// 環境変数:
//   - NOTION_API_KEY: integration の internal token
//   - NOTION_VUEPRIX_DATA_SOURCE_ID: 投稿文 DB の data source id

// 1 rich_text/title element 上限は Notion 側 2000 chars。安全マージンで 1900 にする。
const NOTION_TEXT_LIMIT = 1900;
// spread + slice + join で UTF-16 surrogate pair (絵文字 / 補助 CJK) safe な切り詰め。
const truncate = (text: string, max = NOTION_TEXT_LIMIT): string => {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
};

const isConfigured = (): boolean =>
  Boolean(process.env.NOTION_API_KEY) && Boolean(process.env.NOTION_VUEPRIX_DATA_SOURCE_ID);

const requireConfigured = (): string => {
  const dataSourceId = process.env.NOTION_VUEPRIX_DATA_SOURCE_ID;
  if (!process.env.NOTION_API_KEY || !dataSourceId) {
    throw new Error('NOTION_API_KEY and NOTION_VUEPRIX_DATA_SOURCE_ID must be set');
  }
  return dataSourceId;
};

// サクラチェッカー (Amazon レビュー信頼性チェック) は ASIN ベースの URL で検索結果ページに直接遷移できる。
const buildSakuraCheckerUrl = (asin: string): string =>
  `https://sakura-checker.jp/search/${encodeURIComponent(asin)}/`;

export const STATUS = {
  PENDING_REVIEW: 'pending_review',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  POSTED: 'posted',
  EXPIRED: 'expired',
  BLOCKED: 'blocked',
} as const;
export type Status = (typeof STATUS)[keyof typeof STATUS];

export const CATEGORY = {
  FOOD: 'food',
  HEALTH: 'health',
  PC_DESK: 'pc-desk',
  GAMING: 'gaming',
  AUDIO: 'audio',
  FIXED_LIST: 'fixed-list',
} as const;

// Runtime membership check 用の Set。`extractStatus` / `extractSelect` が返す任意の string を
// Status / NotionCategory に narrow するための型 guard と組で使う。
const STATUS_VALUES: ReadonlySet<string> = new Set(Object.values(STATUS));
const CATEGORY_VALUES: ReadonlySet<string> = new Set(Object.values(CATEGORY));

const isStatus = (s: string): s is Status => STATUS_VALUES.has(s);
const isNotionCategory = (c: string): c is NotionCategory => CATEGORY_VALUES.has(c);

export interface DraftCandidate {
  asin: string;
  title: string;
  postTextX: string;
  postTextBluesky: string;
  reason: string;
  amazonUrl: string | null;
  currentPrice: number;
  referencePrice: number;
  dropPercent: number;
  category: NotionCategory;
  generatedAt: Date;
  guidelineRelations?: readonly string[];
}

// fetchPageById は Status=approved の page しか返さない (それ以外は throw する) ので、
// payload 経由で status を伝搬する必要はない。silent な status drift を避けるため field は削除。
//
// postedAt は「Status=approved + 投稿日時セット済」race の二重投稿ガード用に持ち回す。
// 通常 publish 動線では null だが、posted→approved 戻し / Notion automation 多重発火など
// edge case で値がセットされていることがあり、publish.ts 側で early return の signal にする。
export interface DraftPayload {
  pageId: string;
  asin: string;
  title: string;
  postTextX: string;
  postTextBluesky: string;
  reason: string;
  amazonUrl: string | null;
  currentPrice: number;
  referencePrice: number;
  dropPercent: number;
  category: NotionCategory;
  postedAt: string | null;
}

const buildClient = (): Client =>
  new Client({
    auth: process.env.NOTION_API_KEY,
    notionVersion: '2026-03-11',
  });

interface NotionRichText {
  plain_text?: string;
}

interface NotionSelectOption {
  name?: string;
}

// Status=pending_review として candidate を 1 page 作成。page id を返す。
// approval workflow の起点。Notion automation が Status=approved に変更すると repository_dispatch が発火する。
export const createDraftPage = async (draft: DraftCandidate): Promise<string> => {
  const dataSourceId = requireConfigured();
  const client = buildClient();
  const body = `X:\n${draft.postTextX}\n\nBluesky:\n${draft.postTextBluesky}`;
  const relations = (draft.guidelineRelations ?? []).map((id) => ({ id }));
  const res = await client.pages.create({
    // Notion API v2026-03-11 では parent は data_source_id を指定する。
    // (環境変数名は NOTION_VUEPRIX_DATA_SOURCE_ID で、値は data source UUID)
    parent: { type: 'data_source_id', data_source_id: dataSourceId },
    properties: {
      '名前': {
        title: [{ type: 'text', text: { content: truncate(draft.title, 200) } }],
      },
      '理由': {
        rich_text: [{ type: 'text', text: { content: truncate(draft.reason) } }],
      },
      ASIN: {
        rich_text: [{ type: 'text', text: { content: draft.asin } }],
      },
      '投稿文_X': {
        rich_text: [{ type: 'text', text: { content: truncate(draft.postTextX) } }],
      },
      '投稿文_Bluesky': {
        rich_text: [{ type: 'text', text: { content: truncate(draft.postTextBluesky) } }],
      },
      'Amazon URL': draft.amazonUrl ? { url: draft.amazonUrl } : { url: null },
      '通常価格': { number: draft.referencePrice },
      'セール価格': { number: draft.currentPrice },
      '割引率': { number: draft.dropPercent / 100 },
      'カテゴリ': { select: { name: draft.category } },
      'サクラチェッカーURL': { url: buildSakuraCheckerUrl(draft.asin) },
      '候補生成日時': { date: { start: draft.generatedAt.toISOString() } },
      // Status は Notion 側で「status」type (PR-8 で select から変更)。書き込み形式も `status: { name }`。
      Status: { status: { name: STATUS.PENDING_REVIEW } },
      ...(relations.length > 0 ? { '関連ガイドライン': { relation: relations } } : {}),
    },
    children: [
      {
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: [{ type: 'text', text: { content: truncate(body) } }],
        },
      },
    ],
  });
  const pageId = (res as { id: string }).id;
  logger.info('notion', 'draft page created', { asin: draft.asin, pageId, category: draft.category });
  return pageId;
};

export const updateStatusToPosted = async (pageId: string, postedAt: Date): Promise<void> => {
  const client = buildClient();
  await client.pages.update({
    page_id: pageId,
    properties: {
      Status: { status: { name: STATUS.POSTED } },
      '投稿日時': { date: { start: postedAt.toISOString() } },
    },
  });
  logger.info('notion', 'status updated to posted', { pageId });
};

interface NotionPageRich {
  id: string;
  properties: Record<string, unknown>;
}

const extractRichText = (prop: unknown): string => {
  if (!prop || typeof prop !== 'object') return '';
  const rt = (prop as { rich_text?: NotionRichText[] }).rich_text;
  if (!rt) return '';
  return rt.map((t) => t.plain_text ?? '').join('');
};

const extractTitleProp = (prop: unknown): string => {
  if (!prop || typeof prop !== 'object') return '';
  const title = (prop as { title?: NotionRichText[] }).title;
  if (!title) return '';
  return title.map((t) => t.plain_text ?? '').join('');
};

const extractSelect = (prop: unknown): string => {
  if (!prop || typeof prop !== 'object') return '';
  const select = (prop as { select?: NotionSelectOption | null }).select;
  return select?.name ?? '';
};

// PR-8: Notion の status property type は `status: { name, color, id }` を返す。
// select と shape は似ているが property type が違うため別 helper にしている。
const extractStatus = (prop: unknown): string => {
  if (!prop || typeof prop !== 'object') return '';
  const status = (prop as { status?: { name?: string } | null }).status;
  return status?.name ?? '';
};

const extractNumber = (prop: unknown): number => {
  if (!prop || typeof prop !== 'object') return 0;
  return (prop as { number?: number }).number ?? 0;
};

const extractUrl = (prop: unknown): string | null => {
  if (!prop || typeof prop !== 'object') return null;
  return (prop as { url?: string | null }).url ?? null;
};

// Notion date property の date.start を ISO 文字列で返す。未設定 / null / 空文字は全て null。
// 空文字も null に coerce する理由: publish.ts の `if (payload.postedAt)` ガードを
// 空文字 (falsy だが string) で擦り抜けさせない (二重投稿防止 hook の補強)。
const extractDate = (prop: unknown): string | null => {
  if (!prop || typeof prop !== 'object') return null;
  const date = (prop as { date?: { start?: string | null } | null }).date;
  return date?.start || null;
};

// 全 poster 失敗時の Notion 状態同期。retrieve で現在の「投稿失敗回数」を取得し +1、
// 「最終エラー」に直近の failure detail を rich_text で書き込む。新カウントが MAX_PUBLISH_FAILURES
// (= 3) に達した場合は同 update で Status=blocked にも遷移させる (operator が後で再開可能)。
//
// retrieve 失敗時はカウンタを 0 として fallback する (publish の失敗ログより Notion の整合性を優先)。
// blocked 遷移済 page を再度 increment しても number は単調増加するが、Status=blocked は idempotent。
export const incrementFailureCount = async (
  pageId: string,
  errorMessage: string,
): Promise<{ count: number; blocked: boolean }> => {
  const client = buildClient();
  let previousCount = 0;
  try {
    const page = (await client.pages.retrieve({ page_id: pageId })) as unknown as NotionPageRich;
    previousCount = extractNumber(page.properties['投稿失敗回数']);
  } catch (err) {
    // retrieve 失敗時は previousCount=0 のまま (publish 側の失敗ログを優先する)。
    logger.warn('notion', 'failure count retrieve failed, using 0 as baseline', {
      pageId,
      type: err instanceof Error ? err.constructor.name : typeof err,
    });
  }
  const nextCount = previousCount + 1;
  const blocked = nextCount >= MAX_PUBLISH_FAILURES;
  const baseProperties = {
    '投稿失敗回数': { number: nextCount },
    '最終エラー': {
      rich_text: [{ type: 'text' as const, text: { content: truncate(errorMessage) } }],
    },
  };
  await client.pages.update({
    page_id: pageId,
    properties: blocked
      ? { ...baseProperties, Status: { status: { name: STATUS.BLOCKED } } }
      : baseProperties,
  });
  logger.info('notion', 'failure count incremented', { pageId, count: nextCount, blocked });
  return { count: nextCount, blocked };
};

// C2 対応: expire と human approval の race を防ぐため retrieve→check→update の 2-step (compare-and-set 相当)。
// 期限直前 (T0+9h59m) に bon が pending_review → approved に変更した直後、
// 別 cron の expireOldDrafts query 結果が Notion 側 indexing 遅延でまだ pending_review を返すケースがあり、
// そのまま expired で上書きすると承認後の publish が止まる silent loss が発生する。
// retrieve した時点で Status≠pending_review であれば skip する。
export const updateStatusToExpired = async (pageId: string): Promise<void> => {
  const client = buildClient();
  const page = (await client.pages.retrieve({ page_id: pageId })) as unknown as NotionPageRich;
  const currentStatus = extractStatus(page.properties.Status);
  if (currentStatus !== STATUS.PENDING_REVIEW) {
    logger.info('notion', 'expire skipped (status changed during query)', { pageId, currentStatus });
    return;
  }
  await client.pages.update({
    page_id: pageId,
    properties: {
      Status: { status: { name: STATUS.EXPIRED } },
    },
  });
  logger.info('notion', 'status updated to expired', { pageId });
};

// page から投稿に必要な properties を抽出。Status が approved 以外なら throw (二重投稿防止 hook)。
export const fetchPageById = async (pageId: string): Promise<DraftPayload> => {
  requireConfigured();
  const client = buildClient();
  const page = (await client.pages.retrieve({ page_id: pageId })) as unknown as NotionPageRich;
  const props = page.properties;
  const rawStatus = extractStatus(props.Status);
  // 任意 string → Status の narrow を runtime check 経由に統一 (旧: `as Status`)。
  // 空文字 / typo / 未知の Notion status option は全て fail-fast。
  if (!isStatus(rawStatus)) {
    throw new Error(`pageId=${pageId} status=${rawStatus || '(empty)'} (not a known Status value)`);
  }
  if (rawStatus !== STATUS.APPROVED) {
    throw new Error(`pageId=${pageId} status=${rawStatus} (expected ${STATUS.APPROVED})`);
  }
  const rawCategory = extractSelect(props['カテゴリ']);
  // 未知のカテゴリは silent に fixed-list に丸める (publish を止めない方針)。
  const category: NotionCategory = isNotionCategory(rawCategory) ? rawCategory : CATEGORY.FIXED_LIST;
  return {
    pageId: page.id,
    asin: extractRichText(props.ASIN),
    title: extractTitleProp(props['名前']),
    postTextX: extractRichText(props['投稿文_X']),
    postTextBluesky: extractRichText(props['投稿文_Bluesky']),
    reason: extractRichText(props['理由']),
    amazonUrl: extractUrl(props['Amazon URL']),
    currentPrice: extractNumber(props['セール価格']),
    referencePrice: extractNumber(props['通常価格']),
    // Notion の percent property は 0.59 形式で保存している (createDraftPage 側で /100 して書き込み)。
    // publish 側に integer percent で渡すため * 100 で復元。
    // H3 対応: float 往復精度誤差 (15 → 0.15000000000000002 → 14.999...) を吸収するため
    // 高精度 round 経由で integer に丸め直す。
    dropPercent: Math.round(Math.round(extractNumber(props['割引率']) * 1_000_000) / 10_000),
    category,
    postedAt: extractDate(props['投稿日時']),
  };
};

interface NotionQueryResult {
  results: NotionPageRich[];
  has_more?: boolean;
  next_cursor?: string | null;
}

// Status ∈ {pending_review, approved, posted} かつ 候補生成日時 > now-COOLDOWN_HOURS の ASIN を Set 集約。
// 重複下書き作成を防ぐ。posted から COOLDOWN_HOURS 以内なら同 ASIN は再投稿しない。
export const queryDuplicateAsins = async (now: Date): Promise<Set<string>> => {
  if (!isConfigured()) {
    logger.info('notion', 'env not configured, returning empty active set');
    return new Set();
  }
  const dataSourceId = process.env.NOTION_VUEPRIX_DATA_SOURCE_ID as string;
  const client = buildClient();
  const cutoff = new Date(now.getTime() - COOLDOWN_HOURS * 60 * 60 * 1000).toISOString();
  const filter = {
    and: [
      {
        or: [
          { property: 'Status', status: { equals: STATUS.PENDING_REVIEW } },
          { property: 'Status', status: { equals: STATUS.APPROVED } },
          { property: 'Status', status: { equals: STATUS.POSTED } },
        ],
      },
      {
        property: '候補生成日時',
        date: { on_or_after: cutoff },
      },
    ],
  };

  const asins = new Set<string>();
  let cursor: string | undefined;
  let reachedCap = true;
  // page_size=100, has_more 時に逐次 paging。MAX_QUERY_PAGES に到達したら warn (要 cap 拡張)。
  for (let i = 0; i < MAX_QUERY_PAGES; i += 1) {
    const res = (await client.dataSources.query({
      data_source_id: dataSourceId,
      filter,
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    })) as unknown as NotionQueryResult;
    for (const page of res.results) {
      const asin = extractRichText(page.properties.ASIN);
      if (asin) asins.add(asin);
    }
    if (!res.has_more || !res.next_cursor) {
      reachedCap = false;
      break;
    }
    cursor = res.next_cursor;
  }
  if (reachedCap) {
    logger.warn('notion', 'page cap reached', {
      fn: 'queryDuplicateAsins',
      maxPages: MAX_QUERY_PAGES,
      collected: asins.size,
    });
  }
  logger.info('notion', 'duplicate asins queried', { count: asins.size });
  return asins;
};

// Status=pending_review かつ 候補生成日時 < now-slaHours を query → updateStatusToExpired を逐次呼び。
// 件数=20件以下想定 (1日20件 × 数日 × 失効率)。
export const expireOldDrafts = async (
  now: Date,
  slaHours: number = APPROVAL_SLA_HOURS,
): Promise<number> => {
  if (!isConfigured()) {
    logger.info('notion', 'env not configured, skipping expire');
    return 0;
  }
  const dataSourceId = process.env.NOTION_VUEPRIX_DATA_SOURCE_ID as string;
  const client = buildClient();
  const cutoff = new Date(now.getTime() - slaHours * 60 * 60 * 1000).toISOString();
  const filter = {
    and: [
      { property: 'Status', status: { equals: STATUS.PENDING_REVIEW } },
      { property: '候補生成日時', date: { before: cutoff } },
    ],
  };

  const targetIds: string[] = [];
  let cursor: string | undefined;
  let reachedCap = true;
  for (let i = 0; i < MAX_QUERY_PAGES; i += 1) {
    const res = (await client.dataSources.query({
      data_source_id: dataSourceId,
      filter,
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    })) as unknown as NotionQueryResult;
    for (const page of res.results) {
      targetIds.push(page.id);
    }
    if (!res.has_more || !res.next_cursor) {
      reachedCap = false;
      break;
    }
    cursor = res.next_cursor;
  }
  if (reachedCap) {
    logger.warn('notion', 'page cap reached', {
      fn: 'expireOldDrafts',
      maxPages: MAX_QUERY_PAGES,
      collected: targetIds.length,
    });
  }

  for (const id of targetIds) {
    try {
      await updateStatusToExpired(id);
    } catch (err) {
      logger.error('notion', 'expire failed (continuing)', {
        pageId: id,
        type: err instanceof Error ? err.constructor.name : typeof err,
      });
    }
  }
  // 件数が EXPIRE_WARN_THRESHOLD を超えたら warn (運用異常 — bon の承認停滞 / 候補生成過多)。
  // Slack 通知連携は別 backlog 扱い。本箇所は warn ログのみ。
  if (targetIds.length >= EXPIRE_WARN_THRESHOLD) {
    logger.warn('notion', 'high expire volume', {
      count: targetIds.length,
      threshold: EXPIRE_WARN_THRESHOLD,
    });
  }
  logger.info('notion', 'expired old drafts', { count: targetIds.length });
  return targetIds.length;
};

