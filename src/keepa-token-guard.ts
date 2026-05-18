import { KEEPA_TOKEN_THRESHOLD } from './config.js';

/**
 * Keepa API token 残量を tracking し、低残量時の call を抑止する防御層。
 *
 * 設計:
 * - `tokensLeft === null` (initial state) は「未 update」を意味し、shouldCall は true を返す。
 *   最初の Keepa call で response の tokensLeft が判明し updateTokensLeft で update される。
 * - `tokensLeft <= threshold` (less-than-or-equal) の場合は call を skip (false)。
 *   threshold=10 なら 1 call (~5-6 token) 余裕を持って次 call 可能、それ未満は借入リスク。
 *   tokensLeft === threshold の境界は安全側に倒して false (Plan §2 Step 1.3 (d) 明文)。
 * - updateTokensLeft は null / undefined を no-op として受容 (Keepa response の tokensLeft が
 *   optional な endpoint があるため、前回値を保持する設計)。
 *
 * Run 全体で 1 instance を共有し、orchestrator 経由で deals / brand pipeline に注入する想定。
 */
export class KeepaTokenGuard {
  private tokensLeft: number | null = null;
  private readonly defaultThreshold: number;

  constructor(threshold: number = KEEPA_TOKEN_THRESHOLD) {
    this.defaultThreshold = threshold;
  }

  /**
   * Keepa API を call すべきかを判定する。
   * - tokensLeft が未 update (null) なら true (initial call で update される)。
   * - tokensLeft が threshold 以上なら true、threshold 未満 (含む等価) なら false。
   *
   * @param threshold 個別 call の閾値。省略時は constructor 注入値を使う。
   */
  shouldCall(threshold: number = this.defaultThreshold): boolean {
    if (this.tokensLeft === null) {
      return true;
    }
    return this.tokensLeft > threshold;
  }

  /**
   * Keepa response から得た tokensLeft で state を更新する。
   * null / undefined は no-op (前回値を保持)。
   * NaN / Infinity / 負値 も no-op (異常値で state を汚染しない)。
   * n === 0 は valid (枯渇直後の正常値) として受容する。
   */
  updateTokensLeft(n: number | null | undefined): void {
    if (n === null || n === undefined) {
      return;
    }
    if (!Number.isFinite(n) || n < 0) {
      return;
    }
    this.tokensLeft = n;
  }

  /**
   * 現在 tracking 中の tokensLeft (debug / log 用)。
   */
  getTokensLeft(): number | null {
    return this.tokensLeft;
  }
}
