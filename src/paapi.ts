import { Hash } from '@aws-sdk/hash-node';
import { SignatureV4 } from '@aws-sdk/signature-v4';
import { HttpRequest } from '@smithy/protocol-http';
import axios, { AxiosError } from 'axios';
import { logger } from './logger.js';

export interface ProductInfo {
  asin: string;
  title: string;
  imageUrl: string;
  currentPrice: number;
  affiliateUrl: string;
  // Amazon UI の打消し線価格 (定価)。PA-API GetItems の Offers.Listings[0].SavingBasis.Amount。
  // 商品ページに割引表示がない場合 / SavingBasis を Amazon が返さない場合 undefined。
  // yen 整数。固定ASIN 経路で Keepa 由来 reference より優先採用する (Amazon UI と一貫させるため)。
  savingBasis?: number;
}

interface PaapiItem {
  ASIN: string;
  DetailPageURL?: string;
  ItemInfo?: { Title?: { DisplayValue?: string } };
  Images?: { Primary?: { Medium?: { URL?: string }; Large?: { URL?: string } } };
  Offers?: {
    Listings?: Array<{
      Price?: { Amount?: number; DisplayAmount?: string };
      SavingBasis?: { Amount?: number; DisplayAmount?: string };
    }>;
  };
}

// module-internal type、unit test 露出のため export (本来は file-private)。外部 module からは使わない。
export interface PaapiResponse {
  ItemsResult?: { Items?: PaapiItem[] };
  Errors?: Array<{ Code: string; Message?: string; __type?: string }>;
}

const PAAPI_PATH = '/paapi5/getitems';
const PAAPI_TARGET = 'com.amazon.paapi5.v1.ProductAdvertisingAPIv1.GetItems';
const PAAPI_SERVICE = 'ProductAdvertisingAPI';

const env = (key: string): string => {
  const v = process.env[key];
  if (!v) throw new Error(`${key} is not set`);
  return v;
};

const buildSigner = (): SignatureV4 =>
  new SignatureV4({
    service: PAAPI_SERVICE,
    region: process.env.PAAPI_REGION ?? 'us-west-2',
    credentials: {
      accessKeyId: env('PAAPI_ACCESS_KEY'),
      secretAccessKey: env('PAAPI_SECRET_KEY'),
    },
    sha256: Hash.bind(null, 'sha256'),
  });

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
  const e = err as { status?: number; code?: string; response?: { status?: number } };
  const status = e.response?.status ?? e.status;
  if (typeof status === 'number') {
    if (status === 429) return true;
    if (status >= 500 && status < 600) return true;
    return false;
  }
  return typeof e.code === 'string' && RETRYABLE_NETWORK_CODES.has(e.code);
};

// module-internal、unit test 露出のため export (本来は file-private)。外部 module から呼ばない。
// 露出目的: PartnerTag 等の env 統合と Resources の hardcode を test で pin する。
export const buildBody = (asins: string[]): string =>
  JSON.stringify({
    PartnerTag: env('PAAPI_PARTNER_TAG'),
    PartnerType: 'Associates',
    Marketplace: 'www.amazon.co.jp',
    ItemIds: asins,
    Resources: [
      'Images.Primary.Medium',
      'ItemInfo.Title',
      'Offers.Listings.Price',
      // Offers.Listings.SavingBasis = Amazon UI の打消し線価格 (定価)。
      // 固定ASIN 経路で reference price として最優先採用する (keepa avg より UI 表記と一貫)。
      'Offers.Listings.SavingBasis',
    ],
    Operation: 'GetItems',
  });

const sendSigned = async (host: string, body: string): Promise<PaapiResponse> => {
  const url = `https://${host}${PAAPI_PATH}`;
  try {
    const signer = buildSigner();
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
    const res = await axios.post<PaapiResponse>(url, body, {
      headers: signed.headers as Record<string, string>,
      timeout: 30_000,
    });
    return res.data;
  } catch (err) {
    if (err instanceof AxiosError) {
      const status = err.response?.status;
      const wrapped = new Error(
        status
          ? `PA-API request failed (status ${status})`
          : 'PA-API network error',
      );
      if (typeof status === 'number') {
        (wrapped as { status?: number }).status = status;
      } else if (err.code) {
        (wrapped as { code?: string }).code = err.code;
      }
      throw wrapped;
    }
    throw err;
  }
};

// module-internal、unit test 露出のため export (本来は file-private)。外部 module から呼ばない。
// 露出目的: SavingBasis / Errors / null fallback の挙動を test で pin する。
//
// 設計: Errors と Items が同居する partial failure を許容する (Errors を warn ログに残しつつ、
// 有効な Items は parse 続行)。「Errors があれば全件 fail」ではないことに注意。
export const parseProducts = (response: PaapiResponse): ProductInfo[] => {
  if (response.Errors && response.Errors.length > 0) {
    // partial failure: 一部 ASIN が PA-API 側で見つからない / 制限等で返らないケース。
    // 残りの有効 Items は parse して返す (全件 fail ではない)。
    const codes = response.Errors.map((e) => e.Code);
    logger.warn('paapi', 'partial errors', { codes, count: codes.length });
  }
  const items = response.ItemsResult?.Items ?? [];
  return items
    .map((item): ProductInfo | null => {
      const title = item.ItemInfo?.Title?.DisplayValue;
      const detailUrl = item.DetailPageURL;
      const listing = item.Offers?.Listings?.[0];
      const price = listing?.Price?.Amount;
      const imageUrl = item.Images?.Primary?.Medium?.URL;
      if (!title || !detailUrl || typeof price !== 'number') return null;
      const savingBasisAmount = listing?.SavingBasis?.Amount;
      const savingBasis =
        typeof savingBasisAmount === 'number' && savingBasisAmount > 0
          ? Math.round(savingBasisAmount)
          : undefined;
      return {
        asin: item.ASIN,
        title,
        imageUrl: imageUrl ?? '',
        currentPrice: Math.round(price),
        affiliateUrl: detailUrl,
        ...(savingBasis !== undefined ? { savingBasis } : {}),
      };
    })
    .filter((p): p is ProductInfo => p !== null);
};

const getItemsOnce = async (asins: string[]): Promise<ProductInfo[]> => {
  if (asins.length === 0) return [];
  const host = process.env.PAAPI_HOST ?? 'webservices.amazon.co.jp';
  const body = buildBody(asins);
  const response = await sendSigned(host, body);
  return parseProducts(response);
};

// Optional: PA-API は credential 揃っていれば商品情報を取得して投稿テキストの精度を上げる。
// 未設定でも Keepa 単独で投稿が組立可能 (アソシエイト本登録 → 購買実績 → PA-API 申請通過の鶏卵打破ルート)。
export const isPaapiConfigured = (): boolean =>
  Boolean(process.env.PAAPI_ACCESS_KEY) && Boolean(process.env.PAAPI_SECRET_KEY);

export const getItems = async (asins: string[], attempts = 2): Promise<ProductInfo[]> => {
  if (!isPaapiConfigured()) {
    logger.info('paapi', 'PA-API credentials not set, skipping (Keepa-only mode)');
    return [];
  }
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
