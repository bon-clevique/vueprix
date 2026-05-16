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
| `3828871` | ホーム&キッチン | TBD | `kitchen` | root (PR-volume-1 で追加、要 verify)。Amazon.co.jp 標準 browse node。 |
| `159241011` | 文房具・オフィス用品 | TBD | `stationery` | root (PR-volume-1 で追加、要 verify)。Amazon.co.jp 標準 browse node。 |

> **TODO**: `3828871` / `159241011` は Amazon.co.jp に長期存在する root browse node だが、Keepa の category index 同期状況は時期によって変動するので、`scripts/verify-keepa-categories.ts 3828871 159241011` を deploy 前に走らせて productCount / name を確認すること。0 件返却が続く場合は ID 変更の可能性 (`docs/notes/keepa-categories.md` の "Previously misconfigured" セクションを参照)。

## Previously misconfigured (corrected on 2026-05-06)

| Old ID | Actual name |
|---|---|
| `2277721051` | ホビー (NOT 食品・飲料) |
| `2250739051` | カテゴリー別 (NOT ドラッグストア — generic catch-all) |

## Removed on 2026-05-14 (PR-A B10 verify)

`tsx scripts/verify-keepa-categories.ts 3833931 86893051` の結果に基づき、`KEEPA_CATEGORIES` と
`KEEPA_CATEGORY_MAP` から両 ID を削除した。

| Removed ID | Was mapped to | Verify result | 削除理由 |
|---|---|---|---|
| `3833931` | `kitchen` | Keepa response に該当 entry なし (not found) | 該当 ID が実在しないため deals 経路で 0 件返却され続けていた |
| `86893051` | `stationery` | 「果物」productCount 17,847 (root level) | 「文房具・オフィス用品」を期待していたが実体は果物。`57239051` (食品・飲料・お酒、2.2M) に包含されるため重複 collect になる |

`NotionCategory` 型の `kitchen` / `stationery` option は `BRAND_CATEGORY_MAP` (brand 経路) と将来拡張のため Notion select option として残置。`CATEGORY_QUOTA` の `kitchen: 3` / `stationery: 3` も deals 経路に未供給だが brand 経路の合流時 cap として機能する (現状 brand は selectByQuota を通さないため事実上は no-op、将来 brand を quota 統合する際に活用可能)。

## Re-running verification

```bash
KEEPA_API_KEY=<key> npx tsx scripts/verify-keepa-categories.ts
```

Token cost: 1 token per category lookup (2 tokens total for the configured pair).

## Reference

- Keepa docs: https://discuss.keepa.com/t/category-api/779
- Amazon.co.jp Browse Node IDs are equivalent to Keepa `catId` for the same domain.
