/**
 * Verify PA-API GetItems response for `Offers.Listings[0].SavingBasis`.
 *
 * Usage:
 *   tsx scripts/verify-paapi-saving-basis.ts                  # default: B09JL4R6SX B07B5CD8NY
 *   tsx scripts/verify-paapi-saving-basis.ts B0C1JGD2T6 B0779N9GZF
 *
 * Reads PAAPI_ACCESS_KEY / PAAPI_SECRET_KEY / PAAPI_PARTNER_TAG / PAAPI_HOST / PAAPI_REGION
 * from .env and calls /paapi5/getitems with Resources including Offers.Listings.SavingBasis.
 * Prints the full Offers payload per ASIN so the caller can confirm whether SavingBasis is
 * returned and what shape it has.
 *
 * Token cost: 1 PA-API GetItems call per batch (up to 10 ASINs per call).
 */
import 'dotenv/config';
import axios, { AxiosError } from 'axios';
import { Hash } from '@aws-sdk/hash-node';
import { SignatureV4 } from '@aws-sdk/signature-v4';
import { HttpRequest } from '@smithy/protocol-http';

const PAAPI_PATH = '/paapi5/getitems';
const PAAPI_TARGET = 'com.amazon.paapi5.v1.ProductAdvertisingAPIv1.GetItems';
const PAAPI_SERVICE = 'ProductAdvertisingAPI';
const DEFAULT_ASINS = ['B09JL4R6SX', 'B07B5CD8NY'];

const env = (key: string): string => {
  const v = process.env[key];
  if (!v) {
    console.error(`${key} is not set in .env`);
    process.exit(1);
  }
  return v;
};

const main = async (): Promise<void> => {
  const asins = process.argv.slice(2).filter((a) => /^[A-Z0-9]{10}$/.test(a));
  const targets = asins.length > 0 ? asins : DEFAULT_ASINS;
  const host = process.env.PAAPI_HOST ?? 'webservices.amazon.co.jp';
  const region = process.env.PAAPI_REGION ?? 'us-west-2';

  const body = JSON.stringify({
    PartnerTag: env('PAAPI_PARTNER_TAG'),
    PartnerType: 'Associates',
    Marketplace: 'www.amazon.co.jp',
    ItemIds: targets,
    Resources: [
      'ItemInfo.Title',
      'Offers.Listings.Price',
      'Offers.Listings.SavingBasis',
    ],
    Operation: 'GetItems',
  });

  const signer = new SignatureV4({
    service: PAAPI_SERVICE,
    region,
    credentials: {
      accessKeyId: env('PAAPI_ACCESS_KEY'),
      secretAccessKey: env('PAAPI_SECRET_KEY'),
    },
    sha256: Hash.bind(null, 'sha256'),
  });

  const request = new HttpRequest({
    protocol: 'https:',
    hostname: host,
    method: 'POST',
    path: PAAPI_PATH,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-encoding': 'amz-1.0',
      'x-amz-target': PAAPI_TARGET,
      host,
    },
    body,
  });
  const signed = await signer.sign(request);

  console.log(`Verifying ${targets.length} ASIN(s) on ${host} (region=${region})\n`);
  try {
    const res = await axios.post<{
      ItemsResult?: { Items?: Array<{ ASIN: string; ItemInfo?: { Title?: { DisplayValue?: string } }; Offers?: { Listings?: unknown[] } }> };
      Errors?: Array<{ Code: string; Message?: string }>;
    }>(`https://${host}${PAAPI_PATH}`, body, {
      headers: signed.headers as Record<string, string>,
      timeout: 30_000,
    });
    const items = res.data.ItemsResult?.Items ?? [];
    for (const item of items) {
      const title = item.ItemInfo?.Title?.DisplayValue ?? '(no title)';
      console.log(`[${item.ASIN}] ${title}`);
      console.log(`  Offers.Listings:`);
      console.log(JSON.stringify(item.Offers?.Listings ?? [], null, 2).replace(/^/gm, '    '));
      console.log('');
    }
    if (res.data.Errors && res.data.Errors.length > 0) {
      console.log('Errors:', JSON.stringify(res.data.Errors, null, 2));
    }
  } catch (err) {
    if (err instanceof AxiosError) {
      console.error('PA-API request failed:', err.response?.status, JSON.stringify(err.response?.data));
    } else {
      console.error('fatal:', err instanceof Error ? err.message : err);
    }
    process.exit(1);
  }
};

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
