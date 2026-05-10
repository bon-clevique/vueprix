/**
 * Verify Keepa category IDs.
 *
 * Usage:
 *   tsx scripts/verify-keepa-categories.ts                # configured (KEEPA_CATEGORIES)
 *   tsx scripts/verify-keepa-categories.ts 2127209051     # ad-hoc IDs
 *   tsx scripts/verify-keepa-categories.ts 2127209051 637394
 *
 * Reads KEEPA_API_KEY from .env and queries the /category endpoint for each
 * category. Prints the official name and ancestor chain, plus remaining tokens.
 *
 * Token cost: 1 token per category lookup.
 */
import 'dotenv/config';
import axios from 'axios';
import { KEEPA_CATEGORIES, KEEPA_DOMAIN } from '../src/config.js';

interface KeepaCategoryResponse {
  tokensLeft?: number;
  categories?: Record<
    string,
    {
      catId: number;
      name: string;
      parent?: number;
      productCount?: number;
      ancestors?: number[];
    }
  >;
}

const KEEPA_BASE = 'https://api.keepa.com';

const fetchCategory = async (categoryId: number, key: string): Promise<void> => {
  const url = `${KEEPA_BASE}/category`;
  const res = await axios.get<KeepaCategoryResponse>(url, {
    params: { key, domain: KEEPA_DOMAIN, category: categoryId },
    timeout: 30_000,
  });
  const cat = res.data.categories?.[String(categoryId)];
  if (!cat) {
    console.log(`[${categoryId}] not found in response`);
    return;
  }
  console.log(`[${categoryId}]`);
  console.log(`  name: ${cat.name}`);
  console.log(`  productCount: ${cat.productCount ?? 'n/a'}`);
  console.log(`  ancestors: ${cat.ancestors?.join(' > ') ?? '(root)'}`);
  console.log(`  tokensLeft: ${res.data.tokensLeft ?? 'n/a'}`);
  console.log('');
};

const parseArgs = (argv: string[]): readonly number[] => {
  const ids = argv
    .slice(2)
    .map((a) => Number.parseInt(a, 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  return ids.length > 0 ? ids : KEEPA_CATEGORIES;
};

const main = async (): Promise<void> => {
  const key = process.env.KEEPA_API_KEY;
  if (!key) {
    console.error('KEEPA_API_KEY is not set in .env');
    process.exit(1);
  }
  const targets = parseArgs(process.argv);
  const source = process.argv.length > 2 ? 'argv' : 'KEEPA_CATEGORIES';
  console.log(`Verifying ${targets.length} categories from ${source} on Keepa domain ${KEEPA_DOMAIN} (Amazon.co.jp)\n`);
  for (const id of targets) {
    try {
      await fetchCategory(id, key);
    } catch (err) {
      console.error(`[${id}] failed:`, err instanceof Error ? err.message : err);
    }
  }
};

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
