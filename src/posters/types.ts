import type { ProductInfo } from '../paapi.js';

export interface PostInput {
  product: ProductInfo;
  reason: string;
  referencePrice: number;
  dropPercent: number;
}

export interface Poster {
  name: string;
  maxChars: number;
  post(input: PostInput): Promise<void>;
}
