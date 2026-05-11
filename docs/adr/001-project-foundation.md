# ADR-001: Project Foundation

**Date**: 2026-05-06
**Status**: Accepted

## Context

Amazon アソシエイトの収益源と PA-API 利用条件 (定期購買発生) を維持する手段として、価格アラート bot を運用する。汎用的な値下がり bot ではなく「食・健康・生活の質」テーマに特化することで、雑多な bot 群との差別化と転換率向上を狙う。SNS は X (@vueprix) と Bluesky (vueprix.bsky.social) の 2 経路を採用。Claude API で「なぜ今買うべきか」の一文を自動生成し、雑な bot 感を排除する。

## Decision

**Platform**: Node.js 22 / GitHub Actions cron (2 時間おき)
**Tech stack**: TypeScript / npm / vitest / `paapi5-typescript-sdk` / `@atproto/api` / `twitter-api-v2` / `@anthropic-ai/sdk` / axios
**Target users**: Amazon アソシエイト経由で「食・健康・生活の質」関連商品を買いたい X/Bluesky ユーザー
**Scope boundary** (in):
- Keepa deals × 2 カテゴリ + 固定 ASIN × 8 件の値下がり監視
- Claude API による購買理由 1 文生成
- X / Bluesky への自動投稿 (※ `DRY_RUN` 環境変数による切替は ADR-002 / PR-8 で廃止済、本番 1 本化)
- `data/posted.json` による 24h cooldown 重複除去 (※ ADR-002 で Notion DB クエリに置換済)

**Scope boundary** (out):
- 通知先 SNS の追加 (Mastodon / Threads 等)
- 機械学習による商品選定
- ダッシュボード / 管理 UI
- 外部 DB (DynamoDB / Supabase 等。posted.json で十分)

## Alternatives

| Alternative | Reason rejected |
|---|---|
| 既存の汎用 Amazon 値下がり bot (例: Keepa, Pricepulse) | テーマ特化による差別化ができず、転換率が下がる |
| Cloudflare Workers cron | GitHub Actions の方が secrets 管理と posted.json コミットが簡潔 |
| 手動 SigV4 署名 (PA-API) | 工数過大、`paapi5-typescript-sdk` で十分 |
| Redis / KV による posted.json 代替 | 1 ファイルで足り、依存追加コストの方が大きい |

## Outcome

**Success criteria**:
- 月¥30,000-40,000 のアフィリエイトコミッション
- PA-API 利用条件 (180 日以内に 3 件以上の購買) を継続維持
- bot の品質: Claude 生成の購買理由が「広告っぽさ」を回避し、フォロワーのミュート率 < 5%

**Review date**: 2026-08-06 (3 ヶ月後 — 投稿開始から 1 ヶ月の運用データを踏まえて評価)
