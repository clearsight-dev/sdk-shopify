/**
 * Example: the "new" login, Shopify's web sign-in, in the system browser sheet. The default
 * surface: it can show Shopify's social sign-ins (Google refuses to run inside an app's own web
 * view), and on iOS the ephemeral session never resumes another shopper.
 *
 * Needs `auth.openAuthSession` on the provider (see AppProviders.tsx). Backing out resolves
 * `false` with no event; Shopify refusing fires `auth:loginFailed` for the toast.
 */
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useCustomer } from '@tiledev/sdk-shopify';

export function ShopifySignInSheet() {
  const { signIn, loading } = useCustomer();
  const [offline, setOffline] = useState(false);

  const onPress = async () => {
    setOffline(false);
    try {
      await signIn();
    } catch {
      setOffline(true);
    }
  };

  return (
    <View style={styles.wrap}>
      <Pressable style={styles.button} onPress={onPress} disabled={loading} accessibilityRole="button" accessibilityState={{ busy: loading }}>
        {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.text}>Sign in</Text>}
      </Pressable>
      {offline && <Text style={styles.error}>Couldn't reach the store. Check your connection and try again.</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 12, padding: 16 },
  button: { alignItems: 'center', backgroundColor: '#111', borderRadius: 6, paddingVertical: 14 },
  text: { color: '#fff', fontSize: 16, fontWeight: '600' },
  error: { color: '#b00020' },
});
