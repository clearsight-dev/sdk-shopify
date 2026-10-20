/**
 * The image sizes a Tile app's product cards and product page ask Shopify for, and the URL a card
 * draws (0.21.0). From amore-v2's `src/core/utils/images.ts`, which every app built on it copied: the
 * same names, values and behaviour, so an app's tiles import them from here instead.
 *
 * One size per surface is the point. Each transform is its own file on the CDN and its own entry in
 * the image cache, so a card and the product page it opens share a download only when they ask for
 * exactly the same URL.
 */
import { sizedImageUrl } from './productPage';
import type { ImageTransform } from './types';

/**
 * The width product cards ask Shopify for. The product page draws this exact URL as its first
 * image, so it must stay one constant shared by the grids and the page.
 */
export const CARD_IMAGE_WIDTH = 660;

/**
 * Card images, sized by Shopify, for every list of product cards (grids, "You may also like"). The
 * product store keeps this URL as the product's preview image, so the product page's first frame
 * draws the exact image the card already shows.
 */
export const CARD_IMAGE: ImageTransform = { maxWidth: CARD_IMAGE_WIDTH };

/**
 * The product page's photos: full width at phone density. Every read of a whole product asks for
 * this size (the product page, a buy sheet), because the product store keeps one full product per
 * handle and the product page draws whichever read landed last.
 */
export const PRODUCT_PAGE_IMAGE: ImageTransform = { maxWidth: 1080 };

/** The card-sized copy of a product image: what the tapped card already drew, so it's in cache. */
export function cardImageUrl(url: string | null | undefined): string | null {
  return sizedImageUrl(url, CARD_IMAGE_WIDTH);
}

/** An image URL Shopify already sized (`photo_660x.jpg`), which a card draws as it is. */
const SIZED = /_\d*x\d*(@\dx)?(_crop_[a-z]+)?\.[a-z0-9]+(\?|$)/i;

/**
 * The URL a card actually loads for an image, by the cards' rule (the base's ProductGrid01 and
 * WaitlistGrid01): an already-sized URL as is, else the card size. What to prefetch so the card finds
 * it in cache.
 */
export function cardPhotoUrl(url: string | null | undefined): string | null {
  return url && SIZED.test(url) ? url : cardImageUrl(url);
}
