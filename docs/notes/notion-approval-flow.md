# Notion 承認フロー運用手順

vueprix は Amazon 値下がり候補を **Notion DB「vueprix 投稿文」に Status=backlog として書き込み → bon が手動でサクラチェッカーを確認 → 採用なら Status を doing に変更 → Notion AI で `投稿文` を生成 → Status を approved に変更 → Notion automation の Webhook が GitHub `repository_dispatch` を発火 → `bot-publish.yml` workflow が X / Bluesky に投稿** という 4-stage pipeline で運用する。

サクラチェッカーの自動呼び出しは規約・robots.txt 違反のため恒久的に対象外 (`docs/adr/002-notion-approval-flow.md` 参照)。

## Status ライフサイクル

- **`backlog`**: bot が cron で作成した直後の候補 (`投稿文` 空)
- **`doing`**: bon が採用判断後、Notion AI で `投稿文` を作成中の状態 (作業中であることの可視化)
- **`approved`**: 文面 + レビュー完了。Notion automation が webhook を発火し publish へ
- **`posted`**: publish 完了 (X / Bluesky 投稿成功、`投稿日時` セット済)
- **`rejected`**: 投稿しないと判断したが、**運用ガイドラインとして残す価値がある** ネタ。理由のない不採用は Notion ページごと archive/delete (rejected に置かない)

`doing` で長期放置されたものは自動 expire しない。週次レビューで `doing` フィルタを確認し、放置を発見したら bon が手動 archive する。

重複防止 (`queryDuplicateAsins`) は 30 日 (720h) 以内かつ Status ∈ {backlog, doing, approved, posted} を対象。**`rejected` は意図的に除外**: 価格が変わって同 ASIN が再度値下がりすれば backlog として再候補化を許可する。永久ブロックは `data/blocklist.md` または Notion ブラックリスト DB を使う (`queryBlacklistAsins`)。

## DB スキーマ

DB: 「vueprix 投稿文」(`collection://35b3ad52-d5ca-80f3-b57f-000b174abea1`)

| プロパティ | Type | 説明 |
|---|---|---|
| 名前 | title | 商品名 (Notion 必須プロパティ) |
| 投稿文 | rich_text | X / Bluesky 両用本文 (Notion AI で生成、draft 時は空文字列で作成、X 上限 280 chars 制約) |
| ASIN | rich_text | Amazon ASIN (10 文字) |
| Status | status | `backlog` / `doing` / `approved` / `posted` / `rejected` (PR-8 で select → status type、Status 再設計で expired/pending_review 廃止) |
| 候補生成日時 | date | draft 作成タイムスタンプ |
| 投稿日時 | date | publish 完了タイムスタンプ |
| サクラチェッカーURL | url | `https://sakura-checker.jp/search/<ASIN>/` |
| Amazon URL | url | アフィリエイト付き商品 URL |
| 通常価格 | number (yen) | 参考価格 |
| セール価格 | number (yen) | 現在価格 |
| 割引率 | number (percent) | 0.15 = 15% (Notion percent property の保存形式) |
| カテゴリ | select | `food` / `health` / `pc-desk` / `gaming` / `audio` / `fixed-list` |
| 関連ガイドライン | relation | (任意) ガイドライン DB へのリンク |
| x_posted | checkbox | X への投稿成功フラグ (bon 手動追加; 未 true の場合 publish 時に再送対象になる) |
| bluesky_posted | checkbox | Bluesky への投稿成功フラグ (bon 手動追加; 未 true の場合 publish 時に再送対象になる) |

## Notion automation (Status changed to approved → Webhook)

Notion Plus 加入が前提。DB のオートメーションメニューから:

1. **トリガー**: 「プロパティが変更されたとき」 → `Status` が `approved` に変わったとき
2. **アクション**: 「Webhook を送信」
3. **URL** (Cloudflare Worker — 実 URL は `worker/` deploy 後に確定):
   ```
   https://vueprix-webhook-proxy.<subdomain>.workers.dev
   ```
4. **Headers** (`Content-Type` は **設定しない** — Notion automation の custom header UI は `Content-Type` を予約済で受け付けない制約があるため。Body が JSON の場合は Notion 本体が `application/json` を自動付与する):
   ```
   X-Notion-Secret: <NOTION_SHARED_SECRET>
   ```
5. **Body**: 空欄でよい。

Notion automation の Webhook アクションは body 欄が空でも以下の envelope JSON を自動送信する (2026-05-10 wrangler tail 実機確認):

```json
{
  "source": {
    "type": "automation",
    "automation_id": "...",
    "action_id": "...",
    "event_id": "...",
    "user_id": "...",
    "attempt": 1
  },
  "data": {
    "object": "page",
    "id": "<対象 row の UUID>",
    "created_time": "...",
    "last_edited_time": "...",
    "created_by": { ... },
    "last_edited_by": { ... }
  }
}
```

Worker は `data.id` を target page UUID として抽出する。`event_type` は Worker が `DISPATCH_EVENT_TYPE` env var から再宣言するため Notion 側で渡す必要は無い。

### Worker の受信仕様

- Worker は `req.text()` で body を読み出し、先頭が `{` なら Notion automation envelope の `data.id` を `JSON.parse` で抽出する
- JSON parse 失敗 / `data.id` 不在 / `data.id` が string でないケースでは plain text 全体を `trim()` して fallback (curl smoke test で UUID 単体を投げる経路の後方互換性維持)
- 抽出した値を end-anchored UUID regex で全文 match (dashed 8-4-4-4-12 / undashed 32 hex、mixed-dash は reject)
- 前後 whitespace / 末尾改行は trim で吸収するため安全
- 旧形式の JSON body (`{"page_id":"..."}`) は `data.id` を持たないため regex 評価前に弾かれ `400 Bad Request` で reject される (silent ignore ではない)

## Cloudflare Worker 中間プロキシ (`worker/`)

Notion → GitHub を直結する代わりに Cloudflare Worker (`vueprix-webhook-proxy`) を間に挟む。理由:

- GitHub PAT は Notion automation 設定欄に平文で格納されるため、Notion アカウント侵害時に **PAT が抜き取られる threat** が存在した
- Worker を挟むことで PAT は Cloudflare Worker secrets に格納され、Notion からは見えない。Notion 側には Worker と Notion で共有する **`NOTION_SHARED_SECRET`** のみを置く
- Notion アカウント侵害時の最大被害は「shared secret が漏洩 → 攻撃者が Worker に repository_dispatch を発火させ得る」だが、PAT 本体は守られる。さらに Worker secret を rotate するだけで遮断できる (PAT 再発行不要)

### Worker contract

| 項目 | 値 |
|---|---|
| メソッド | `POST` のみ (それ以外 405) |
| 認証 | `X-Notion-Secret` header と Worker secret の constant-time 比較 |
| 入力 | (1) Notion automation envelope JSON body の `data.id` (本番経路) / (2) plain text body = UUID 単体 (curl smoke test の後方互換、dashed / undashed 両対応、前後 whitespace は trim) |
| 成功 | `202` を返却し、GitHub `repository_dispatch` を `event_type=vueprix-publish` で発火 |
| 失敗 | 401 (auth) / 400 (validation, 空 body / 非 UUID / envelope に `data.id` 不在 / 旧 `{"page_id":"..."}` JSON) / 502 (GitHub API non-2xx) |

詳細・deploy 手順 → `worker/README.md`

### Secrets ownership

| Secret | 保管場所 | rotate 手段 |
|---|---|---|
| `GITHUB_PAT` | Cloudflare Worker secrets | `wrangler secret put GITHUB_PAT` で上書き |
| `NOTION_SHARED_SECRET` | Worker secrets (Cloudflare 側) + Notion automation header (Notion 側) | Worker 側で `wrangler secret put` → Notion 側 header を同じ値に揃える |

## GitHub PAT (fine-grained personal access token)

PAT は Cloudflare Worker secrets に格納される。Worker secrets は Notion からは見えないが、Cloudflare アカウント侵害時の最大被害を抑えるため引き続き fine-grained で最小権限・短期有効期限で発行する:

1. GitHub Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token
2. **Resource owner**: bon
3. **Repository access**: Only select repositories → `vueprix` のみ
4. **Repository permissions**:
   - Contents: **Read and write** ← `repository_dispatch` API の正しい必要権限
   - Metadata: **Read-only** (PAT 必須)
   - Actions: **Read-only** (任意、`gh run` 系で workflow run 状態を確認したい場合に追加)

> **重要**: GitHub の `repository_dispatch` API は historical reason により response header の `x-accepted-github-permissions: contents=write` で示される通り **Contents 権限**を要求する。GitHub docs UI 上の表記 (「Actions」) は誤解を招くため要注意。2026-05-11 の実機検証で `Actions: Read and write` のみでは 403 になり、`Contents: Read and write` を追加して 204 になることを確認済。

5. **有効期限**: 90 日
6. ローテーション運用: 期限到来 1 週間前にカレンダー通知 → 新 PAT 発行 → `wrangler secret put GITHUB_PAT` で Worker secret を上書き → 旧 PAT を revoke

### Threat model: PAT compromise

PAT は **Cloudflare Worker secrets に格納**される (PR-4 以降)。Notion 側には PAT を置かず、代わりに `NOTION_SHARED_SECRET` (Worker と Notion で共有) のみを置く。漏洩時の最大被害と緩和を整理する:

| 漏洩経路 | 最大被害 | 緩和 |
|---|---|---|
| Notion アカウント侵害 (パスワード流出 / セッション hijack) | 攻撃者が `NOTION_SHARED_SECRET` を読める。Worker に repository_dispatch を任意発火させ得る (PAT 本体は抜けない) | (1) `wrangler secret put NOTION_SHARED_SECRET` で 1 コマンド rotate (PAT 再発行不要)。(2) `fetchPageById` が Status=approved でない page を reject。(3) 投稿日時セット済 page も二重ガードで reject。攻撃者が新規 page を Notion 側で作って approve しないと publish できない (= 既に Notion 編集権を持っているのと等価)。GitHub secrets (X / Bluesky tokens) は workflow run logs に出ない限り抜き取れない |
| Cloudflare アカウント侵害 (Worker secret 直接流出) | PAT が流出 → repository_dispatch 任意発火 + Contents 権限による file 改変 (default branch への push が可能、ただし Branch protection で防御) + Actions ログ閲覧。secrets は変数展開された後の log にしか出ないが、攻撃者が `echo "$X_API_KEY"` を含む workflow を PR 経由で merge できれば抜ける | (1) PAT は fine-grained, repository limit=`vueprix` only, permission=Contents write / Metadata read のみ。(2) Branch protection で main への direct push 禁止 → workflow 改変は PR レビュー経由のみ (Contents:Write でも main への直接 push は protection でブロック)。(3) Cloudflare 側に 2FA + hardware key 必須 |

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
3. Cloudflare Worker (`vueprix-webhook-proxy`) が起動しているか (Cloudflare dashboard でログ確認)
4. `X-Notion-Secret` header が Worker secret と一致しているか (Worker ログに 401 が出ていれば mismatch)
5. PAT 有効期限切れではないか (Worker ログに `GitHub dispatch failed: 401` が出ていれば PAT 失効)
6. GitHub Actions タブで `bot-publish.yml` の実行履歴を確認

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
3. 重複投稿リスクを抑えたいなら `posted.json` (asin 単位の履歴) との突合を考慮。現行 COOLDOWN_HOURS=720 (30 日) で `queryDuplicateAsins` 経由の draft 段階重複は自動回避される

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
