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

### Threat model: PAT compromise

PAT は **Notion automation 設定欄に平文で格納**される (Notion 側の暗号化保護はあるが、bon の Notion アカウントが侵害された場合は閲覧可能)。漏洩時の最大被害と緩和を整理する:

| 漏洩経路 | 最大被害 | 緩和 |
|---|---|---|
| Notion アカウント侵害 (パスワード流出 / セッション hijack) | 攻撃者が `repository_dispatch` を任意発火可。`page_id` を指定して publish workflow を起動できる | (1) `fetchPageById` が Status=approved でない page を reject。(2) 投稿日時セット済 page も二重ガードで reject (本 PR で追加)。攻撃者が新規 page を Notion 側で作って approve しないと publish できない (= 既に Notion 編集権を持っているのと等価)。GitHub secrets (X / Bluesky tokens) は workflow run logs に出ない限り抜き取れない |
| GitHub PAT 漏洩 (PAT 直接流出) | repository_dispatch 任意発火 + Actions ログ閲覧。secrets は変数展開された後の log にしか出ないが、攻撃者が `echo "$X_API_KEY"` を含む workflow を PR 経由で merge できれば抜ける | (1) PAT は fine-grained, repository limit=`vueprix` only, permission=Actions write / Metadata read のみ。(2) Branch protection で main への direct push 禁止 → workflow 改変は PR レビュー経由のみ |

**運用責務**:

- 90 日ローテに加えて、**月 1 回 Actions タブで `bot-publish.yml` の trigger 履歴を確認**する。bon が承認していない時刻に repository_dispatch が走っていれば PAT compromise の可能性 → 即 revoke + 再発行
- `bon 以外が approve したように見える page` が publish された場合も同上 (Notion アカウント侵害シナリオ)
- secrets (X / Bluesky tokens) を抜かれたと判断したら全 token rotate + 過去 90 日の post-history artifact を確認 (任意のなりすまし投稿の有無)

CRIT-1 (page_id script injection) は PR #17 で env var 経由化により閉じた。本 threat model はそれ**以降**の残存リスクを記載している。

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
- `bot-publish.yml` の `concurrency` group は `vueprix-publish-global` (workflow-global serialize) で page 単位ではなく workflow 全体で 1 並行のみに絞っている → これにより同 page の重複だけでなく異なる page 同士の race も完全防止。throughput 影響は 1 cron 20 件程度なので許容範囲
- `fetchPageById` は Status=`approved` 以外で throw → posted 後の再発火は early return される (二重投稿防止 hook)
- Status を間違えて approved に戻した場合は手動で修正、または再 publish を許容するなら no-op とみなす

### approved → 全 poster 失敗
- Status は `approved` のまま残る (`updateStatusToPosted` は呼ばれない)
- 手動で `bot-publish.yml` を `gh workflow run` で再実行可能

### Status を posted から approved に戻さない (運用ルール)

**禁止**: 既に `posted` になっている row の Status を手動で `approved` に戻す操作。

**理由**: `posted` row は「投稿日時」property が既にセット済。Status だけを `approved` に戻すと:

1. Notion automation の trigger 「Status が approved に変わったとき」が再発火 → `repository_dispatch` で publish workflow が再起動
2. `fetchPageById` の Status check は通る (`approved` なので)
3. **二重ガード**: 本 PR で追加した「投稿日時 セット済 → early return」で防御 — `publish.ts` 内で `if (payload.postedAt) { return; }` を実行するため X / Bluesky への二重投稿は **発生しない**
4. ただし `repository_dispatch` の発火と Actions の run history は残るため、運用ノイズにはなる

**再投稿が必要な場合の手順**:

1. 元 row は `posted` のまま放置 (history 保全)
2. 新規 row を duplicate で作成: Notion DB で対象 row を選択 → 「複製」 → 新 row の Status を `pending_review` にし「投稿日時」を空に戻し「候補生成日時」を現在時刻に更新 → bon が承認 → publish 動線で再投稿
3. 重複投稿リスクを抑えたいなら `posted.json` (asin 単位の履歴) との突合で COOLDOWN_HOURS=72 を考慮 (`queryDuplicateAsins` 経由で draft 段階の重複は自動回避される)

### post-history.jsonl の扱い

PR #17 までは GitHub Actions が main へ git commit して累積していたが、
PR-2 (artifact 化) 以降は audit-only として各 run 独立の artifact (90 日保持) に変更。
重複除去は Notion DB の queryDuplicateAsins が SoT で、post-history.jsonl は
使用しない。過去の累積データは git history に残る。

## 関連ファイル

- `src/draft.ts` — Notion DB に Status=pending_review を書き込む entrypoint
- `src/publish.ts` — `--page-id` 受け取り → Status check → 投稿 → Status=posted 更新
- `src/notion.ts` — Notion API ラッパー (Notion API v2026-03-11 対応)
- `.github/workflows/bot.yml` — draft cron (2h)
- `.github/workflows/bot-publish.yml` — repository_dispatch 受信
- `docs/adr/002-notion-approval-flow.md` — 設計判断の背景
