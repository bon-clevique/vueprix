import { describe, expect, it } from 'vitest';
import * as brandPipeline from './brand.js';
import { collectBrandHits } from '../brand-watch.js';

// pipelines/brand.ts は現状 brand-watch.ts の薄 re-export。実体の test は brand-watch.test.ts が担当。
// 本 file は「pipelines layer から brand を取り出せる」事実だけを pin down する smoke test。
// 将来 brand 経路に固有 publish ロジックが追加されたら、このファイルに本格 test を追加する。

describe('pipelines/brand re-export contract', () => {
  it('exposes collectBrandHits identical to brand-watch.collectBrandHits', () => {
    expect(brandPipeline.collectBrandHits).toBe(collectBrandHits);
  });
});
