# ADR-002: Notion 承認フロー導入 (サクラ確認) + ガジェットカテゴリ追加

**Date**: 2026-05-10
**Status**: Accepted

## Context

ADR-001 (Project Foundation) では Keepa deals + 固定 ASIN を直接 X / Bluesky に自動投稿する単方向 pipeline を採用した。運用の中で 2 つの課題が顕在化した:

1. **サクラレビュー商品の混入リスク**: Amazon にはやらせレビュー (サクラ) 商品が一定数混じっており、これらを bot が自動投稿するとフォロワー信頼性が下がる。サクラチェッカー (`https://sakura-checker.jp/`) の自動呼び出しは規約・robots.txt 上 NG (調査済) で、技術的回避策は無い。ブロックリスト手動メンテだけでは新規流入に追従できない。
2. **カテゴリ拡張の停滞**: ADR-001 時点では「食・健康・生活の質」3 テーマに留めていたが、grok 分析で示された伸びるニッチ領域 (PC・デスク周辺 / ゲーミング / オーディオ・イヤホン) に拡張したい。

並行して、`data/posted.json` による cooldown 管理は GitHub Actions 内 auto-commit に依存しており、Notion DB 側の投稿記録と二重管理になっていた (整合性ずれの素因)。

## Decision

### 1. 承認フロー導入 (人間が approved に変更 → Webhook 発火)

`vueprix-draft` cron 2h は Notion DB に **Status=pending_review** として候補を書き込むだけにする。bon が Notion 上でサクラチェッカー URL を押して手動確認 → Status を **approved** に変更すると、Notion automation (Plus プラン) が GitHub `repository_dispatch` を発火し、`bot-publish.yml` が該当 page を Notion から取得 → X / Bluesky に投稿 → Status=posted に更新する。

10 時間以内に bon が確認しなかった pending_review は次の cron で **expired** に自動マークし、鮮度落ちの値下がり情報を投稿する事故を防ぐ。

### 2. ガジェット 3 カテゴリ追加

Keepa root category を 5 件まで拡張:
- `2127209051` パソコン・周辺機器 → `pc-desk`
- `637394` ゲーム → `gaming`
- `3477981` イヤホン・ヘッドホン本体 → `audio`

既存の `food` / `health` / `fixed-list` と両立。 `MAX_POSTS_PER_RUN=2` のためカテゴリ別頻度制御は当面しない。

### 3. posted.json 廃止 (Notion 一元管理)

- `data/posted.json` を `git rm`
- 重複下書き作成防止は `queryDuplicateAsins` (Notion DB クエリ) で実装
- `loadPosted` / `savePosted` / `markAsPosted` / `prunePosted` / `isAlreadyPosted` を `src/filter.ts` から削除
- `src/index.ts` を `src/draft.ts` (cron 2h) と `src/publish.ts` (`--page-id` 受け取り、repository_dispatch 起動) に分割

## Alternatives considered

### A. ブロックリスト手動運用継続 (現状維持)
**却下**: 承認 UI なし。サクラ判定が後手に回り、流入新規 ASIN へのカバレッジが上がらない。

### B. Polling 方式 (Webhook 不使用)
- bot-publish.yml を 15 分毎の cron で動かし、Notion から approved を逐次取得して投稿
- **利点**: Notion Plus 不要 (free でも `dataSources.query` は使える)
- **欠点**: 15-30 分の遅延、cron 多重起動の整理、Actions 利用枠消費

bon は Notion Plus 加入済 + 鮮度重視のため Webhook を採用。

### C. Slack / LINE 経由承認
- **却下**: Notion DB に既に投稿文と guidelines を一元管理しており、別 UI 追加は複雑化のみ。

### D. サクラチェッカー API/scraping 自動化
- **恒久的に却下**: サクラチェッカー利用規約・`robots.txt` で禁止されている。自動化すれば即 ban + 法的リスク。

## Trade-offs

### 採用したことで失うもの
- **遅延の上振れ**: 自動投稿時代は数秒〜数分で済んでいたが、人間承認が入ると最速 1 分・最遅 10 時間 (expired まで) になる
- **bon の運用負荷**: 1 日 20 件 × 10 秒判定 ≈ 数分/日 を毎日続ける必要あり
- **Notion 依存度上昇**: Notion automation の障害が即 publish 停止に直結
- **GitHub PAT のローテーション運用**: 90 日毎の手動更新作業が増える

### 採用したことで得るもの
- **フォロワー信頼性**: サクラ商品を投稿しないことで bot のレビュー価値を維持
- **Amazon アソシエイト規約違反リスク低減**: 不適切商品の自動投稿リスクが下がる
- **state 一元管理**: posted.json と Notion DB の二重管理が解消、整合性ずれの素因を除去
- **rejected 履歴の自動蓄積**: bon が rejected にした ASIN は Notion DB に残るため、将来 blocklist.md への自動 feedback loop 実装の素地ができる

## Risks & mitigation

| Risk | Mitigation |
|---|---|
| 二重投稿 (Notion automation 重複発火 / 手動 webhook テスト) | publish 冒頭で `fetchPageById` が Status≠approved で throw + workflow concurrency group は page_id 単位 |
| GitHub PAT 漏洩 | fine-grained PAT (vueprix repo + Actions:Write のみ) + 90 日ローテ |
| Notion API レート制限 (3req/s) | 1 cron で expire query + dup query + create 20 件 ≈ 25 calls。逐次実行で十分 |
| 承認 SLA 破綻 (pending 山積) | expired 自動マークで pending を山積させない |
| Keepa category ID 誤り | `scripts/verify-keepa-categories.ts` で事前検証 (`docs/notes/keepa-categories.md` に記録) |
| Notion automation 設定ミス | `docs/notes/notion-approval-flow.md` に再現可能な手順書を記述 |

## Consequences

- ADR-001 の `data/posted.json` 関連記述は本 ADR で **deprecated**
- 新規ファイル: `src/draft.ts`, `src/publish.ts`, `.github/workflows/bot-publish.yml`, `docs/notes/notion-approval-flow.md`
- 削除: `src/index.ts`, `data/posted.json`, `filter.ts` 内 posted.json 関連 export
- 既存 `bot.yml` は `vueprix-draft` に rename + `npm run draft` 実行に変更

## References

- 運用手順: `docs/notes/notion-approval-flow.md`
- Notion API v2026-03-11: https://developers.notion.com/docs/upgrade-guide-2026-03-11
- GitHub repository_dispatch: https://docs.github.com/en/rest/repos/repos#create-a-repository-dispatch-event
