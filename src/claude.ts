import Anthropic from '@anthropic-ai/sdk';
import { CLAUDE_MAX_TOKENS, CLAUDE_MODEL } from './config.js';
import { logger } from './logger.js';
import type { ProductInfo } from './paapi.js';

const FALLBACK_REASON = '過去90日で最も安い価格帯になっています';

const client = (): Anthropic => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
  return new Anthropic({ apiKey: key });
};

const sanitizeTitle = (title: string): string => title.replace(/[\r\n]+/g, ' ').slice(0, 200);

export const generateReason = async (product: ProductInfo, dropPercent: number): Promise<string> => {
  const prompt = [
    'あなたは「食・健康・生活の質」をテーマに小さなSNSアカウントで商品を紹介する書き手です。',
    '次の商品について「自分の生活にどう取り入れるか」を1文の日本語で書いてください。',
    '',
    '【厳守事項】',
    '- 38字以内 (絶対超えない)',
    '- 体言止めにしない (動詞・助動詞で終わる)',
    '- 値段や割引には触れない (価格は別行で表示済み)',
    '- 次の煽り語を使わない: お得 / おすすめ / 必見 / チャンス / 今だけ / 見逃せない / 半額以下 / 必須 / マスト / 神 / 衝撃 / 超 / 激安',
    '- 「〜がお得」「〜がおすすめ」「〜がチャンス」など、商品を主語にした押し売り構文にしない',
    '',
    '【書き方】',
    '- 商品の使い方や生活シーンに触れる (朝食 / 仕事中 / 寝る前 / 来客時 / ストック など)',
    '- 一人称や「ふだん」「日々」「いつもの」など、生活への馴染ませ方を示す語があると良い',
    '',
    `商品名: ${sanitizeTitle(product.title)}`,
    `値下がり率: ${dropPercent}% (※本文には書かない)`,
    `現在価格: ¥${product.currentPrice.toLocaleString('ja-JP')} (※本文には書かない)`,
    '',
    '出力: 1文のみ。前置き・後書き・引用符・絵文字すべて禁止。',
  ].join('\n');

  try {
    const res = await client().messages.create({
      model: CLAUDE_MODEL,
      max_tokens: CLAUDE_MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    });
    const block = res.content[0];
    if (block && block.type === 'text') {
      const text = block.text.trim().replace(/[\r\n]+/g, ' ');
      // プロンプトでは 38 字を希望しているが、Claude は数文字超過することがあるため
      // 60 字 hard cap で safety net。X 280 字 / Bluesky 300 字内には十分収まる。
      if (text.length > 0) return text.slice(0, 60);
    }
    logger.warn('claude', 'empty response, using fallback', { asin: product.asin });
    return FALLBACK_REASON;
  } catch (err) {
    logger.error('claude', 'generation failed, using fallback', {
      asin: product.asin,
      ...classifyAnthropicError(err),
    });
    return FALLBACK_REASON;
  }
};

interface ErrorDiagnostic {
  status: number | null;
  errorType: string | null;
  category: 'credit_balance' | 'rate_limit' | 'auth' | 'bad_request' | 'server' | 'unknown';
  requestId: string | null;
  type: string;
}

// Anthropic SDK error を運用診断に必要な field のみに redact しつつ category を付ける。
// err.message 全文は credit 不足以外で内部詳細を含む可能性があるため log しない。
// credit balance 判定だけは err.message を必要最小限の substring match で利用 (機微情報ではない運用診断値)。
export const classifyAnthropicError = (err: unknown): ErrorDiagnostic => {
  const isApiError = err instanceof Anthropic.APIError;
  const status = isApiError && typeof err.status === 'number' ? err.status : null;
  // SDK の field 名は requestID (camelCase) — request_id ではない。
  // 旧 snake_case を持つ test 互換オブジェクトの両方をサポート。
  const requestId = isApiError
    ? (err.requestID ?? null)
    : (typeof (err as { request_id?: string }).request_id === 'string'
      ? (err as { request_id: string }).request_id
      : null);
  // SDK の APIError には err.type (= 'invalid_request_error' 等) が直接乗る。
  const errorType = isApiError
    ? (err.type ?? null)
    : (typeof (err as { error?: { error?: { type?: string } } }).error?.error?.type === 'string'
      ? (err as { error: { error: { type: string } } }).error.error.type
      : null);
  const message = err instanceof Error ? err.message : '';

  let category: ErrorDiagnostic['category'] = 'unknown';
  if (err instanceof Anthropic.RateLimitError) category = 'rate_limit';
  else if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) category = 'auth';
  else if (err instanceof Anthropic.InternalServerError) category = 'server';
  else if (err instanceof Anthropic.BadRequestError) {
    category = /credit balance/i.test(message) ? 'credit_balance' : 'bad_request';
  } else if (err instanceof Anthropic.APIConnectionError) category = 'server';
  else if (err instanceof Anthropic.NotFoundError || err instanceof Anthropic.ConflictError || err instanceof Anthropic.UnprocessableEntityError) {
    category = 'bad_request';
  } else if (err instanceof Anthropic.APIError) category = 'server';

  return {
    status,
    errorType,
    category,
    requestId,
    type: err instanceof Error ? err.constructor.name : typeof err,
  };
};
