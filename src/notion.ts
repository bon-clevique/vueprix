import { Client } from '@notionhq/client';
import type { NotionCategory } from './category.js';
import { COOLDOWN_HOURS, MAX_QUERY_PAGES } from './config.js';
import { logger } from './logger.js';
import {
  extractDate,
  extractNumber,
  extractRichText,
  extractSelect,
  extractStatus,
  extractTitleText,
  extractUrl,
} from './notion-extractors.js';

export interface PostedLinks {
  x?: string;
  bluesky?: string;
}

// Notion DB「vueprix 投稿文」schema:
//   - 名前 (title): 商品名
//   - 投稿文 (rich_text): X / Bluesky 両用本文 (Notion AI で生成、≤280 chars 制約は運用側で守る)
//   - ASIN (rich_text)
//   - Status (status: backlog/doing/approved/posted/rejected) — PR-8 で select → status type に変更
//   - 候補生成日時 (date)
//   - 投稿日時 (date)
//   - サクラチェッカーURL (url)
//   - Amazon URL (url)
//   - 通常価格 / セール価格 (number, yen)
//   - 割引率 (number, percent)
//   - カテゴリ (select: food/health/pc-desk/gaming/audio/fixed-list)
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

// Status は Notion DB の status option name に揃える。
// Notion API は status property の書き込み / クエリで option name の完全一致を要求するため、
// Notion UI 側で option label を変更したら本 const と全 test hardcoded 値も連動更新が必要。
// (旧方針「内部値は snake_case で統一」は ADR-003 改訂で撤回 — option label を真値とする方針に変更)
//
// 遷移:
//   backlog (bot 作成直後、投稿文 空)
//     → doing (bon が Notion AI で 投稿文 を作成中、手動遷移)
//     → approved (文面 + レビュー完了、Notion automation で publish 発火)
//     → posted (publish 完了)
//   rejected (投稿しないと判断 + ガイドラインとして残す価値あり、sidetrack)
//   理由なし不採用は Notion ページごと archive/delete (rejected に置かない)
export const STATUS = {
  BACKLOG: 'backlog',
  IN_PROGRESS: 'doing',
  APPROVED: 'approved',
  POSTED: 'posted',
  REJECTED: 'rejected',
} as const;
export type Status = (typeof STATUS)[keyof typeof STATUS];

export const CATEGORY = {
  FOOD: 'food',
  HEALTH: 'health',
  PC_DESK: 'pc-desk',
  GAMING: 'gaming',
  AUDIO: 'audio',
  KITCHEN: 'kitchen',
  STATIONERY: 'stationery',
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
  postText: string;
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
  postText: string;
  amazonUrl: string | null;
  currentPrice: number;
  referencePrice: number;
  dropPercent: number;
  category: NotionCategory;
  postedAt: string | null;
}

// Notion API: timeout/retry option を明示的に設定する。
// - timeoutMs: default 60s だと cron サイクル (2h) を 1 失敗で丸ごと喪失する事象 (2026-05-12 09:58 JST 実例) があり、
//   30s に短縮して 1 attempt の失敗を早く検知 → retry に回す。
// - retry: default は maxRetries=2 だが、本 repo では timeout/5xx での fatal exit を防ぐため 3 attempts に上げる
//   (1s → 2s → 4s の指数バックオフ、合計遅延 ~7s)。
// notion.ts 内部 + 他 module (fixed-templates.ts 等) から共通利用するため export する。
// retry policy / timeout の単一管理を保つことで bug 源 (policy drift) を防ぐ。
export const buildClient = (): Client =>
  new Client({
    auth: process.env.NOTION_API_KEY,
    notionVersion: '2026-03-11',
    timeoutMs: 30_000,
    retry: {
      maxRetries: 3,
      initialRetryDelayMs: 1_000,
      maxRetryDelayMs: 8_000,
    },
  });

// createDraftPage / createPostedPage 共通の properties (Status と 投稿日時 以外) を構築する。
// Status と 投稿日時 は呼び出し側で個別にマージする。
const buildBaseProperties = (draft: DraftCandidate): Record<string, unknown> => {
  const relations = (draft.guidelineRelations ?? []).map((id) => ({ id }));
  return {
    '名前': {
      title: [{ type: 'text', text: { content: truncate(draft.title, 200) } }],
    },
    ASIN: {
      rich_text: [{ type: 'text', text: { content: draft.asin } }],
    },
    '投稿文': {
      rich_text: [{ type: 'text', text: { content: truncate(draft.postText) } }],
    },
    'Amazon URL': draft.amazonUrl ? { url: draft.amazonUrl } : { url: null },
    '通常価格': { number: draft.referencePrice },
    'セール価格': { number: draft.currentPrice },
    '割引率': { number: draft.dropPercent / 100 },
    'カテゴリ': { select: { name: draft.category } },
    'サクラチェッカーURL': { url: buildSakuraCheckerUrl(draft.asin) },
    '候補生成日時': { date: { start: draft.generatedAt.toISOString() } },
    ...(relations.length > 0 ? { '関連ガイドライン': { relation: relations } } : {}),
  };
};

// links に含まれる X / Bluesky URL を bookmark block として page 末尾に append する。
// updateStatusToPosted / createPostedPage の両方から呼ばれる共通ロジック。
const appendPostBookmarks = async (
  client: Client,
  pageId: string,
  links: PostedLinks,
): Promise<number> => {
  const bookmarks: Array<{ object: 'block'; type: 'bookmark'; bookmark: { url: string } }> = [];
  if (links.x) bookmarks.push({ object: 'block', type: 'bookmark', bookmark: { url: links.x } });
  if (links.bluesky) bookmarks.push({ object: 'block', type: 'bookmark', bookmark: { url: links.bluesky } });
  if (bookmarks.length === 0) return 0;
  await client.blocks.children.append({ block_id: pageId, children: bookmarks });
  return bookmarks.length;
};

// Status=backlog として candidate を 1 page 作成。page id を返す。
// approval workflow の起点。Notion automation が Status=approved に変更すると repository_dispatch が発火する。
export const createDraftPage = async (draft: DraftCandidate): Promise<string> => {
  const dataSourceId = requireConfigured();
  const client = buildClient();
  const res = await client.pages.create({
    // Notion API v2026-03-11 では parent は data_source_id を指定する。
    // (環境変数名は NOTION_VUEPRIX_DATA_SOURCE_ID で、値は data source UUID)
    parent: { type: 'data_source_id', data_source_id: dataSourceId },
    properties: {
      ...buildBaseProperties(draft),
      // Status は Notion 側で「status」type (PR-8 で select から変更)。書き込み形式も `status: { name }`。
      // 初期値は backlog (bon が後で doing に手動遷移 → 投稿文 を Notion AI で生成 → approved)。
      Status: { status: { name: STATUS.BACKLOG } },
    },
  });
  const pageId = (res as { id: string }).id;
  logger.info('notion', 'draft page created', { asin: draft.asin, pageId, category: draft.category });
  return pageId;
};

// Notion AI 承認フローを介さず X/Bluesky に即時投稿された候補を、Status=posted で 1 page 作成する。
// 固定ASIN (FIXED_ASINS) の直接投稿フロー専用。draft.postText には実際に投稿された最終文を渡す。
// 投稿後の bookmark append まで本 fn が担当 — 呼び出し側で updateStatusToPosted を続けて呼ぶ必要はない。
export const createPostedPage = async (
  draft: DraftCandidate,
  postedAt: Date,
  links: PostedLinks = {},
): Promise<string> => {
  const dataSourceId = requireConfigured();
  const client = buildClient();
  const res = await client.pages.create({
    parent: { type: 'data_source_id', data_source_id: dataSourceId },
    properties: {
      ...buildBaseProperties(draft),
      Status: { status: { name: STATUS.POSTED } },
      '投稿日時': { date: { start: postedAt.toISOString() } },
    },
  });
  const pageId = (res as { id: string }).id;
  const bookmarkCount = await appendPostBookmarks(client, pageId, links);
  logger.info('notion', 'posted page created', {
    asin: draft.asin,
    pageId,
    category: draft.category,
    bookmarks: bookmarkCount,
  });
  return pageId;
};

// links は X / Bluesky の投稿 URL。set されている poster のみ bookmark ブロックとして
// page 末尾に append する (replace ではない — 再投稿による重複は二重投稿ガードで
// 起きない前提なので、冪等性は持たせない)。
// Notion API の制約: page 直下に children を追加する場合は blocks.children.append を使う。
// pages.update で children を渡しても無視される。
export const updateStatusToPosted = async (
  pageId: string,
  postedAt: Date,
  links: PostedLinks = {},
): Promise<void> => {
  const client = buildClient();
  await client.pages.update({
    page_id: pageId,
    properties: {
      Status: { status: { name: STATUS.POSTED } },
      '投稿日時': { date: { start: postedAt.toISOString() } },
    },
  });
  const bookmarkCount = await appendPostBookmarks(client, pageId, links);
  logger.info('notion', 'status updated to posted', {
    pageId,
    bookmarks: bookmarkCount,
  });
};

interface NotionPageRich {
  id: string;
  properties: Record<string, unknown>;
}

// number property の null fail-fast helper。fetchPageById で必須 number property
// (通常価格 / セール価格 / 割引率) が null/未設定 だった場合の silent default-0 を防ぐ。
// publish.ts は `DraftPayload.currentPrice: number` 等を非 null 前提で扱うため、
// ここで早期 throw して publish gate に乗せる方が安全。
const requireNumber = (prop: unknown, label: string, pageId: string): number => {
  const n = extractNumber(prop);
  if (n === null) {
    throw new Error(`pageId=${pageId} ${label} is null/missing (number property required)`);
  }
  return n;
};

// page から投稿に必要な properties を抽出。Status が approved 以外なら throw (二重投稿防止 hook)。
// 必須 number property が null なら throw (fail-fast、PR B1 で導入)。
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
  // 必須 number property を null fail-fast で取得。
  const currentPrice = requireNumber(props['セール価格'], 'セール価格', pageId);
  const referencePrice = requireNumber(props['通常価格'], '通常価格', pageId);
  const rawDropPercent = requireNumber(props['割引率'], '割引率', pageId);
  return {
    pageId: page.id,
    asin: extractRichText(props.ASIN),
    title: extractTitleText(props['名前']),
    postText: extractRichText(props['投稿文']),
    amazonUrl: extractUrl(props['Amazon URL']),
    currentPrice,
    referencePrice,
    // Notion の percent property は 0.59 形式で保存している (createDraftPage 側で /100 して書き込み)。
    // publish 側に integer percent で渡すため * 100 で復元。
    // H3 対応: float 往復精度誤差 (15 → 0.15000000000000002 → 14.999...) を吸収するため
    // 高精度 round 経由で integer に丸め直す。
    dropPercent: Math.round(Math.round(rawDropPercent * 1_000_000) / 10_000),
    category,
    postedAt: extractDate(props['投稿日時']),
  };
};

interface NotionQueryResult {
  results: NotionPageRich[];
  has_more?: boolean;
  next_cursor?: string | null;
}

// Status ∈ {backlog, doing, approved, posted} かつ 候補生成日時 > now-COOLDOWN_HOURS の ASIN を Set 集約。
// 重複下書き作成を防ぐ。posted から COOLDOWN_HOURS 以内なら同 ASIN は再投稿しない。
// rejected は意図的に除外: 「ガイドラインとして残した不採用 ASIN」が将来再度値下がりした際に
// 新規 backlog として再候補化されることを許可する (運用意図、COOLDOWN_HOURS も適用しない —
// 直近 24h 内に rejected にした ASIN が再候補化されても bon が新候補を再評価する)。
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
          { property: 'Status', status: { equals: STATUS.BACKLOG } },
          { property: 'Status', status: { equals: STATUS.IN_PROGRESS } },
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

