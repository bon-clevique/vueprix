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
//   - code: X API error body の application code (`data.errors[0].code` or `data.code`)。
//     twitter-api-v2 v3 系で `client.v2.tweet` が throw する error は ErrorV1 (`{ code: number, message: string }`) と
//     ErrorV2 (`{ message: string, type?: string }`, code フィールドなし) の union。
//     `data.errors[0].code` は ErrorV1 の場合のみ数値が取れ、v2 API でも実装によっては ErrorV1 形式の応答を返すケースがある。
//     確実に取れるのは `data.code` (lib 内部の合成 field) のため、両 path を fallback する。
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

// defense-in-depth: error の detail field に env var (X_API_KEY 等) の値が混入した場合に備え、
// log emit 前に環境変数の値が含まれていたら `[REDACTED]` に置換する。length cap 500 で過大な
// detail (lib stack trace 等) も切り詰める。length>=8 で短すぎる env value (e.g. 空文字) は無視
// (false positive 防止)。redactedTweetError と二重防御で、運用 log への secret 漏洩を構造的に塞ぐ。
const redactSecrets = (s: string | undefined): string | undefined => {
  if (!s) return s;
  const secrets = [
    process.env.X_API_KEY,
    process.env.X_API_SECRET,
    process.env.X_ACCESS_TOKEN,
    process.env.X_ACCESS_TOKEN_SECRET,
  ].filter((v): v is string => !!v && v.length >= 8);
  let out = s.slice(0, 500);
  for (const sec of secrets) out = out.split(sec).join('[REDACTED]');
  return out;
};

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
  const rawDetail = e.data?.detail ?? e.data?.title ?? e.data?.errors?.[0]?.message;
  const detail = redactSecrets(rawDetail);
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
    // asin を最初に置き、JSON 出力でも顕在化させる (LOW-9: failure ↔ ASIN の紐付け cost 削減)。
    logger.error('poster.x', 'X tweet failed', { asin: input.asin, ...extractXErrorDetail(err) });
    throw redactedTweetError(err);
  }
};

export const xPoster: Poster = {
  name: 'x',
  post: send,
};
