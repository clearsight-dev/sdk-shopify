/**
 * Example: the "old" login, email and password (classic customer accounts). What the app shows
 * while `auth.method` is `password`, e.g. during App Store review.
 *
 * Sign in, create an account, and forgot password. Wrong credentials and a taken email resolve
 * `false` and fire `auth:loginFailed`, which the app's toast handler shows, so this screen only
 * handles the one failure the toast doesn't: the store being unreachable.
 */
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useCustomer } from '@tiledev/sdk-shopify';

type Mode = 'signIn' | 'signUp' | 'forgot';

export function PasswordSignIn() {
  const { login, signup, recoverPassword, loading } = useCustomer();
  const [mode, setMode] = useState<Mode>('signIn');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [offline, setOffline] = useState(false);

  const submit = async () => {
    setOffline(false);
    try {
      if (mode === 'forgot') {
        await recoverPassword(email.trim());
        setMode('signIn');
        return;
      }
      if (mode === 'signIn') await login(email.trim(), password);
      else await signup({ email: email.trim(), password });
      // Signed in: `useCustomer().loggedIn` turns true and the account screen re-renders.
    } catch {
      setOffline(true);
    }
  };

  const title = mode === 'signIn' ? 'Sign in' : mode === 'signUp' ? 'Create account' : 'Reset password';
  return (
    <View style={styles.form}>
      <Text style={styles.title} accessibilityRole="header">{title}</Text>
      <TextInput
        style={styles.input}
        value={email}
        onChangeText={setEmail}
        placeholder="Email"
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        textContentType="emailAddress"
        accessibilityLabel="Email"
      />
      {mode !== 'forgot' && (
        <TextInput
          style={styles.input}
          value={password}
          onChangeText={setPassword}
          placeholder="Password"
          secureTextEntry
          autoComplete={mode === 'signIn' ? 'current-password' : 'new-password'}
          textContentType={mode === 'signIn' ? 'password' : 'newPassword'}
          accessibilityLabel="Password"
        />
      )}
      {offline && <Text style={styles.error}>Couldn't reach the store. Check your connection and try again.</Text>}
      <Pressable style={styles.button} onPress={submit} disabled={loading} accessibilityRole="button" accessibilityState={{ busy: loading }}>
        {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>{title}</Text>}
      </Pressable>
      <View style={styles.links}>
        {mode === 'signIn' && (
          <>
            <Text style={styles.link} onPress={() => setMode('forgot')} accessibilityRole="link">Forgot password?</Text>
            <Text style={styles.link} onPress={() => setMode('signUp')} accessibilityRole="link">Create account</Text>
          </>
        )}
        {mode !== 'signIn' && (
          <Text style={styles.link} onPress={() => setMode('signIn')} accessibilityRole="link">Back to sign in</Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: 12, padding: 16 },
  title: { fontSize: 22, fontWeight: '600' },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 6, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
  error: { color: '#b00020' },
  button: { alignItems: 'center', backgroundColor: '#111', borderRadius: 6, paddingVertical: 14 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  links: { flexDirection: 'row', justifyContent: 'space-between' },
  link: { textDecorationLine: 'underline' },
});
