/**
 * The store's own website (0.21.0): its domains, from `ShopifyConfig.webDomains`, and which links are
 * on it. `openWebPage` reads them to choose between the in-app browser and the phone's.
 *
 * From amore-v2's `src/core/services/storeLinks.ts`, where each app read the domains from its own
 * app.json. Here they are module state, like the alert copy, so `openWebPage` stays a plain function a
 * tile's `onPress` can call: `ShopifyProvider` sets them on its first render and again when its config
 * brings others, and `shopify.init` sets them too.
 *
 * Pure: no React, no React Native.
 */

/** Lower case, so a link matches in any case. Empty until a config sets them: no link is the store's. */
let webHosts: readonly string[] = [];

/**
 * Replaces the store's web domains: each trimmed and lower-cased, empty ones left out. Unset or empty:
 * no link is the store's, so `openWebPage` hands every link to the phone.
 */
export function setStoreWebDomains(domains: readonly string[] | null | undefined): void {
  webHosts = (domains ?? [])
    .map((domain) => (typeof domain === 'string' ? domain.trim().toLowerCase() : ''))
    .filter((host) => host !== '');
}

/** The host of an https link, in lower case; null for anything else. */
function httpsHost(url: string): string | null {
  if (typeof url !== 'string') return null;
  const match = /^https:\/\/([^/?#:]+)/i.exec(url.trim());
  return match ? match[1].toLowerCase() : null;
}

/** A link to the store's own website: https, on one of the config's `webDomains`, in any case. */
export function isStoreWebLink(url: string): boolean {
  const host = httpsHost(url);
  return host !== null && webHosts.includes(host);
}
