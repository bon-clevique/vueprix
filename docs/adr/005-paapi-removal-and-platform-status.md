# ADR-005: PA-API 廃止 + Notion platform 別 status 連携

**Date**: 2026-05-18
**Status**: Accepted

## Context

2 つの独立した問題が同一 PR (Phase 3-3) で解決された。

### 問題 1: PA-API 廃止 (2026-05-15 付け廃止通知)

Amazon Product Advertising API (PA-API) は 2026-05-15 付けで廃止された。vueprix では `src/paapi.ts` で `reference price (savingBasis)` 取得に PA-API を利用していたが、代替として Keepa の price history (`avg[4]` / `amazon-avg` / `new-avg` / `min-90d`) のみで同等の情報を構築できる。

PA-API に依存を残すと:
- GitHub Actions 実行時に API 呼び出しが 4xx で失敗しサイレントに参考価格 0 になる可能性がある
- `SavingBasis` 型・`'paapi-saving-basis'` enum を維持するコストが発生し続ける

### 問題 2: per-platform silent loss (anySucceeded 構造)

旧 `publish.ts` は `anySucceeded` フラグで「X か Bluesky のいずれかが成功すれば Status=posted」と判定していた。X 投稿が失敗しても Bluesky が成功した時点で Status が `posted` に遷移し、X への投稿失敗が Notion 上から見えなくなっていた (silent loss)。

Notion DB「vueprix 投稿文」には per-platform の投稿状態を追跡するための checkbox プロパティが存在しなかったため、再送・状態確認ができなかった。

Spec 参照: https://www.notion.so/PAAPI-Notion-platform-status-silent-loss-3633ad52d5ca8191beacd34cb220ec51

## Decision

### A. PA-API 完全削除

`src/paapi.ts` / `paapi.test.ts` / `scripts/verify-paapi-saving-basis.ts` を物理削除し、これらへの参照を全ソースから除去する。

**reference price chain の Keepa-only 再設計**:

`pickReferencePrice` 関数の signature を `savingBasis` 引数なしの 2 引数版に統一し、以下の Keepa-only チェーンで参考価格を決定する:

```
list-price (avg[4]) → amazon-avg → new-avg → min-90d → undefined
```

`'paapi-saving-basis'` enum 値も削除。`SavingBasis` 型は Keepa 由来の値のみで構成する。

**env rename**: `PAAPI_PARTNER_TAG` → `AMAZON_PARTNER_TAG` (アフィリエイト URL 組立て用。PA-API とは無関係のため命名を正す)

### B. Notion platform 別 status 連携

Notion DB「vueprix 投稿文」に `x_posted` (checkbox) / `bluesky_posted` (checkbox) の 2 プロパティを追加する (bon 手動)。

`publish.ts` の per-platform 制御:
- `payload.xPosted === true` の場合は X poster を dispatch から除外 (重複投稿防止)
- `payload.blueskyPosted === true` の場合は BSky poster を除外
- 両方が既投稿なら early return

`updateStatusToPosted` の変更:
- 両 platform 成功時: `x_posted=true` / `bluesky_posted=true` + `Status=posted` を更新
- 片方のみ成功: 成功した側の checkbox のみ `true` に更新、`Status` は変更しない (`approved` のまま残し再送可能な状態に保つ)

### C. X error log 詳細化

X poster の投稿失敗時に `redactedTweetError` の status redact を維持しつつ、別行に構造化 log `{ asin, status, code, type, detail }` を出力する。secret env 値が `detail` 等に含まれる場合は `[REDACTED]` 置換 (defense-in-depth)。

### D. bookmark append 失敗の non-fatal 化

`updateStatusToPosted` 内の `appendPostBookmarks` 呼び出しを try/catch で wrap し、失敗時は `logger.error` で記録して続行する。bookmark 失敗で Status 更新が rollback されるのは意図しない挙動だった。

## Consequences

### 利得

- **silent loss 消滅**: per-platform checkbox により X のみ失敗した場合に Notion DB 上で明示的に確認できる。再送も既存の `approved` → dispatch 経路で実行可能
- **SavingBasis 維持コスト消滅**: PA-API 廃止によるエラー・型定義維持の負担がなくなる
- **Keepa 単一依存の明確化**: 障害時は既存の run-log monitor (ADR-004) で Keepa 取得エラーとして検知できる

### 不利益・リスク

- **image URL 喪失**: PA-API が返していた商品画像 URL が取得不能になる。ただし X / Bluesky の投稿はテキスト中心設計で画像添付は現状未実装のため実害なし
- **3rd poster 追加時の改修点増加**: Mastodon / Threads 等を将来追加する場合、`x_posted` / `bluesky_posted` と同様の checkbox を Notion DB に手動追加する必要がある。追加コストは checkbox 1 列 + 数行の条件分岐で軽微
- **Keepa 単一障害点**: Keepa が長時間ダウンした場合、draft が一切生成されない。ADR-001 Scope out に「外部 DB 追加」は含まれないため、現状は run-log 監視 + ユーザー手動対応で吸収する

## Alternatives Considered

| Alternative | Reason rejected |
|---|---|
| PA-API 代替として Amazon Creators API に移行 | Creators API は購買履歴・Creator アカウント前提であり、アフィリエイト目的の一般 PA-API 代替にならない。別 Spec で評価予定 (Spec §10 OoS) |
| `anySucceeded` を維持しつつ警告 log のみ追加 | X 失敗が Notion 上から見えない問題が残る。再送の操作性も改善されない |
| platform checkbox を bot が自動追加 (Notion API で property 作成) | Notion DB property の自動作成は schema 設計の意図しない拡散を招く。手動 1 回の操作で完結するため自動化コストが正当化されない |

## Related

- Spec: https://www.notion.so/PAAPI-Notion-platform-status-silent-loss-3633ad52d5ca8191beacd34cb220ec51
- Spec §10 Out of Scope: Creators API 移行の評価、Mastodon / Threads 対応
- ADR-001: Project Foundation (PA-API 採用の初期判断)
- ADR-004: Run log Notion DB と Notion API retry/timeout (run-log monitor、best-effort 設計)
