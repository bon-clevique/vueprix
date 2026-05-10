# Notion 承認フロー運用手順

vueprix は Amazon 値下がり候補を **Notion DB「vueprix 投稿文」に Status=pending_review として書き込み → bon が手動でサクラチェッカーを確認 → Status=approved に変更 → Notion automation の Webhook が GitHub `repository_dispatch` を発火 → `bot-publish.yml` workflow が X / Bluesky に投稿** という 2-stage pipeline で運用する。

サクラチェッカーの自動呼び出しは規約・robots.txt 違反のため恒久的に対象外 (`docs/adr/002-notion-approval-flow.md` 参照)。

## DB スキーマ

DB: 「vueprix 投稿文」(`collection://35b3ad52-d5ca-80f3-b57f-000b174abea1`)

| プロパティ | Type | 説明 |
|---|---|---|
| 名前 | title | 商品名 (Notion 必須プロパティ) |
| 理由 | rich_text | Claude 生成の生活シーン文 |
| ASIN | rich_text | Amazon ASIN (10 文字) |
| 投稿文_X | rich_text | X 用に組み立て済の本文 (≤280 chars) |
| 投稿文_Bluesky | rich_text | Bluesky 用に組み立て済の本文 (≤300 chars) |
| Status | select | `pending_review` / `approved` / `rejected` / `posted` / `expired` |
| 候補生成日時 | date | draft 作成タイムスタンプ |
| 投稿日時 | date | publish 完了タイムスタンプ |
| サクラチェッカーURL | url | `https://sakura-checker.jp/search/<ASIN>/` |
| Amazon URL | url | アフィリエイト付き商品 URL |
| 通常価格 | number (yen) | 参考価格 |
| セール価格 | number (yen) | 現在価格 |
| 割引率 | number (percent) | 0.15 = 15% (Notion percent property の保存形式) |
| カテゴリ | select | `food` / `health` / `pc-desk` / `gaming` / `audio` / `fixed-list` |
| DryRun | checkbox | `DRY_RUN=true` で生成された候補かを区別 |
| 関連ガイドライン | relation | (任意) ガイドライン DB へのリンク |

## Notion automation (Status changed to approved → Webhook)

Notion Plus 加入が前提。DB のオートメーションメニューから:

1. **トリガー**: 「プロパティが変更されたとき」 → `Status` が `approved` に変わったとき
2. **アクション**: 「Webhook を送信」
3. **URL**:
   ```
   https://api.github.com/repos/<owner>/vueprix/dispatches
   ```
4. **Headers**:
   ```
   Authorization: Bearer <GitHub PAT>
   Accept: application/vnd.github+json
   User-Agent: vueprix-notion-bot
   ```
5. **Body** (JSON):
   ```json
   {
     "event_type": "vueprix-publish",
     "client_payload": {
       "page_id": "{{Page ID}}"
     }
   }
   ```

`{{Page ID}}` は Notion automation が自動展開する変数。

## GitHub PAT (fine-grained personal access token)

PAT は Notion automation 内に平文で格納されるため fine-grained で最小権限・短期有効期限で発行する:

1. GitHub Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token
2. **Resource owner**: bon
3. **Repository access**: Only select repositories → `vueprix` のみ
4. **Repository permissions**:
   - Actions: **Read and write**
   - Metadata: **Read-only** (PAT 必須)
5. **有効期限**: 90 日
6. ローテーション運用: 期限到来 1 週間前にカレンダー通知 → 新 PAT 発行 → Notion automation 設定で差し替え → 旧 PAT を revoke

## 承認 SLA と expired ステート

- 候補生成日時から **10 時間以内** に bon が承認することを期待値とする
- 10 時間経過した `pending_review` は次の `vueprix-draft` cron 実行時に **`expired`** に自動マークされる (`expireOldDrafts` in `src/notion.ts`)
- expired は再投稿可能性なし。鮮度落ちの値下がり情報を投稿することによるフォロワー信頼性低下を防ぐ

## トラブルシュート

### Webhook が発火しない
1. Notion automation の有効/無効を確認
2. Status が `approved` に変更されているか (型を間違えて他 select option を作っていないか)
3. PAT 有効期限切れではないか (gh API で 401 が出る)
4. GitHub Actions タブで `bot-publish.yml` の実行履歴を確認

### Webhook 発火するが publish workflow が動かない
1. `gh run list -R <owner>/vueprix --workflow bot-publish.yml --limit 5`
2. 失敗 run があれば `gh run view <run-id> --log-failed`
3. NOTION_API_KEY / NOTION_VUEPRIX_DATA_SOURCE_ID が GitHub secrets に設定されているか

### 二重発火対策
- `bot-publish.yml` の `concurrency` group は `vueprix-publish-${{ page_id }}` で page 単位に絞っている → 同 page への重複発火は直列化される
- `fetchPageById` は Status=`approved` 以外で throw → posted 後の再発火は early return される (二重投稿防止 hook)
- Status を間違えて approved に戻した場合は手動で修正、または再 publish を許容するなら no-op とみなす

### approved → 全 poster 失敗
- Status は `approved` のまま残る (`updateStatusToPosted` は呼ばれない)
- 手動で `bot-publish.yml` を `gh workflow run` で再実行可能

## 関連ファイル

- `src/draft.ts` — Notion DB に Status=pending_review を書き込む entrypoint
- `src/publish.ts` — `--page-id` 受け取り → Status check → 投稿 → Status=posted 更新
- `src/notion.ts` — Notion API ラッパー (Notion API v2026-03-11 対応)
- `.github/workflows/bot.yml` — draft cron (2h)
- `.github/workflows/bot-publish.yml` — repository_dispatch 受信
- `docs/adr/002-notion-approval-flow.md` — 設計判断の背景
