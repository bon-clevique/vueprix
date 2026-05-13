/**
 * Verify Keepa product API stats.avg shape.
 *
 * Usage:
 *   tsx scripts/verify-keepa-product-avg.ts            # default: B09JL4R6SX
 *   tsx scripts/verify-keepa-product-avg.ts B0C1JGD2T6 B0779N9GZF
 *
 * Reads KEEPA_API_KEY from .env and queries /product with stats=90 for each ASIN.
 * Prints the full stats object (current, min, avg) so the caller can confirm
 * stats.avg is returned as number[][] (priceType × dateRange) like the Deals API.
 *
 * Token cost: ~1 token per ASIN (1 product, stats=90).
 */
import 'dotenv/config';
import axios from 'axios';
import { KEEPA_DOMAIN } from '../src/config.js';

interface KeepaProductResponse {
  tokensLeft?: number;
  products?: Array<{
    asin: string;
    title?: string;
    stats?: {
      current?: number[];
      min?: Array<[number, number]>;
      avg?: number[][];
      [k: string]: unknown;
    };
  }>;
}

const KEEPA_BASE = 'https://api.keepa.com';
const DEFAULT_ASIN = 'B09JL4R6SX';

const fetchProduct = async (asin: string, key: string): Promise<void> => {
  const url = `${KEEPA_BASE}/product`;
  const res = await axios.get<KeepaProductResponse>(url, {
    params: { key, domain: KEEPA_DOMAIN, asin, stats: 90 },
    timeout: 30_000,
  });
  const product = res.data.products?.[0];
  if (!product) {
    console.log(`[${asin}] no product in response`);
    return;
  }
  console.log(`[${asin}] ${product.title ?? '(no title)'}`);
  console.log(`  tokensLeft: ${res.data.tokensLeft ?? 'n/a'}`);
  if (!product.stats) {
    console.log('  stats: (missing)');
    return;
  }
  console.log(`  stats.current: ${JSON.stringify(product.stats.current)}`);
  console.log(`  stats.min:     ${JSON.stringify(product.stats.min)}`);
  console.log(`  stats.avg:     ${JSON.stringify(product.stats.avg)}`);
  const avg = product.stats.avg;
  if (Array.isArray(avg) && Array.isArray(avg[0])) {
    const [day, week, month, ninety] = avg[0];
    console.log(`  amazon avg [day,week,month,90d]: [${day}, ${week}, ${month}, ${ninety}]`);
    const current = product.stats.current?.[0];
    if (typeof current === 'number' && typeof week === 'number') {
      const dropPercent = week > 0 ? Math.round(((week - current) / week) * 100) : 0;
      console.log(`  current vs week-avg: current=${current}, week=${week}, drop=${dropPercent}%`);
    }
  }
  console.log('');
};

const parseArgs = (argv: string[]): readonly string[] => {
  const asins = argv.slice(2).filter((a) => /^[A-Z0-9]{10}$/.test(a));
  return asins.length > 0 ? asins : [DEFAULT_ASIN];
};

const main = async (): Promise<void> => {
  const key = process.env.KEEPA_API_KEY;
  if (!key) {
    console.error('KEEPA_API_KEY is not set in .env');
    process.exit(1);
  }
  const targets = parseArgs(process.argv);
  console.log(`Verifying ${targets.length} ASIN(s) on Keepa domain ${KEEPA_DOMAIN} (Amazon.co.jp)\n`);
  for (const asin of targets) {
    try {
      await fetchProduct(asin, key);
    } catch (err) {
      console.error(`[${asin}] failed:`, err instanceof Error ? err.message : err);
    }
  }
};

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
