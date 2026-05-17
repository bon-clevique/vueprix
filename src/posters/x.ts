import { TwitterApi } from 'twitter-api-v2';
import { logger } from '../logger.js';
import type { Poster, PostInput, PostOutput } from './types.js';

const redactedTweetError = (err: unknown): Error => {
  const status = (err as { code?: number; status?: number }).code
    ?? (err as { code?: number; status?: number }).status;
  return new Error(`X tweet failed${status ? ` (status ${status})` : ''}`);
};

// twitter-api-v2 lib の error object から構造化情報を抽出して logger.error で 1 line 出す。
// redactedTweetError は status しか保持しない設計のため、運用調査時に必要な application code
// (e.g. 88=Rate limit, 187=Status duplicate) / detail message を補完する。
//
// 抽出ルール:
//   - status: HTTP status (lib は `.code` フィールドに HTTP status を入れる)
//   - code: X API error body の application code (`data.errors[0].code` or `data.code`)
//   - type: twitter-api-v2 内部分類 ('response' / 'request' 等)
//   - detail: 人間可読のエラー説明 (data.detail / data.title / data.errors[0].message のいずれか)
// 全 field undefined 可。logger.error は構造化 JSON で 1 line 出す前提なので undefined キーも
// そのまま含めて構わない (logger 実装が省略する)。
interface XApiErrorShape {
  code?: number;
  status?: number;
  type?: string;
  data?: {
    code?: number;
    detail?: string;
    title?: string;
    errors?: Array<{ code?: number; message?: string }>;
  };
}

const extractXErrorDetail = (err: unknown): {
  status?: number;
  code?: number;
  type?: string;
  detail?: string;
} => {
  const e = err as XApiErrorShape;
  const status = e.code ?? e.status;
  const code = e.data?.errors?.[0]?.code ?? e.data?.code;
  const type = e.type;
  const detail = e.data?.detail ?? e.data?.title ?? e.data?.errors?.[0]?.message;
  return { status, code, type, detail };
};

// `/i/web/status/<id>` 形式は screen_name 取得 API を呼ばずに済み、X 側が正しいユーザーへ
// リダイレクトする。Notion bookmark 化した際の OG プレビューも正常に解決される。
const buildTweetUrl = (tweetId: string): string => `https://twitter.com/i/web/status/${tweetId}`;

const send = async (input: PostInput): Promise<PostOutput> => {
  const apiKey = process.env.X_API_KEY;
  const apiSecret = process.env.X_API_SECRET;
  const accessToken = process.env.X_ACCESS_TOKEN;
  const accessSecret = process.env.X_ACCESS_TOKEN_SECRET;
  if (!apiKey || !apiSecret || !accessToken || !accessSecret) {
    throw new Error('X credentials are not fully set');
  }
  const client = new TwitterApi({ appKey: apiKey, appSecret: apiSecret, accessToken, accessSecret });
  try {
    const res = await client.v2.tweet(input.text);
    const url = buildTweetUrl(res.data.id);
    logger.info('poster.x', 'X tweet posted', { asin: input.asin, tweetId: res.data.id, url });
    return { url };
  } catch (err) {
    // 運用調査用に構造化詳細を log してから redact wrapper で投げ直す (redact 自体は維持)。
    logger.error('poster.x', 'X tweet failed', extractXErrorDetail(err));
    throw redactedTweetError(err);
  }
};

export const xPoster: Poster = {
  name: 'x',
  post: send,
};
