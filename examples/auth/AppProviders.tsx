/**
 * Example: one ShopifyProvider offering both sign-ins, with store credit from the app's chosen
 * source.
 *
 * `signInMethod` comes from wherever the app keeps remote settings (a Live Layer field, in a Tile
 * app): `password` while a build is in App Store review, so the reviewer signs in with the demo
 * email and password; `shopify` for shoppers. Flipping it needs no release, and a shopper already
 * signed in stays signed in.
 *
 * Native modules: expo-secure-store (the keychain), expo-web-browser (the system sheet),
 * expo-crypto (random bytes for PKCE; Hermes has no `crypto.getRandomValues`).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { useMemo, type ReactNode } from 'react';
import { ShopifyProvider, type AuthMethod, type AuthOptions, type SecureStorageAdapter, type ShopifyEvent } from '@tiledev/sdk-shopify';

/** The keychain (iOS) / Keystore (Android), in the SDK's storage shape. Tokens never go to AsyncStorage. */
const keychain: SecureStorageAdapter = {
  getItem: (key) => SecureStore.getItemAsync(key),
  setItem: (key, value) => SecureStore.setItemAsync(key, value),
  removeItem: (key) => SecureStore.deleteItemAsync(key),
};

/**
 * The system sign-in sheet: ASWebAuthenticationSession on iOS, a Custom Tab on Android.
 * `preferEphemeralSession` (iOS): no shared Safari cookies, so iOS shows no "wants to use
 * shopify.com to sign in" alert, and Shopify always asks who is signing in instead of resuming the
 * last shopper on this device.
 */
const openAuthSession: AuthOptions['openAuthSession'] = (url, redirectUri) =>
  WebBrowser.openAuthSessionAsync(url, redirectUri, { preferEphemeralSession: true });

export function AppProviders({
  children,
  signInMethod,
  onEvent,
}: {
  children: ReactNode;
  signInMethod: AuthMethod;
  onEvent?: (event: ShopifyEvent) => void;
}) {
  const auth = useMemo<AuthOptions>(
    () => ({
      method: signInMethod,
      // Shopify admin → Settings → Customer accounts → Headless: a Public (mobile) client.
      // The app registers the scheme `shop.<shopId>.app` (app.json `scheme`).
      customerAccount: { shopId: '68843864220', clientId: 'd5484654-1cfa-4b0d-815e-1f02285b5dc6' },
      secureStorage: keychain,
      openAuthSession,
      random: Crypto.getRandomBytes,
    }),
    [signInMethod],
  );

  return (
    <ShopifyProvider
      config={{ storeDomain: 'spwxti-kd.myshopify.com', storefrontAccessToken: '<public token>', apiVersion: '2026-07' }}
      storage={AsyncStorage}
      auth={auth}
      // Per app: Shopify's own store credit, or Tile Credit ({ source: 'tile' }).
      storeCredit={{ source: 'shopify' }}
      onEvent={onEvent}
    >
      {children}
    </ShopifyProvider>
  );
}
