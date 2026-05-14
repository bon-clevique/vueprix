import path from 'node:path';

// 相対 path を cwd 基準で絶対 path に解決。絶対 path はそのまま返す。
// 旧: blocklist.ts:15-16 / history.ts:23-24 に完全同一実装が重複していたため、PR-A B9 で共通化。
// CI / GitHub Actions runner / local dev のどこから起動しても data/*.{jsonl,md} 等を
// 同じ規約で解決できる。
export const resolvePath = (filePath: string): string =>
  path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
