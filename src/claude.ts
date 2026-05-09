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
    '以下の商品について、なぜ今買うべきか日本語で1文（40字以内）で説明してください。',
    '体言止め不可。「〜がお得」「〜がおすすめ」で終わらない表現にすること。',
    '広告っぽい表現を避け、使い手目線で書くこと。',
    '',
    `商品名: ${sanitizeTitle(product.title)}`,
    `値下がり率: ${dropPercent}%`,
    `現在価格: ¥${product.currentPrice.toLocaleString('ja-JP')}`,
    '',
    '出力: 1文のみ。余分な説明不要。',
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
