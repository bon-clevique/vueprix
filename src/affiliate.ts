// Amazon アソシエイト用の affiliate URL を ASIN と PartnerTag から組み立てる。
// PA-API を使わなくてもこの形式の URL で紹介手数料が記録される (Amazon 公式仕様)。
// 参考: https://affiliate-program.amazon.co.jp/help/topic/t34
export const buildAffiliateUrl = (asin: string, partnerTag: string): string => {
  const safeAsin = encodeURIComponent(asin);
  const safeTag = encodeURIComponent(partnerTag);
  return `https://www.amazon.co.jp/dp/${safeAsin}?tag=${safeTag}`;
};

export const requirePartnerTag = (): string => {
  const tag = process.env.AMAZON_PARTNER_TAG;
  if (!tag) {
    throw new Error('AMAZON_PARTNER_TAG is required (Amazon Associate ID)');
  }
  return tag;
};
