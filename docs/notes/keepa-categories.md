# Keepa Category IDs (Amazon.co.jp / domain=5)

Verified 2026-05-06 via `scripts/verify-keepa-categories.ts` against the live Keepa `/category` endpoint.

## Configured (`src/config.ts` `KEEPA_CATEGORIES`)

| ID | Name | productCount | Notion category | Notes |
|---|---|---|---|---|
| `57239051` | 食品・飲料・お酒 | 2,192,897 | `food` | root. children: 23306250051, 57240051, 2486361051 |
| `160384011` | ドラッグストア | 3,577,632 | `health` | root |
| `2127209051` | パソコン・周辺機器 | 6,414,686 | `pc-desk` | root (verified 2026-05-10) |
| `637394` | ゲーム | 489,770 | `gaming` | root (verified 2026-05-10). Smaller than expected — Keepa's data may exclude DL-only titles |
| `3477981` | イヤホン・ヘッドホン本体 | 92,977 | `audio` | leaf-ish (verified 2026-05-10). 「家電&カメラ」(3210981, 23.7M) は範囲広すぎのため audio 用途では sub に絞った |

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
