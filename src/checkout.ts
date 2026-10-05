/**
 * Shopify's hosted checkout, shown in a web view. The app can't read the checkout's page, so the page's
 * address is the only sign it gets that an order was placed:
 *
 * - `isOrderPlacedUrl(url)` says whether an address is a page Shopify shows once the order is placed.
 * - `REPORT_ADDRESS_CHANGES_SCRIPT` is the script the web view runs in every page, so the app hears about
 *   every address change, including the ones the web view itself doesn't report.
 * - `prepareCheckout(steps, options)` gets the cart ready before checkout opens (`useCheckout().prepare`
 *   wires it to the provider; SDK move 6).
 *
 * No React and no network of its own (`prepareCheckout` is handed every step), the same on web, iOS and
 * Android.
 */
import type { Cart, CartLine } from "./types";


/**
 * The thank-you page, as a whole part of the path: `thank-you` (today's checkout,
 * `/checkouts/cn/<token>/thank-you`) or `thank_you` (the older one,
 * `/<shop id>/checkouts/<token>/thank_you`). A part that only starts with it, such as
 * `/pages/thank-you-for-subscribing`, doesn't count.
 */
const THANK_YOU_PAGE = /\/thank[-_]you(?:\/|$)/i;

/**
 * Where one-page checkout lands: `/checkouts/cn/<token>/confirmation`. Missing it once lost a real order
 * (Freckled Poppy, 2026): the payment went through, Shopify moved to `/confirmation`, and the app saw
 * nothing.
 */
const CONFIRMATION_PAGE = /\/confirmation(?:\/|$)/i;

/**
 * A page under `/orders/`, such as the order status page `/<shop id>/orders/<token>`.
 *
 * No `g` (global) flag on purpose. A global regex remembers where its last match ended (`lastIndex`)
 * and starts the next `.test` from there, so asking twice about the same address can answer `true`
 * and then `false`. A regex without the flag starts from the beginning every time.
 */
const ORDER_PAGE = /\/orders\//i;

/**
 * An order opened from the shopper's account: `account` comes before `orders` in the path, as in
 * `/account/orders/<id>` or `/<shop id>/account/orders/<id>`. A signed-in checkout shows an account
 * menu that links there, and that order was placed long ago. Counting it would send `purchase` and
 * clear the cart the moment a shopper looked at a past order (production did this once, when it
 * matched `/orders`). Decided 2026-10-06, Head of Engineering: "Skip /account/orders/".
 */
const ACCOUNT_ORDER_PAGE = /\/account\/(?:.+\/)?orders\//i;

/**
 * The part of an address that names the page: after the host, before the query (`?…`) and the
 * fragment (`#…`). A query can carry another page's address (`?return_to=/orders/12`), and that must
 * never count.
 */
function pathOf(url: string): string {
  const beforeQuery = url.split(/[?#]/)[0];
  // Drop `https://host` (or a bare `//host`), so a host can never look like part of the path.
  return beforeQuery.replace(/^(?:[a-z][a-z0-9+.-]*:)?\/\/[^/]*/i, "");
}

/**
 * True when the checkout's address is a page Shopify shows once the order is placed:
 *
 * - `/thank-you` or `/thank_you`;
 * - `/confirmation` (one-page checkout);
 * - the order status page: a page under `/orders/` (`/<shop id>/orders/<token>`), but never one under
 *   `/account/`. An order opened from the account menu (`/account/orders/<id>`) is an old order.
 *
 * Only the path is read, never the query or the fragment, and letter case doesn't matter. The same
 * page can arrive several times (a `replaceState`, a `pushState`, late loads): report the order once
 * per checkout.
 */
export function isOrderPlacedUrl(url: string | null | undefined): boolean {
  if (typeof url !== "string" || url === "") return false;
  const path = pathOf(url);
  const isOrderStatusPage = ORDER_PAGE.test(path) && !ACCOUNT_ORDER_PAGE.test(path);
  return THANK_YOU_PAGE.test(path) || CONFIRMATION_PAGE.test(path) || isOrderStatusPage;
}

/**
 * The script a checkout's web view runs in every page it loads (react-native-webview's
 * `injectedJavaScript`). Each time the page's address changes it posts `{ kind, url }` to the app
 * through `window.ReactNativeWebView.postMessage`, as JSON. `kind` says what changed it: `load`,
 * `pushState`, `replaceState`, `popstate` or `hashchange`. `url` is the full address.
 *
 * Why it's needed: the web view's own navigation event reports whole-page loads only. A recorded
 * checkout reached the thank-you page through `history.replaceState`, which the web view reported only
 * as a late "finished loading", never as a new page. Wrapping the two history calls sees that change
 * directly. A flag on the page (`__appWatchesAddress`) keeps the script from wrapping them twice. It
 * ends in `true`, as react-native-webview asks of an injected script.
 *
 * From Amber's production app (where the flag was `__navProbe`).
 */
export const REPORT_ADDRESS_CHANGES_SCRIPT = `
(function() {
  if (window.__appWatchesAddress) return true;
  window.__appWatchesAddress = true;
  var post = function(kind) {
    try {
      window.ReactNativeWebView.postMessage(JSON.stringify({ kind: kind, url: location.href }));
    } catch (e) {}
  };
  ['pushState', 'replaceState'].forEach(function(name) {
    var original = history[name];
    history[name] = function() {
      var result = original.apply(this, arguments);
      post(name);
      return result;
    };
  });
  window.addEventListener('popstate', function() { post('popstate'); });
  window.addEventListener('hashchange', function() { post('hashchange'); });
  post('load');
})();
true;
`;

// ---------------------------------------------------------------------------
// Getting the cart ready for checkout (SDK move 6)
// ---------------------------------------------------------------------------

/**
 * What `prepare` found, so the app knows where to send the shopper:
 *
 * - `ready`: open the checkout page.
 * - `empty`: no cart, or a cart with no lines (a reservation that ran out took them). Nothing to pay for.
 *   A read that fails isn't this: checkout goes on with the cart already loaded (see `prepareCheckout`).
 * - `lapsedHold`: a line's reservation has run out (`hasLapsedHold`). Shopify would empty that line
 *   during checkout, so the shopper goes back to the cart, which explains it.
 * - `failed`: something unexpected threw. The shopper stays where they are.
 */
export type CheckoutPreparation = "ready" | "empty" | "lapsedHold" | "failed";

export interface PrepareCheckoutOptions {
  /**
   * True when one of the lines has a reservation that ran out: pass Cart Hold's `hasLapsedHold`.
   * Asked about the cart as just read. Leave it out when the app has no reservations.
   */
  hasLapsedHold?: (lines: CartLine[]) => boolean;
}

/** What the buyer-identity write takes: the shopper's token, and their email and the cart's country when known. */
export interface CheckoutShopper {
  customerAccessToken: string;
  email?: string;
  countryCode?: string;
}

/**
 * Every step `prepareCheckout` takes, handed in, so the rule is tested without React or a network.
 * `useCheckout().prepare` hands in the provider's own.
 */
export interface CheckoutPreparationSteps {
  /** Reads the cart again (`useCart().refresh`). Null when there is no cart. May reject (offline). */
  readCartAgain: () => Promise<Cart | null>;
  /** The cart as the app already has it (`useCart().cart`), for when reading it again fails. */
  cartAlreadyLoaded: () => Cart | null;
  /** A shopper is signed in (`useCustomer().loggedIn`). */
  signedIn: boolean;
  /** The signed-in shopper's email, when their profile has loaded. */
  email: string | null;
  /** A usable access token for the signed-in shopper (`useCustomer().getAccessToken`). */
  getAccessToken: () => Promise<string | null>;
  /** Attaches the shopper to the cart (`useCart().setBuyerIdentity`). */
  setBuyerIdentity: (shopper: CheckoutShopper) => Promise<boolean>;
  /** Marks the cart as gone to checkout (`useCheckout().reportCheckoutStarted`). */
  reportCheckoutStarted: () => Promise<void>;
  /**
   * Lands the cart's `_apptile_attribution` (`useCart().flushAttribution`). Left out, the step is
   * skipped. True when the cart holds the device's value.
   */
  flushAttribution?: () => Promise<boolean>;
  /**
   * Makes sure the cart carries the provider's `cartAttributes` (`useCart().ensureCartAttributes`).
   * Left out, the step is skipped. True when it does.
   */
  ensureCartAttributes?: () => Promise<boolean>;
  /** How long each labelling step may take, in ms. Default `CHECKOUT_LABEL_STEP_TIMEOUT_MS`. */
  labelStepTimeoutMs?: number;
}

/**
 * How long each step that labels the cart may take before checkout goes on without it: long enough
 * for one queued write and its retry on a phone network (Freckled Poppy's 3 seconds). A slow write
 * still lands later, in the cart's write queue.
 */
export const CHECKOUT_LABEL_STEP_TIMEOUT_MS = 3000;

/** The work's answer, or `"timeout"` once `ms` have passed. Never rejects: a rejection is `false`. */
async function withinTime(work: () => Promise<boolean>, ms: number): Promise<boolean | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  try {
    return await Promise.race([work().catch(() => false), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Attaches the signed-in shopper, so checkout is theirs, with their saved details. The cart's country
 * is sent again with them: the write replaces the whole buyer identity, and a gift card (store credit)
 * stays only on a cart with a country. Any failure leaves a guest checkout. Signed out, nothing.
 */
async function attachShopper(steps: CheckoutPreparationSteps, cart: Cart): Promise<void> {
  if (!steps.signedIn) return;
  try {
    const token = await steps.getAccessToken();
    if (!token) return;
    const countryCode = cart.buyerIdentity?.countryCode ?? null;
    await steps.setBuyerIdentity({
      customerAccessToken: token,
      ...(steps.email ? { email: steps.email } : {}),
      ...(countryCode ? { countryCode } : {}),
    });
  } catch {
    // A guest checkout it is.
  }
}

/**
 * Labels the cart for what happens after the order (Freckled Poppy's `labelCartForCheckout`): first
 * the cart's `_apptile_attribution` lands, then the provider's `cartAttributes` are made sure of. One
 * after the other, as both write the cart's attributes. A step that fails or runs past its time is
 * warned about, and checkout goes on.
 */
async function labelCart(steps: CheckoutPreparationSteps): Promise<void> {
  const ms = steps.labelStepTimeoutMs ?? CHECKOUT_LABEL_STEP_TIMEOUT_MS;
  const labelSteps: [string, (() => Promise<boolean>) | undefined][] = [
    ["flushAttribution", steps.flushAttribution],
    ["ensureCartAttributes", steps.ensureCartAttributes],
  ];
  for (const [name, step] of labelSteps) {
    if (!step) continue;
    const outcome = await withinTime(step, ms);
    if (outcome !== true) {
      console.warn(`[sdk-shopify] checkout: ${name} ${outcome === "timeout" ? "timed out" : "failed"}; checkout goes on`);
    }
  }
}

/**
 * Gets the cart ready for checkout, in this order:
 *
 * 1. **The cart is read again**: a reservation that ran out may already have taken a line. No cart,
 *    or no lines, is `empty`. **A read that fails carries on** with the cart already loaded
 *    (`cartAlreadyLoaded`), as Freckled Poppy did: Shopify's checkout checks the cart again itself.
 *    Decided 2026-10-06 by the Head of Engineering: "Carry on". Until then a failed read (offline)
 *    counted as no cart, and amore-v2 told the shopper their reservation had run out.
 * 2. **A lapsed reservation** (`options.hasLapsedHold`) is `lapsedHold`, and nothing else happens.
 * 3. **Together:** the signed-in shopper is attached (`attachShopper`), and the cart is labelled
 *    (`labelCart`). Neither can stop checkout.
 * 4. **The start is reported** (`reportCheckoutStarted`): a cart gone to checkout reads back empty like
 *    an expired one, so this keeps the next launch from refilling it.
 * 5. `ready`.
 *
 * Anything else that throws is `failed`. Never rejects. Going to the checkout page is the app's.
 */
export async function prepareCheckout(
  steps: CheckoutPreparationSteps,
  options: PrepareCheckoutOptions = {},
): Promise<CheckoutPreparation> {
  try {
    const cart = await steps.readCartAgain().catch(() => steps.cartAlreadyLoaded());
    if (!cart || cart.lines.length === 0) return "empty";
    if (options.hasLapsedHold?.(cart.lines)) return "lapsedHold";
    await Promise.all([attachShopper(steps, cart), labelCart(steps)]);
    try {
      await steps.reportCheckoutStarted();
    } catch (reportError) {
      console.warn("[sdk-shopify] checkout: reportCheckoutStarted failed; checkout goes on", reportError);
    }
    return "ready";
  } catch (unexpected) {
    console.warn("[sdk-shopify] checkout: getting the cart ready failed", unexpected);
    return "failed";
  }
}
