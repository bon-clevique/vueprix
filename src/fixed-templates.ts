import { POST_TEXT_MAX_CHARS } from './config.js';
import { logger } from './logger.js';
import { buildClient } from './notion.js';
import {
  extractNumber,
  extractRichText,
  extractTitleText,
  extractUrl,
} from './notion-extractors.js';

// Notion 固定ASIN DB のスキーマ:
//   - ASIN (title)
//   - 商品名 (rich_text)
//   - 投稿文 (rich_text): 値下げ前後の固定の紹介文。空文字 / 未設定の ASIN は投稿対象外
//   - 参考定価 (number): 手動入力の希望小売価格 / 旧定価。PA-API SavingBasis 不在時の reference 候補
//   - Amazon URL (url)
//   - 登録日 (date)
//
// 環境変数 NOTION_FIXED_ASIN_DATA_SOURCE_ID = 固定ASIN DB の data source UUID。

interface NotionPage {
  properties?: Record<string, unknown>;
}

interface NotionDataSourceQueryResult {
  results?: NotionPage[];
  has_more?: boolean;
  next_cursor?: string | null;
}

// 1 件の固定ASIN が保持する情報。description は必須 (空なら fetch 段階で skip)、
// manualReferencePrice / amazonUrl は optional。
// amazonUrl は bon が手動で入力した affiliate 短縮リンク (例: https://amzn.to/xxx)。
// 投稿文 DB の Amazon URL プロパティへ転記する用途で保持する (PR-#47 で導入)。
export interface FixedListing {
  description: string;
  manualReferencePrice?: number;
  amazonUrl?: string;
}

const isConfigured = (): boolean =>
  Boolean(process.env.NOTION_API_KEY) && Boolean(process.env.NOTION_FIXED_ASIN_DATA_SOURCE_ID);

// Notion 固定ASIN DB を全件クエリして ASIN → FixedListing の Map を返す。
// 投稿文 が空文字 / 未設定の行は Map に含めない (呼び出し側で「Map に無い ASIN」を skip する)。
// 参考定価 が未設定 / 0 / 負値の場合は manualReferencePrice: undefined として保持する。
//
// 環境変数未設定時は空 Map を返す (本 fn 失敗で run 全体を止めない fail-safe)。
export const fetchFixedListings = async (): Promise<Map<string, FixedListing>> => {
  const map = new Map<string, FixedListing>();
  if (!isConfigured()) {
    logger.warn('fixed-templates', 'NOTION_FIXED_ASIN_DATA_SOURCE_ID not configured');
    return map;
  }
  const dataSourceId = process.env.NOTION_FIXED_ASIN_DATA_SOURCE_ID as string;
  const client = buildClient();

  let cursor: string | undefined;
  // 9 件想定の固定ASIN DB に対して page_size=100 で 1 page で済むはず。
  // 将来 100 件超えるなら paging 拡張 (queryDuplicateAsins と同じ MAX_QUERY_PAGES パターン) を検討。
  for (let i = 0; i < 5; i += 1) {
    const res = (await client.dataSources.query({
      data_source_id: dataSourceId,
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    })) as unknown as NotionDataSourceQueryResult;
    for (const page of res.results ?? []) {
      const props = page.properties ?? {};
      const asin = extractTitleText(props.ASIN);
      const description = extractRichText(props['投稿文']);
      if (!asin || !description.trim()) continue;
      const rawNumber = extractNumber(props['参考定価']);
      const manualReferencePrice =
        rawNumber !== null && rawNumber > 0 ? rawNumber : undefined;
      const amazonUrl = extractUrl(props['Amazon URL']) ?? undefined;
      map.set(asin, { description, manualReferencePrice, amazonUrl });
    }
    if (!res.has_more || !res.next_cursor) break;
    cursor = res.next_cursor;
  }
  logger.info('fixed-templates', 'listings fetched', { count: map.size });
  return map;
};

const formatYen = (amount: number): string => `¥${amount.toLocaleString('ja-JP')}`;

// Notion `投稿文` プロパティは bon が手動で書く前提だが、誤って `@elonmusk` 等と書くと X 側で
// 意図しない mention が飛ぶ。defensive に行頭・空白後の半角 `@` を全角 `＠` に置換して mention を
// 中和する (情報は残しつつ自動 link 化を防ぐ)。Bluesky 側は facets 未指定なので影響なし。
// 既に意図して `@xxx` を書きたいケースは現状 use case として無いため fail-closed で良い。
const sanitizeForSns = (text: string): string =>
  text.replace(/(^|[\s　])@/gu, '$1＠');

// 値下げ header + 紹介文 + アフィリエイト URL を結合して最終投稿文を組み立てる。
// X 280 chars を超えたら null を返す (呼び出し側で skip + warn)。
//
// フォーマット:
//   【{dropPercent}% OFF】{referenceYen} → {currentYen}
//
//   {description}
//
//   {affiliateUrl}
export const composeFixedPostText = (
  description: string,
  dropPercent: number,
  currentPrice: number,
  referencePrice: number,
  affiliateUrl: string,
): string | null => {
  const trimmed = sanitizeForSns(description.trim());
  if (!trimmed) return null;
  const header = `【${dropPercent}% OFF】${formatYen(referencePrice)} → ${formatYen(currentPrice)}`;
  const composed = `${header}\n\n${trimmed}\n\n${affiliateUrl}`;
  if ([...composed].length > POST_TEXT_MAX_CHARS) return null;
  return composed;
};
