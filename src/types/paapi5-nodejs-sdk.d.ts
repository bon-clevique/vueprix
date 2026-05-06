declare module 'paapi5-nodejs-sdk' {
  export class ApiClient {
    static instance: ApiClient;
    accessKey: string;
    secretKey: string;
    host: string;
    region: string;
  }

  export class DefaultApi {
    getItems(
      request: GetItemsRequest,
      callback: (error: unknown, data: GetItemsResponse | null, response: unknown) => void,
    ): void;
  }

  export class GetItemsRequest {
    PartnerTag?: string;
    PartnerType?: string;
    Marketplace?: string;
    ItemIds?: string[];
    Resources?: string[];
  }

  export interface GetItemsResponse {
    ItemsResult?: {
      Items?: Array<{
        ASIN: string;
        DetailPageURL?: string;
        ItemInfo?: {
          Title?: { DisplayValue?: string };
        };
        Images?: {
          Primary?: {
            Medium?: { URL?: string };
            Large?: { URL?: string };
          };
        };
        Offers?: {
          Listings?: Array<{
            Price?: { Amount?: number; DisplayAmount?: string };
          }>;
        };
      }>;
    };
    Errors?: Array<{ Code: string; Message: string }>;
  }
}
