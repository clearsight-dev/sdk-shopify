/**
 * Opens a web page from the app (0.21.0). The phone's build; `openWebPage.ts` is the web's.
 *
 * - **A page on the store's own website** (`isStoreWebLink`: the config's `webDomains`) opens in the
 *   in-app browser (`expo-web-browser`'s `openBrowserAsync`). Once an app owns the store's domain (app
 *   links), Android hands such a link opened with `Linking.openURL` straight back to the app, so a
 *   policy or contact page would never show.
 * - **Any other link** goes to the phone (`Linking.openURL`): its browser, or the app that owns it.
 *
 * From amore-v2's `src/core/services/storeLinks.ts`. A plain function, not a hook, so a tile's
 * `onPress` can call it. Nothing is thrown or rejected: a page that can't open just doesn't.
 *
 * `expo-web-browser` is an optional peer and `react-native` isn't a dependency at all, so both are
 * required lazily inside `try` (which Expo's Metro config, `allowOptionalDependencies: true`, bundles
 * as optional) and typed locally. An app without expo-web-browser in its binary opens the store's
 * pages with `Linking.openURL` instead of crashing.
 */
import { isStoreWebLink } from './storeLinks';

/** The slice of expo-web-browser used here. */
interface WebBrowserLike {
  openBrowserAsync(url: string): Promise<unknown>;
}

/** The slice of React Native's `Linking` used here. */
interface LinkingLike {
  openURL(url: string): Promise<unknown>;
}

/** expo-web-browser, or null when the app doesn't have it (or its native module isn't in the binary). */
function inAppBrowser(): WebBrowserLike | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('expo-web-browser') as Partial<WebBrowserLike> | undefined;
    return typeof mod?.openBrowserAsync === 'function' ? (mod as WebBrowserLike) : null;
  } catch {
    return null;
  }
}

/** React Native's `Linking`; a phone always has it. Without it (it can't happen in an app), null. */
function phoneLinking(): LinkingLike | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const linking = (require('react-native') as { Linking?: Partial<LinkingLike> }).Linking;
    return typeof linking?.openURL === 'function' ? (linking as LinkingLike) : null;
  } catch {
    return null;
  }
}

/** Runs `open`, swallowing a throw or a rejection: the caller is an `onPress` with no one to tell. */
function quietly(open: () => Promise<unknown>): void {
  try {
    Promise.resolve(open()).catch(() => undefined);
  } catch {
    // Thrown before it could return a promise: the same as a rejection.
  }
}

/** A page on the store's site, shown in the app: the in-app browser. Any other site opens in the phone's browser. */
export function openWebPage(url: string): void {
  const browser = isStoreWebLink(url) ? inAppBrowser() : null;
  if (browser) {
    quietly(() => browser.openBrowserAsync(url));
    return;
  }
  const linking = phoneLinking();
  if (linking) quietly(() => linking.openURL(url));
}
