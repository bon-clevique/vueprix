# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Breaking Changes
- **env rename**: `PAAPI_PARTNER_TAG` → `AMAZON_PARTNER_TAG`。GitHub Secrets (`Settings → Secrets → Actions`) およびローカル `.env` での更新が必須
- **`pickReferencePrice` signature 変更**: `savingBasis` 引数を撤去し 2 引数版に統一。外部から直接呼び出しているコードは引数リストを修正すること
- **Notion DB「vueprix 投稿文」に `x_posted` / `bluesky_posted` (checkbox) property の追加必須**。プロパティが存在しない場合、`fetchPageById` での抽出が undefined になり per-platform skip ロジックが機能しない

### Removed
- PA-API 連携を完全削除: `src/paapi.ts` / `paapi.test.ts` / `scripts/verify-paapi-saving-basis.ts` を物理削除
- `'paapi-saving-basis'` enum 値を `SavingBasis` 型から削除

### Changed
- reference price chain を Keepa-only に統一: `list-price (avg[4]) → amazon-avg → new-avg → min-90d`

### Added
- Initial project setup with TypeScript, vitest, and GitHub Actions
- Keepa / PA-API / Claude / X / Bluesky integrations (DRY_RUN=true 初期)
- X poster の構造化 error log: `{ asin, status, code, type, detail }` を別行に出力 (secret env 値は `[REDACTED]` 置換)
- 投稿量増加: Keepa `/deal` を 3 ページ巡回 (KEEPA_DEAL_PAGES=3)、deltaRange 上限を撤廃
- KEEPA_CATEGORIES に `3828871` (kitchen) / `159241011` (stationery) を追加
- WATCH_BRANDS に KINTO / OXO / ZOJIRUSHI / TIGER / Pyrex / MUJI を追加
- `selectByQuota` に Pass2 overflow を追加。未消化カテゴリ枠を MAX_POSTS_PER_RUN 上限まで dropPercent 降順で再分配
- Notion draft / posted page に「参考価格ソース」の callout block を append。bon が値下げコピー採用を判断する材料
- `Candidate.referenceSource` / `DraftCandidate.referenceSource` フィールドを追加 (`ReferenceSource` 型に `week-avg` を追加)
- health / kitchen / audio の title whitelist にキーワード追加

### Changed
- `CATEGORY_QUOTA` 中庸プリセット化 (food:10 health:8 kitchen:5 stationery:5 pc-desk:5 audio:3 gaming:2)
- `MAX_POSTS_PER_RUN` 30 → 60

### Fixed
- per-platform partial 成功の silent loss を解消: `anySucceeded` → `allRequiredSucceeded` に変更し、X 失敗時は `x_posted` checkbox のみ更新して Status を `approved` に保持
- bookmark append 失敗時の fatal 化を修正: `appendPostBookmarks` を try/catch で wrap し、失敗は `logger.error` で記録して続行 (non-fatal)
