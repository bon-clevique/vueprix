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

export const getItems = async (asins: string[]): Promise<ProductInfo[]> => {
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
    logger.warn('paapi', 'partial errors', { errors: response.Errors });
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
