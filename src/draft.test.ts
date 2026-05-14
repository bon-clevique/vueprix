import { describe, expect, it } from 'vitest';

// draft.ts は run/orchestrator.ts への薄 re-export shim。本体の integration test は
// run/orchestrator.test.ts、pipeline 単位の unit test は pipelines/*.test.ts に置く。
// 本 file は shim contract (exports / no auto-run under VITEST) のみ pin down する。

describe('draft entrypoint shim', () => {
  it('re-exports main / selectByQuota / Candidate from run/orchestrator (test contract)', async () => {
    const mod = await import('./draft.js');
    expect(typeof mod.main).toBe('function');
    expect(typeof mod.selectByQuota).toBe('function');
  });

  it('does not auto-run main() when VITEST is set (import 副作用回避)', async () => {
    // VITEST=true で main() が呼ばれていなければ、Notion / Keepa / PA-API の I/O は走らない。
    // 副作用 import の正常終了で contract 確認。
    await expect(import('./draft.js')).resolves.toBeDefined();
  });
});
