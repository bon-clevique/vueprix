import type { PostInput } from './types.js';

const formatYen = (n: number): string => `¥${n.toLocaleString('ja-JP')}`;

const truncate = (text: string, max: number): string => {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
};

export const buildPostText = (input: PostInput, max: number): string => {
  const { product, reason, referencePrice, dropPercent } = input;
  const url = product.affiliateUrl;
  const hashtags = '#Amazon値下がり #生活の質';
  const priceLine = `${formatYen(referencePrice)} → ${formatYen(product.currentPrice)} (${dropPercent}%オフ)`;
  const tail = `\n\n→ Amazonで見る\n${url}\n\n${hashtags}`;
  const fixedReason = `\n\n${reason}\n\n通常 ${priceLine}`;
  const overhead = fixedReason.length + tail.length + '【値下がり】'.length;
  const titleBudget = Math.max(10, max - overhead);
  const title = truncate(product.title, titleBudget);
  const text = `【値下がり】${title}${fixedReason}${tail}`;
  return text.length > max ? truncate(text, max) : text;
};
