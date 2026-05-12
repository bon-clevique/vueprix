# ADR-004: Run log Notion DB と Notion API retry/timeout

**Date**: 2026-05-12
**Status**: Accepted

## Context

2026-05-12 09:58 JST の cron 実行が `@notionhq/client` の `RequestTimeoutError` (default 60s) で fatal exit し、その 2 時間サイクル分の draft が失われた。Keepa 取得自体は直前の 07:28 JST run で正常 (deals fetched x 7 categories, draft 7 件成功) を確認済で、Notion API 側の単発 timeout が原因。

問題は 2 点:

1. **可視性**: cron 実行の状態 (Keepa tokens / 取得件数 / draft 件数 / エラー有無) が GitHub Actions ログに埋もれて、Notion を見るだけでは bot 健康状態が判断できない。Notion 中心運用の vueprix 設計と整合しない
2. **回復性**: 単発 timeout で 2 時間サイクル分が丸ごと喪失する。`@notionhq/client` v5 は built-in retry option を持つが、`buildClient()` (src/notion.ts:124–128) では未指定だった

## Decision

### A. Notion run-log DB (新規)

各 cron 実行を 1 row として Notion DB「Run logs」に書き込む best-effort module を追加 (`src/run-log.ts`)。

- DB は手動作成 (data_source_id: `35e3ad52-d5ca-80a8-8d84-000b89b92c38`)
- env: `NOTION_VUEPRIX_RUN_LOG_DATA_SOURCE_ID` (未設定時は warn log のみで no-op)
- schema: `name` (run id) / `started_at` / `duration_ms` / `status` (success/partial/failure) / `deals_total` / `tokens_left` / `targets_selected` / `drafts_created` / `error_message` / `notion_retries` / `gha_run_url`
- 書き込みは `draft.ts` main() の finally で実行 — success/failure/partial の全パスを記録
- 書き込み自体は best-effort: catch + log のみ、draft.ts の exit code には影響させない

### B. Notion API retry/timeout option (notion.ts buildClient)

```typescript
new Client({
  auth, notionVersion: '2026-03-11',
  timeoutMs: 30_000,                                       // default 60s → 30s
  retry: { maxRetries: 3, initialRetryDelayMs: 1_000, maxRetryDelayMs: 8_000 },
});
```

- `timeoutMs: 30_000` — 60s default は cron サイクル (2h) を 1 失敗で喪失するリスクが高い。30s に短縮して 1 attempt の失敗を早く検知 → retry に回す
- `retry: { maxRetries: 3 }` — default 2 → 3。1s → 2s → 4s の指数バックオフで合計遅延 ~7s 以内
- run-log 側 (appendRunLog) は短命 retry で `maxRetries: 2`、`timeoutMs: 15_000`

### C. notion_retries の集約方式

`@notionhq/client` の retry log は library 内部の `console.warn` で出る (実例: `@notionhq/client warn: request fail`)。draft.ts 起動時に `console.warn` を 1 度だけ wrap して counter increment する方式を採用。各 notion call を独自 wrapper でラップする方式 (B-1 retry option を捨てる) より侵襲性が低い。

## Alternatives

| Alternative | Reason rejected |
|---|---|
| GitHub Actions の retry 機構 (`continue-on-error` + re-run) | cron 単位の retry で 2 時間後まで再実行されないため UX 劣化 |
| Notion DB を作らず GHA ログに頼る | ユーザー要望「Notion 中心運用」に合わない |
| Custom withRetry wrapper を全 notion call に被せる | `@notionhq/client` v5 が built-in retry を提供しているため重複 |
| post-history.jsonl を Notion 移行 | 別 plan (現状 90 日 retention で十分) |
| run-log を notion.ts に統合 | run-log は best-effort + 別 schema、責務分離で別 module 化 |

## Outcome

**Success criteria**:
- cron が Notion API 単発 timeout に当たっても retry で吸収され success 完走する (1 サイクル分の draft が失われない)
- 連続 failure 時は run-log DB に error_message 付き row が残り、ユーザーが Notion 上で原因を即把握できる
- `appendRunLog` の失敗は draft.ts 本体の exit code に影響しない (best-effort 保証)

**Review date**: 2026-08-12 (3 ヶ月後 — 1-2 週間の運用で notion_retries 件数の推移を確認、retry 設定値の調整を検討)

**Risks**:
- Notion 側の継続障害なら retry も無力 (本変更はあくまで単発 timeout 対策)
- console.warn wrap は global side effect。第三者 library の console.warn にも干渉する可能性 (現状は @notionhq/client prefix のみ filter で安全、suppress せず再出力する)
- `@notionhq/client` v6+ で warn message prefix が変わると silent に counter が 0 になる regression リスク。発生時は `NOTION_RETRY_LOG_PREFIX` 定数を更新

**Future migration**: `@notionhq/client` が公式 retry callback (e.g. `onRetry` hook in ClientOptions) を提供したら、console.warn wrap を撤去して callback 経由で count するべき。現状は prefix substring detection で運用
