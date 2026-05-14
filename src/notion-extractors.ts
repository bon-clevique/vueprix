// Notion API property の安全な抽出 helper 群。
//
// 旧: notion.ts / fixed-templates.ts に重複実装があり挙動差異あり (extractNumber: default 0 vs null+isFinite、
//     extractTitleText: trim 有無、extractUrl: protocol 検証有無)。
//     2026-05-14 PR で堅牢版 (null + Number.isFinite、trim あり、http(s) only) を正典化して本 file に集約。
//
// 設計原則:
// - 入力は全て `unknown` を受け、structural narrowing で property type を判定
// - 必須でない property は null/空文字を返す (caller が判断)
// - 文字列系は前後 whitespace を trim、空 string は空文字を返す
// - URL は trim 後に http(s) 以外を reject (defense-in-depth、Notion UI は任意文字列を受ける)

interface NotionRichTextItem {
  plain_text?: string;
}

interface NotionSelectOption {
  name?: string;
}

// rich_text property を string 結合して返す。trim はしない (本文系の意図的 leading whitespace を保持)。
export const extractRichText = (prop: unknown): string => {
  if (!prop || typeof prop !== 'object') return '';
  const rt = (prop as { rich_text?: NotionRichTextItem[] }).rich_text;
  if (!rt) return '';
  return rt.map((t) => t.plain_text ?? '').join('');
};

// title property を string 結合 + trim。
// 旧 notion.ts#extractTitleProp は trim なし、fixed-templates.ts#extractTitleText は trim あり。
// 統合後は **trim あり (堅牢版)** が正典 (title は識別子用途で前後空白は無意味)。
export const extractTitleText = (prop: unknown): string => {
  if (!prop || typeof prop !== 'object') return '';
  const title = (prop as { title?: NotionRichTextItem[] }).title;
  if (!title) return '';
  return title.map((t) => t.plain_text ?? '').join('').trim();
};

// select property の option name を返す (未設定なら空文字)。
export const extractSelect = (prop: unknown): string => {
  if (!prop || typeof prop !== 'object') return '';
  const select = (prop as { select?: NotionSelectOption | null }).select;
  return select?.name ?? '';
};

// status property の name を返す。Notion API v2026-03-11 で select と shape は近いが別 type。
export const extractStatus = (prop: unknown): string => {
  if (!prop || typeof prop !== 'object') return '';
  const status = (prop as { status?: { name?: string } | null }).status;
  return status?.name ?? '';
};

// number property を返す。null / undefined / NaN は全て null。
// 旧 notion.ts#extractNumber は default 0 を返したが silent fail のリスクがあり、
// **null + Number.isFinite (fixed-templates.ts 由来の堅牢版)** が正典。caller は null check 必須。
export const extractNumber = (prop: unknown): number | null => {
  if (!prop || typeof prop !== 'object') return null;
  const n = (prop as { number?: number | null }).number;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

// URL property を厳格に検証して返す。前後 whitespace は trim、http(s) 以外は reject。
// Notion UI は URL field でも任意 string を受け入れるため、`javascript:...` や plain text の
// 誤入力で SNS 投稿が破損する事故を防ぐ defense-in-depth。
// 旧 notion.ts#extractUrl は trim/protocol 検証なし、fixed-templates.ts#extractUrl (PR #47) は
// trim + http(s) only。**堅牢版** を正典化。
export const extractUrl = (prop: unknown): string | null => {
  if (!prop || typeof prop !== 'object') return null;
  const raw = (prop as { url?: string | null }).url;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith('https://') && !trimmed.startsWith('http://')) return null;
  return trimmed;
};

// date property の `date.start` を ISO 文字列で返す。未設定 / null / 空文字 は全て null。
// 空文字を null に coerce する理由: publish.ts の `if (payload.postedAt)` ガードを
// 空文字 (falsy だが string) で擦り抜けさせない (二重投稿防止 hook の補強)。
export const extractDate = (prop: unknown): string | null => {
  if (!prop || typeof prop !== 'object') return null;
  const date = (prop as { date?: { start?: string | null } | null }).date;
  return date?.start || null;
};
