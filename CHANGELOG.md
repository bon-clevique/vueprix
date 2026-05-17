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

### Fixed
- per-platform partial 成功の silent loss を解消: `anySucceeded` → `allRequiredSucceeded` に変更し、X 失敗時は `x_posted` checkbox のみ更新して Status を `approved` に保持
- bookmark append 失敗時の fatal 化を修正: `appendPostBookmarks` を try/catch で wrap し、失敗は `logger.error` で記録して続行 (non-fatal)
