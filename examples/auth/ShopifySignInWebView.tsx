/**
 * Example: the "new" login, Shopify's web sign-in, in the app's own web view (the surface Amore
 * used). The page stays inside the app's design, at a cost: Google's sign-in refuses embedded web
 * views, so a store offering it should prefer the system sheet (ShopifySignInSheet.tsx).
 *
 * `incognito`: no cookies survive the sheet, so the next sign-in never silently resumes the last
 * shopper. On Android that's the gap the system sheet has, as Custom Tabs share Chrome's cookies.
 *
 * The SDK drives the flow; the web view only shows the page and hands back the redirect.
 */
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import type { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes';
import { useCustomer, type SignInAttempt } from '@tiledev/sdk-shopify';

export function ShopifySignInWebView({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { startSignIn } = useCustomer();
  const [attempt, setAttempt] = useState<SignInAttempt | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [offline, setOffline] = useState(false);
  const attemptRef = useRef<SignInAttempt | null>(null);

  // A fresh attempt (new PKCE verifier, state and nonce) each time the sheet opens.
  useEffect(() => {
    if (!visible) return;
    const next = startSignIn();
    attemptRef.current = next;
    setAttempt(next);
    setOffline(false);
    return () => {
      next.cancel();
      attemptRef.current = null;
    };
  }, [visible, startSignIn]);

  const onShouldStartLoadWithRequest = (request: ShouldStartLoadRequest) => {
    const current = attemptRef.current;
    if (!current?.isCallback(request.url)) return true;
    // Shopify is redirecting back with the code: stop the web view and let the SDK finish.
    setFinishing(true);
    current
      .finish(request.url)
      .then(onClose)
      .catch(() => setOffline(true))
      .finally(() => setFinishing(false));
    return false;
  };

  // Without the redirect's scheme here, react-native-webview hands that URL to the OS as a deep
  // link instead of asking onShouldStartLoadWithRequest.
  const scheme = attempt ? attempt.redirectUri.slice(0, attempt.redirectUri.indexOf('://')) : '';

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={styles.bar}>
        <Text style={styles.title} accessibilityRole="header">Sign in</Text>
        <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" hitSlop={12}>
          <Text style={styles.close}>Close</Text>
        </Pressable>
      </View>
      {offline && <Text style={styles.error}>Couldn't reach the store. Close and try again.</Text>}
      {attempt && !finishing && (
        <WebView
          style={styles.web}
          source={{ uri: attempt.url }}
          incognito
          originWhitelist={['https://*', `${scheme}://*`]}
          onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
          startInLoadingState
        />
      )}
      {finishing && <ActivityIndicator style={styles.web} />}
    </Modal>
  );
}

const styles = StyleSheet.create({
  bar: { alignItems: 'center', borderBottomColor: '#e5e5e5', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', justifyContent: 'space-between', padding: 16 },
  title: { fontSize: 17, fontWeight: '600' },
  close: { fontSize: 16 },
  error: { color: '#b00020', padding: 16 },
  web: { flex: 1 },
});
