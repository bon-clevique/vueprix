# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial project setup with TypeScript, vitest, and GitHub Actions
- Keepa / PA-API / Claude / X / Bluesky integrations (DRY_RUN=true 初期)
- 投稿量増加: Keepa `/deal` を 3 ページ巡回 (KEEPA_DEAL_PAGES=3)、deltaRange 上限を撤廃
- KEEPA_CATEGORIES に `3828871` (kitchen) / `159241011` (stationery) を追加
- WATCH_BRANDS に KINTO / OXO / ZOJIRUSHI / TIGER / Pyrex / MUJI を追加
- `selectByQuota` に Pass2 overflow を追加。未消化カテゴリ枠を MAX_POSTS_PER_RUN 上限まで dropPercent 降順で再分配
- deals/brand 経路でも PA-API SavingBasis があれば reference を再解決し、Amazon UI と一貫させる (`applySavingBasis`)
- Notion draft / posted page に「参考価格ソース」の callout block を append。bon が値下げコピー採用を判断する材料
- `Candidate.referenceSource` / `DraftCandidate.referenceSource` フィールドを追加 (`ReferenceSource` 型に `week-avg` を追加)
- health / kitchen / audio の title whitelist にキーワード追加

### Changed
- `CATEGORY_QUOTA` 中庸プリセット化 (food:10 health:8 kitchen:5 stationery:5 pc-desk:5 audio:3 gaming:2)
- `MAX_POSTS_PER_RUN` 30 → 60
