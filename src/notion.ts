import { Client } from '@notionhq/client';
import type { NotionCategory } from './category.js';
import { COOLDOWN_HOURS, MAX_QUERY_PAGES } from './config.js';
import type { ReferenceSource } from './keepa.js';
import { logger } from './logger.js';
import {
  extractCheckbox,
  extractDate,
  extractNumber,
  extractRichText,
  extractSelect,
  extractStatus,
  extractTitleText,
  extractUrl,
} from './notion-extractors.js';
import type { PostResult } from './posters/index.js';

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
  // referencePrice の出所。Notion 上では callout block として page 末尾に append され、
  // bon が「Amazon UI の打消し線価格に依拠したコピー」と「Keepa 由来の最安値タイ系コピー」を
  // 切り替える判断材料になる。schema 変更なし (block append のみ) なので Notion DB 側の追加作業不要。
  referenceSource?: ReferenceSource | 'keepa' | 'manual-reference-price';
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
  // PR-1 Phase 2: per-platform 既投稿フラグ。Notion DB の checkbox property `x_posted` / `bluesky_posted`
  // を読み、片方既投稿なら publish.ts 側で対応する poster を dispatch から除外する (silent loss 解消)。
  // null/missing は false 扱い (extractCheckbox の null-safe default)。
  xPosted: boolean;
  blueskyPosted: boolean;
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

// run-log 専用の Client。書込は run の最後に呼ぶ best-effort で、書込失敗は draft.ts の
// exit code に影響させない。そのため timeout を main の半分 (15s)、retry も 2 attempts に絞り、
// run-log への待ち時間で run 全体を引っ張らない設計。`buildClient` と policy が分裂しないよう
// notion.ts に集約する (PR-C B2 で run-log.ts の独自 `new Client(...)` から移管)。
export const buildRunLogClient = (): Client =>
  new Client({
    auth: process.env.NOTION_API_KEY,
    notionVersion: '2026-03-11',
    timeoutMs: 15_000,
    retry: {
      maxRetries: 2,
      initialRetryDelayMs: 1_000,
      maxRetryDelayMs: 4_000,
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

// referenceSource を bon が判断しやすい日本語ラベル付き callout block として page 末尾に append する。
// 「Amazon UI に打消し線が表示されているか」が値下げコピー採用の判断材料。
const REFERENCE_SOURCE_LABEL: Record<string, { label: string; emoji: string; note: string }> = {
  'manual-reference-price': {
    emoji: '✏️',
    label: 'Notion 手動入力 参考定価',
    note: '固定ASIN 用に bon が設定した希望小売価格。Amazon UI 表示は要確認。',
  },
  'list-price': {
    emoji: '⚠️',
    label: 'Keepa 90日 List Price',
    note: 'Amazon UI に打消し線が無い可能性。「過去最安値タイ」「平均比 -X%」系コピー推奨。',
  },
  'amazon-avg': {
    emoji: '⚠️',
    label: 'Keepa 90日 Amazon 平均',
    note: 'Amazon UI に打消し線が無い可能性。「過去最安値タイ」「平均比 -X%」系コピー推奨。',
  },
  'new-avg': {
    emoji: '⚠️',
    label: 'Keepa 90日 New 平均',
    note: 'Amazon UI に打消し線が無い可能性。「過去最安値タイ」「平均比 -X%」系コピー推奨。',
  },
  'week-avg': {
    emoji: '⚠️',
    label: 'Keepa 週平均',
    note: 'Amazon UI に打消し線が無い可能性。「過去最安値タイ」「平均比 -X%」系コピー推奨。',
  },
  'min-90d': {
    emoji: '⚠️',
    label: 'Keepa 90日最安値',
    note: 'Amazon UI に打消し線が無い可能性。「過去最安値タイ」「平均比 -X%」系コピー推奨。',
  },
  keepa: {
    emoji: '⚠️',
    label: 'Keepa fallback',
    note: 'Amazon UI に打消し線が無い可能性。「過去最安値タイ」「平均比 -X%」系コピー推奨。',
  },
};

const appendReferenceSourceCallout = async (
  client: Client,
  pageId: string,
  referenceSource: string,
): Promise<void> => {
  const meta = REFERENCE_SOURCE_LABEL[referenceSource] ?? {
    emoji: 'ℹ️',
    label: referenceSource,
    note: '',
  };
  const text = `参考価格ソース: ${meta.label}${meta.note ? ` — ${meta.note}` : ''}`;
  await client.blocks.children.append({
    block_id: pageId,
    children: [
      {
        object: 'block',
        type: 'callout',
        callout: {
          icon: { type: 'emoji', emoji: meta.emoji },
          rich_text: [{ type: 'text', text: { content: text } }],
        },
      },
    ],
  });
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
  // referenceSource を callout として page 末尾に append (schema 変更不要、bon の判断材料用)。
  // 失敗しても draft 作成自体は live なので warn ログのみで continue する。
  if (draft.referenceSource) {
    try {
      await appendReferenceSourceCallout(client, pageId, draft.referenceSource);
    } catch (err) {
      logger.warn('notion', 'append reference source callout failed', {
        asin: draft.asin,
        pageId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
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
  if (draft.referenceSource) {
    try {
      await appendReferenceSourceCallout(client, pageId, draft.referenceSource);
    } catch (err) {
      logger.warn('notion', 'append reference source callout failed', {
        asin: draft.asin,
        pageId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const bookmarkCount = await appendPostBookmarks(client, pageId, links);
  logger.info('notion', 'posted page created', {
    asin: draft.asin,
    pageId,
    category: draft.category,
    bookmarks: bookmarkCount,
  });
  return pageId;
};

// per-platform 制御で Notion page を更新する。
//
// 挙動:
//   - result.x?.ok === true   → properties に `x_posted: { checkbox: true }` を追加
//   - result.bluesky?.ok === true → properties に `bluesky_posted: { checkbox: true }` を追加
//   - **両 platform が投稿済とみなせる時のみ** Status=posted + 投稿日時 をセットする。
//     ここでの「投稿済」は (a) 今回 dispatch で ok=true、または (b) prior.xPosted/blueskyPosted=true
//     (前回 run で投稿済) のいずれか。これにより per-platform retry シナリオ
//     (例: 前回 X だけ成功 → 今回 BSky retry 成功) でも両 SNS 完遂時に Status=posted に進む。
//   - 片方失敗時は Status/投稿日時 を touch せず approved のまま残し、次回 publish 再実行で
//     残り platform を retry できる構造にする。
//   - 何も update しない (両 false) ケースでは pages.update を呼ばず early return する。
//   - bookmark append は今回成功 platform 分のみ行う (result.x?.ok && links.x なら X bookmark、
//     result.bluesky?.ok && links.bluesky なら BSky bookmark)。prior の bookmark は前回 append 済。
//
// links は X / Bluesky の投稿 URL。Notion API の制約: page 直下に children を追加する場合は
// blocks.children.append を使う。pages.update で children を渡しても無視される。
export interface PriorPostState {
  xPosted: boolean;
  blueskyPosted: boolean;
}

export const updateStatusToPosted = async (
  pageId: string,
  result: PostResult,
  postedAt: Date,
  links: PostedLinks = {},
  prior: PriorPostState = { xPosted: false, blueskyPosted: false },
): Promise<void> => {
  const xOk = result.x?.ok === true;
  const blueskyOk = result.bluesky?.ok === true;
  // properties を build。両 false (かつ prior も両 false) なら properties は空のまま skip。
  const properties: Record<string, unknown> = {};
  if (xOk) properties.x_posted = { checkbox: true };
  if (blueskyOk) properties.bluesky_posted = { checkbox: true };
  // 「今回成功」または「prior で既に true」のいずれかで投稿済扱い。
  const xPostedEffective = xOk || prior.xPosted;
  const blueskyPostedEffective = blueskyOk || prior.blueskyPosted;
  const bothOk = xPostedEffective && blueskyPostedEffective;
  if (bothOk) {
    properties.Status = { status: { name: STATUS.POSTED } };
    properties['投稿日時'] = { date: { start: postedAt.toISOString() } };
  }

  if (Object.keys(properties).length === 0) {
    logger.info('notion', 'no platform succeeded, skipping status update', { pageId });
    return;
  }

  const client = buildClient();
  // Notion SDK の properties 型は厳格 union だが、本 fn は per-platform 制御で
  // 動的に組み立てるため、buildBaseProperties / createDraftPage と同様 cast で渡す。
  await client.pages.update({
    page_id: pageId,
    properties: properties as Parameters<typeof client.pages.update>[0]['properties'],
  });
  // 成功 platform のみ bookmark append (links が無い場合は skip される)。
  const bookmarkLinks: PostedLinks = {};
  if (xOk && links.x) bookmarkLinks.x = links.x;
  if (blueskyOk && links.bluesky) bookmarkLinks.bluesky = links.bluesky;
  // bookmark append は audit trail (Notion 上で投稿 URL に辿れる) で、SNS 投稿 (live) と Status update
  // (成功) は既に完了している。ここで Notion blocks.children.append が 5xx / timeout で失敗しても
  // publish 全体を fatal にすると、ユーザーから見れば「投稿成功 + DB 整合 OK だが exit 1」になり
  // 二重投稿リスクが生じる (cron 再走で同じ approved を再投稿してしまう恐れ)。bookmark 喪失は
  // audit trail 欠落として error level で残し、上位は成功扱いに戻す。
  let bookmarkCount = 0;
  try {
    bookmarkCount = await appendPostBookmarks(client, pageId, bookmarkLinks);
  } catch (err) {
    logger.error('notion', 'bookmark append failed (status update succeeded)', {
      pageId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  logger.info('notion', 'status updated to posted', {
    pageId,
    bookmarks: bookmarkCount,
    xOk,
    blueskyOk,
    priorXPosted: prior.xPosted,
    priorBlueskyPosted: prior.blueskyPosted,
    bothOk,
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
    // Notion DB の checkbox property 名は `x_posted` / `bluesky_posted` (lowercase snake_case)。
    // 不在 / null は false 扱い (extractCheckbox の null-safe default)。
    xPosted: extractCheckbox(props.x_posted),
    blueskyPosted: extractCheckbox(props.bluesky_posted),
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

// drain モード (cron */5) 用: Status=approved の page id を「候補生成日時 昇順」で取得する。
// FIFO 消化: 最も古い approved 行を最初に投稿対象にする (Notion 上の手動承認順序を尊重)。
// limit 既定 20: 1 cron で 1 件投稿 + 残りは次回繰越なので、queue が膨らんでも 1 page クエリで足りる想定。
// publish.ts 側で xPosted/blueskyPosted を再判定するため、ここでは page_id のみ返す (軽量化)。
export const queryApprovedPageIds = async (limit = 20): Promise<string[]> => {
  if (!isConfigured()) {
    logger.warn('notion', 'env not configured, returning empty approved list');
    return [];
  }
  const dataSourceId = process.env.NOTION_VUEPRIX_DATA_SOURCE_ID as string;
  const client = buildClient();
  const filter = {
    property: 'Status',
    status: { equals: STATUS.APPROVED },
  };
  const sorts = [{ property: '候補生成日時', direction: 'ascending' as const }];
  const res = (await client.dataSources.query({
    data_source_id: dataSourceId,
    filter,
    sorts,
    page_size: limit,
  })) as unknown as NotionQueryResult;
  const pageIds = res.results.map((p) => p.id);
  logger.info('notion', 'approved page ids queried', { count: pageIds.length, limit });
  return pageIds;
};

// Notion ブラックリスト DB から「2 度と紹介しない」ASIN を全件取得する。
// queryDuplicateAsins と異なり Status / 日付 filter なし (登録の事実 = 恒久ブロック意図)。
// 失敗時の挙動 (`blocklist.md` が file 失敗を warn + 空 Set で吸収するのと意図的に非対称):
//   - env 未設定: warn + 空 Set。DRY_RUN / 初回 secret 登録忘れで run を止めない fail-safe
//   - Notion API 失敗: throw され orchestrator の Promise.all で fatal catch。
//     Notion DB は除外ソースの SoT で、API 不通時に空 Set を返すと「ブロック解除された」と
//     誤って解釈されるリスクが高いため、run を止めて再実行で正確性を担保する
//     (queryDuplicateAsins と統一)。
export const queryBlacklistAsins = async (): Promise<Set<string>> => {
  const dataSourceId = process.env.NOTION_VUEPRIX_BLACKLIST_DATA_SOURCE_ID;
  if (!process.env.NOTION_API_KEY || !dataSourceId) {
    logger.warn('notion', 'blacklist env not configured, returning empty set');
    return new Set();
  }
  const client = buildClient();
  const asins = new Set<string>();
  let cursor: string | undefined;
  let reachedCap = true;
  for (let i = 0; i < MAX_QUERY_PAGES; i += 1) {
    const res = (await client.dataSources.query({
      data_source_id: dataSourceId,
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
      fn: 'queryBlacklistAsins',
      maxPages: MAX_QUERY_PAGES,
      collected: asins.size,
    });
  }
  logger.info('notion', 'blacklist asins queried', { count: asins.size });
  return asins;
};

