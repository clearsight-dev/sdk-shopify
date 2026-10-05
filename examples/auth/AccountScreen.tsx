/**
 * Example: an account screen that works in either mode. Signed out, it shows the sign-in the app
 * offers now (`customer.method`); signed in, the same profile, store credit and sign-out whichever
 * way the shopper signed in.
 */
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { formatMoney, useCustomer, useStoreCredit } from '@tiledev/sdk-shopify';
import { PasswordSignIn } from './PasswordSignIn';
import { ShopifySignInSheet } from './ShopifySignInSheet';
import { ShopifySignInWebView } from './ShopifySignInWebView';

export function AccountScreen() {
  const customer = useCustomer();
  const credit = useStoreCredit();
  const [webView, setWebView] = useState(false);

  // Reading the keychain on app open: not "signed out" yet.
  if (customer.restoring) return <ActivityIndicator style={styles.center} />;

  if (!customer.loggedIn) {
    if (customer.method === 'password') return <PasswordSignIn />;
    return (
      <View>
        <ShopifySignInSheet />
        {/* The other surface, side by side for comparison. An app ships one. */}
        <Text style={styles.link} onPress={() => setWebView(true)} accessibilityRole="link">Sign in inside the app</Text>
        <ShopifySignInWebView visible={webView} onClose={() => setWebView(false)} />
      </View>
    );
  }

  const name = [customer.customer?.firstName, customer.customer?.lastName].filter(Boolean).join(' ');
  return (
    <View style={styles.account}>
      {/* Offline on app open the session is there but the profile isn't yet. */}
      <Text style={styles.title}>{name || customer.customer?.email || 'Your account'}</Text>
      {credit.source !== null && (
        <Text>
          {credit.available
            ? `Store credit: ${credit.loading && !credit.balance ? '…' : formatMoney(credit.balance)}`
            : 'Store credit shows when you sign in with your Shopify account.'}
        </Text>
      )}
      <Pressable style={styles.button} onPress={customer.logout} accessibilityRole="button">
        <Text style={styles.buttonText}>Sign out</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1 },
  account: { gap: 12, padding: 16 },
  title: { fontSize: 22, fontWeight: '600' },
  link: { paddingHorizontal: 16, textDecorationLine: 'underline' },
  button: { alignItems: 'center', borderColor: '#111', borderRadius: 6, borderWidth: 1, paddingVertical: 14 },
  buttonText: { fontSize: 16, fontWeight: '600' },
});
