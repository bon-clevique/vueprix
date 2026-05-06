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
    const status = (err as { status?: number }).status;
    const requestId = (err as { request_id?: string }).request_id;
    logger.error('claude', 'generation failed, using fallback', {
      asin: product.asin,
      status: status ?? null,
      requestId: requestId ?? null,
      type: err instanceof Error ? err.constructor.name : typeof err,
    });
    return FALLBACK_REASON;
  }
};
