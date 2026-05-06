import paapi from 'paapi5-nodejs-sdk';
import { logger } from './logger.js';

export interface ProductInfo {
  asin: string;
  title: string;
  imageUrl: string;
  currentPrice: number;
  affiliateUrl: string;
}

const env = (key: string): string => {
  const v = process.env[key];
  if (!v) throw new Error(`${key} is not set`);
  return v;
};

const configureClient = (): void => {
  const client = paapi.ApiClient.instance;
  client.accessKey = env('PAAPI_ACCESS_KEY');
  client.secretKey = env('PAAPI_SECRET_KEY');
  client.host = process.env.PAAPI_HOST ?? 'webservices.amazon.co.jp';
  client.region = process.env.PAAPI_REGION ?? 'us-west-2';
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const RETRYABLE_NETWORK_CODES = new Set([
  'ENOTFOUND',
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'EPIPE',
]);

export const isRetryable = (err: unknown): boolean => {
  const e = err as { status?: number; code?: string };
  if (typeof e.status === 'number') {
    if (e.status === 429) return true;
    if (e.status >= 500 && e.status < 600) return true;
    return false;
  }
  return typeof e.code === 'string' && RETRYABLE_NETWORK_CODES.has(e.code);
};

const getItemsOnce = async (asins: string[]): Promise<ProductInfo[]> => {
  if (asins.length === 0) return [];
  configureClient();
  const api = new paapi.DefaultApi();
  const request = new paapi.GetItemsRequest();
  request.PartnerTag = env('PAAPI_PARTNER_TAG');
  request.PartnerType = 'Associates';
  request.Marketplace = 'www.amazon.co.jp';
  request.ItemIds = asins;
  request.Resources = [
    'Images.Primary.Medium',
    'ItemInfo.Title',
    'Offers.Listings.Price',
  ];

  const response = await new Promise<paapi.GetItemsResponse>((resolve, reject) => {
    api.getItems(request, (error, data) => {
      if (error) reject(error instanceof Error ? error : new Error(String(error)));
      else if (!data) reject(new Error('PA-API returned empty response'));
      else resolve(data);
    });
  });

  if (response.Errors && response.Errors.length > 0) {
    const codes = response.Errors.map((e) => e.Code);
    logger.warn('paapi', 'partial errors', { codes, count: codes.length });
  }

  const items = response.ItemsResult?.Items ?? [];
  return items
    .map((item): ProductInfo | null => {
      const title = item.ItemInfo?.Title?.DisplayValue;
      const imageUrl = item.Images?.Primary?.Medium?.URL;
      const detailUrl = item.DetailPageURL;
      const price = item.Offers?.Listings?.[0]?.Price?.Amount;
      if (!title || !detailUrl || typeof price !== 'number') return null;
      return {
        asin: item.ASIN,
        title,
        imageUrl: imageUrl ?? '',
        currentPrice: Math.round(price),
        affiliateUrl: detailUrl,
      };
    })
    .filter((p): p is ProductInfo => p !== null);
};

export const getItems = async (asins: string[], attempts = 2): Promise<ProductInfo[]> => {
  let lastErr: unknown = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await getItemsOnce(asins);
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err)) throw err;
      if (i < attempts - 1) {
        const delay = i === 0 ? 1000 : 3000;
        const status = (err as { status?: number; code?: string }).status;
        const code = (err as { status?: number; code?: string }).code;
        logger.warn('paapi', 'retrying after error', {
          attempt: i + 1,
          delayMs: delay,
          status: status ?? null,
          code: code ?? null,
          type: err instanceof Error ? err.constructor.name : typeof err,
        });
        await sleep(delay);
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('PA-API getItems failed');
};
