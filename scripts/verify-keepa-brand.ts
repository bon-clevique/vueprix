/**
 * Verify Keepa brand notation candidates.
 *
 * Usage:
 *   tsx scripts/verify-keepa-brand.ts <brand1> [brand2 ...]
 *   tsx scripts/verify-keepa-brand.ts 山崎 山﨑 Yamazaki
 *
 * Reads KEEPA_API_KEY from .env and queries the /query endpoint for each
 * brand notation candidate. Prints per-candidate hit count, totalCount,
 * sample ASINs, and remaining tokens.
 *
 * Used as a dry-run check before committing a brand notation (handles
 * Japanese variants like 山崎/山﨑/Yamazaki) in production code.
 *
 * Token cost: typically 1 token per /query call.
 */
/* eslint-disable no-console */
// CLI tool: 進捗を stdout に直書きする (logger を使うと structured log で人が読みづらい)。
import 'dotenv/config';
import axios from 'axios';
import { KEEPA_DOMAIN } from '../src/config.js';
import { KEEPA_BASE, type KeepaQueryResponse } from '../src/keepa.js';

interface KeepaQueryBody {
  page: number;
  perPage: number;
  domainId: number;
  brand: string[];
  sort: Array<[string, string]>;
  asinsOnly: boolean;
}

const buildBody = (brand: string): KeepaQueryBody => ({
  page: 0,
  perPage: 50,
  domainId: KEEPA_DOMAIN,
  brand: [brand],
  sort: [['current_SALES', 'asc']],
  asinsOnly: true,
});

const fetchBrand = async (brand: string, key: string): Promise<void> => {
  const url = `${KEEPA_BASE}/query`;
  const res = await axios.post<KeepaQueryResponse>(url, buildBody(brand), {
    params: { key, domain: KEEPA_DOMAIN },
    timeout: 30_000,
  });
  const asins = res.data.asinList ?? res.data.asins ?? [];
  const total = res.data.totalCount ?? res.data.productCount;
  const sample = asins.slice(0, 5).join(', ');
  console.log(`[${brand}]`);
  console.log(`  hits (this page): ${asins.length}`);
  console.log(`  totalCount: ${total ?? 'n/a'}`);
  console.log(`  sample ASINs: ${sample || '(none)'}`);
  console.log(`  tokensLeft: ${res.data.tokensLeft ?? 'n/a'}`);
  console.log('');
};

const parseArgs = (argv: string[]): readonly string[] =>
  argv.slice(2).map((a) => a.trim()).filter((a) => a.length > 0);

const main = async (): Promise<void> => {
  const key = process.env.KEEPA_API_KEY;
  if (!key) {
    console.error('KEEPA_API_KEY is not set in .env');
    process.exit(1);
  }
  const targets = parseArgs(process.argv);
  if (targets.length === 0) {
    console.error('usage: tsx scripts/verify-keepa-brand.ts <brand1> [brand2 ...]');
    process.exit(1);
  }
  console.log(
    `Verifying ${targets.length} brand notation(s) on Keepa domain ${KEEPA_DOMAIN} (Amazon.co.jp)\n`,
  );
  for (const brand of targets) {
    try {
      await fetchBrand(brand, key);
    } catch (err) {
      console.warn(`[${brand}] failed:`, err instanceof Error ? err.message : err);
    }
  }
};

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
