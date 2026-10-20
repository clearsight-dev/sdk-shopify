/**
 * Live auctions (0.21.0): a product carries `AUCTION_TAG` while it is on the block, and can't be
 * bought. From amore-v2's `src/core/utils/auction.ts`, which every app built on it copied. The rule is
 * kept on purpose (2026-10-05): stores still carry the tag on products from past shows, and an app
 * that drops the rule sells them.
 */
export const AUCTION_TAG = 'SEARCH-BLOCKED';

/**
 * The product is in a live auction right now: the product page, the variant page and the Waitlist's
 * cards treat it as not buyable ("Auction notice wins", decided 2026-10-06), as `useProductPage`'s and
 * `useWaitlistPage`'s `isBlocked`. Anything with the product's tags will do: a product, or a waitlist
 * variant's `product` (read with its tags since 0.10). The tag must match exactly; no tags is false.
 */
export function isAuctioned(product: { tags?: readonly string[] | null }): boolean {
  return product.tags?.includes(AUCTION_TAG) ?? false;
}
