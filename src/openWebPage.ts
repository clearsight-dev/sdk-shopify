/**
 * Opens a web page from the app (0.21.0). This is the web build (the editor preview, browsers, and
 * Node's); `openWebPage.native.ts` is the phone's, which tells the store's own pages from other sites.
 *
 * A browser has no in-app browser to tell apart from itself, so every link opens in a new tab, as
 * React Native Web's `Linking.openURL` does. Nothing is thrown: a page that can't open (a popup
 * blocker, no window in Node) just doesn't.
 */
type WindowOpen = (url: string, target: string, features: string) => unknown;

export function openWebPage(url: string): void {
  try {
    const page = globalThis as { open?: WindowOpen };
    if (typeof page.open === 'function') page.open(url, '_blank', 'noopener');
  } catch {
    // Nothing to tell the shopper: the tab just didn't open.
  }
}
