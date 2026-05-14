import 'dotenv/config';
import { logger } from './logger.js';
import { main } from './run/orchestrator.js';

// vueprix entrypoint。実装本体は run/orchestrator.ts に分離 (PR-A4)。
// package.json scripts は `tsx src/draft.ts` を参照 — 本 file は薄い shim として保持する。
// test 互換のため main / selectByQuota を re-export し、Candidate 型も draft.ts 経由で取れるようにする。
export { main, selectByQuota } from './run/orchestrator.js';
export type { Candidate } from './types.js';

// vitest 実行中は main() を自動起動しない (test がモジュールを import する際の副作用回避)。
if (!process.env.VITEST) {
  main().catch((err) => {
    // main() 内部で catch + finally まで完結するため、本来ここに来ない。
    // 万一 appendRunLog 自体が throw した場合 (best-effort 設計だが念のため) の最終 fallback。
    // source は orchestrator と揃える (ログ集計の一貫性、本 file 以外で 'draft' は使わない)。
    logger.error('orchestrator', 'unexpected outer error in entrypoint shim', {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    process.exit(1);
  });
}
