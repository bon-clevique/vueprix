// Bluesky spam label 対策: 直前投稿から最低 5 分、ランダムで 5〜15 分の間隔を空けてから
// 次の投稿を送る gate。経過時間は Bluesky API (getAuthorFeed) で自分の最新 top-level post の
// createdAt を取得して算出する (GitHub Actions ステートレス前提で外部状態を持たない設計)。
//
// 設計 invariant:
//   - 関数は純粋 (副作用なし、入力 Date のみで判定)。test では now を fixed Date で渡す
//   - "lastPostAt が null = 初回 / 取得不可" は **fail-safe で false (投稿しない)** ではなく
//     **true (投稿する)** を返す。Bluesky API 失敗時の fail-safe は呼び出し側 (publish.ts)
//     で「lastPostAt 取得失敗 → 投稿しない」を別途実装する責務 (本 module は state がある
//     前提で純粋判定だけ行う)
//   - random は引数注入可。test で再現性を持たせる
//
// scope 注: 同一文面の連投 diversification は本 module の対象外 (依頼文の禁止事項通り別 PR 予定)。
// 本 gate は単に「時間間隔」のみを制御する。

// 5〜15 分 (= 5 + random*10) を返す。デフォルト Math.random、test では fixed RNG を渡す。
export const computeRequiredMinutes = (rng: () => number = Math.random): number =>
  rng() * 10 + 5;

// 投稿可否判定。lastPostAt=null は「初回 or 直近投稿なし」とみなして true。
// 呼び出し側が「API 取得失敗時は投稿しない」を別途扱う前提 (lastPostAt 取得 throw を catch する責務は publish.ts)。
export const shouldPost = (
  lastPostAt: Date | null,
  now: Date,
  requiredMinutes: number,
): boolean => {
  if (!lastPostAt) return true;
  const elapsedMs = now.getTime() - lastPostAt.getTime();
  const requiredMs = requiredMinutes * 60 * 1000;
  return elapsedMs >= requiredMs;
};

// log 出力用 helper。経過分数を小数 1 桁で返す。
export const elapsedMinutes = (lastPostAt: Date, now: Date): number =>
  Math.round(((now.getTime() - lastPostAt.getTime()) / 60_000) * 10) / 10;
