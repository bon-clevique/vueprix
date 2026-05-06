# Keepa Category IDs (Amazon.co.jp / domain=5)

Verified 2026-05-06 via `scripts/verify-keepa-categories.ts` against the live Keepa `/category` endpoint.

## Configured (`src/config.ts` `KEEPA_CATEGORIES`)

| ID | Name | productCount | Notes |
|---|---|---|---|
| `57239051` | 食品・飲料・お酒 | 2,192,897 | root, isBrowseNode=true. children: 23306250051, 57240051, 2486361051 |
| `160384011` | ドラッグストア | 3,577,632 | root, isBrowseNode=true |

## Previously misconfigured (corrected on 2026-05-06)

| Old ID | Actual name |
|---|---|
| `2277721051` | ホビー (NOT 食品・飲料) |
| `2250739051` | カテゴリー別 (NOT ドラッグストア — generic catch-all) |

## Re-running verification

```bash
KEEPA_API_KEY=<key> npx tsx scripts/verify-keepa-categories.ts
```

Token cost: 1 token per category lookup (2 tokens total for the configured pair).

## Reference

- Keepa docs: https://discuss.keepa.com/t/category-api/779
- Amazon.co.jp Browse Node IDs are equivalent to Keepa `catId` for the same domain.
