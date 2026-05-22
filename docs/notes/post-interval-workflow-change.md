# bot-publish.yml 手動適用パッチ (PR: post-interval)

本 PR の `.github/workflows/bot-publish.yml` への変更は、GitHub App の `workflows` 権限が
ない claude/agent 経由では push できなかったため、ここに差分を残す。bon が手動で
`.github/workflows/bot-publish.yml` に適用してから merge / 反映する想定。

## 目的

- Bluesky spam label 対策: Notion automation の即時 `repository_dispatch` を廃止、
  GitHub Actions の `schedule: */5 * * * *` 起動に切り替える。
- 各 cron 実行で Notion から `Status=approved` の oldest 1 件のみ投稿し、残りは次回繰越。
- `src/publish.ts` 内の interval gate (5〜15 分ランダム) と合わせて Bluesky 連投を防ぐ。

## 運用変更チェックリスト

- [ ] Notion automation 側で「Status=approved → repository_dispatch 発火」アクションを **停止** する
- [ ] GitHub Secrets に `BLUESKY_IDENTIFIER` / `BLUESKY_APP_PASSWORD` / `BLUESKY_DID` を追加
      (旧 `BSKY_IDENTIFIER` / `BSKY_PASSWORD` は fallback として残置可。両方設定でも OK)
- [ ] 本 diff を `.github/workflows/bot-publish.yml` に適用、PR の他コミットと同 branch に push

## Diff

```diff
diff --git a/.github/workflows/bot-publish.yml b/.github/workflows/bot-publish.yml
--- a/.github/workflows/bot-publish.yml
+++ b/.github/workflows/bot-publish.yml
@@ -1,24 +1,31 @@
 name: vueprix-publish

-# Triggered by Notion automation when a draft's Status changes to "approved".
-# Notion sends a repository_dispatch with event_type=vueprix-publish and
-# client_payload.page_id pointing at the approved row.
+# Bluesky spam label 対策 (PR: post-interval):
+# 旧来は Notion automation の repository_dispatch で approved 行ごとに即時 publish していたが、
+# 短時間連投で Bluesky から spam label を受けた。本 PR で以下に変更:
+#   - cron */5 で起動し、Notion から approved 行を取得 → oldest 1 件のみ投稿 (キュー消化方式)
+#   - publish.ts 内で直前の Bluesky 自前 top-level post から 5〜15 分 (ランダム) 経過しているか判定
+#   - 不足なら exit 0 で次回 cron に持ち越し (Status=approved のまま据え置き)
+# Notion automation 側は repository_dispatch を発火しないよう停止する運用 (本 workflow からは廃止)。
 #
 # Required secrets (same set as bot.yml plus X/Bluesky):
 #   KEEPA_API_KEY (unused at runtime, kept for parity if publish needs it later)
 #   AMAZON_PARTNER_TAG (Amazon Associate ID)
 #   X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET
-#   BSKY_IDENTIFIER, BSKY_PASSWORD
+#   BLUESKY_IDENTIFIER, BLUESKY_APP_PASSWORD, BLUESKY_DID
+#     (互換: BSKY_IDENTIFIER / BSKY_PASSWORD も fallback で読まれる。secrets rename 期は両方設定可)
 #   NOTION_API_KEY, NOTION_VUEPRIX_DATA_SOURCE_ID

 on:
-  repository_dispatch:
-    types: [vueprix-publish]
+  schedule:
+    # 5 分間隔 polling。1 cron で approved 1 件のみ投稿、残りは次回繰越。
+    # interval gate (5〜15 分) と合わせて連投を防ぐ。
+    - cron: '*/5 * * * *'
   workflow_dispatch:
     inputs:
       page_id:
-        description: 'Notion page ID to publish (manual retry)'
-        required: true
+        description: 'Notion page ID to publish (manual single retry; empty = drain mode)'
+        required: false

 permissions:
   contents: read
@@ -50,17 +57,33 @@ jobs:

       - name: Publish approved draft
         env:
+          # PAGE_ID は workflow_dispatch.inputs.page_id を受け取る。schedule (cron) では未指定 = 空文字 →
+          # publish.ts は drain mode に切り替わり Notion の oldest approved を 1 件投稿する。
           # CRIT-1 対応: page_id を ${{ }} で run: に直接展開すると script injection 余地あり。
           # env var 経由でシェル変数として渡し、shell 側で正しく quote する。
-          PAGE_ID: ${{ github.event.client_payload.page_id || github.event.inputs.page_id }}
+          PAGE_ID: ${{ github.event.inputs.page_id }}
           AMAZON_PARTNER_TAG: ${{ secrets.AMAZON_PARTNER_TAG }}
           X_API_KEY: ${{ secrets.X_API_KEY }}
           X_API_SECRET: ${{ secrets.X_API_SECRET }}
           X_ACCESS_TOKEN: ${{ secrets.X_ACCESS_TOKEN }}
           X_ACCESS_TOKEN_SECRET: ${{ secrets.X_ACCESS_TOKEN_SECRET }}
+          # 移行期は新名 (BLUESKY_*) を優先し、旧名 (BSKY_*) を fallback で読む。
+          # secrets 側で BLUESKY_* を未設定の場合、空文字が渡って src/posters/bluesky.ts の
+          # readBlueskyCredentials が BSKY_* fallback を拾う設計 (process.env 上に空文字を置かない)。
+          BLUESKY_IDENTIFIER: ${{ secrets.BLUESKY_IDENTIFIER }}
+          BLUESKY_APP_PASSWORD: ${{ secrets.BLUESKY_APP_PASSWORD }}
+          BLUESKY_DID: ${{ secrets.BLUESKY_DID }}
           BSKY_IDENTIFIER: ${{ secrets.BSKY_IDENTIFIER }}
           BSKY_PASSWORD: ${{ secrets.BSKY_PASSWORD }}
           NOTION_API_KEY: ${{ secrets.NOTION_API_KEY }}
           NOTION_VUEPRIX_DATA_SOURCE_ID: ${{ secrets.NOTION_VUEPRIX_DATA_SOURCE_ID }}
           LOG_LEVEL: info
-        run: npm run publish -- --page-id "$PAGE_ID"
+        # PAGE_ID が空 (cron 起動 / workflow_dispatch 空入力) なら page-id 引数を付けずに drain mode に渡す。
+        # tsx に空文字を `--page-id ""` で渡すと parseArgs が drain mode に倒すので結果は同じだが、
+        # 引数を省略する方が intent が明示的。
+        run: |
+          if [ -z "$PAGE_ID" ]; then
+            npm run publish
+          else
+            npm run publish -- --page-id "$PAGE_ID"
+          fi
```

## 適用後の確認

```bash
# 適用 → typecheck → 動作確認 (空 queue / dry-run 等)
npm run typecheck
npm run lint
npm test

# GitHub Actions に push 後、Actions タブで vueprix-publish が */5 で起動することを確認。
# 初回は queue 空でも no-op で exit 0 になるのが正常 (CI が赤くならないこと)。
```
