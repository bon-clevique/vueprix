// brand 経路の pipeline export point。
// 現状 brand-watch.ts は collect 専門で publish ロジックを持たない (deals と異なり Notion AI 経路に乗る)。
// 将来 brand 経路に固有の publish / scoring を足すときの拡張 slot として本 file を用意する。
// 現時点では brand-watch.ts からの薄 re-export のみ。
export { collectBrandHits } from '../brand-watch.js';
