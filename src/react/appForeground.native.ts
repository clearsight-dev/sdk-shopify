/**
 * Calls `listener` each time the app comes back to the foreground; returns the unsubscribe. The phone's
 * build: React Native's `AppState` turning `active` again. `appForeground.ts` is the web's.
 *
 * `react-native` is required lazily and typed locally, as the SDK has no dependency on it: a phone
 * always has it. Without it (it can't happen in an app), nothing is called.
 */
interface AppStateLike {
  currentState: string;
  addEventListener(type: 'change', listener: (state: string) => void): { remove(): void };
}

export function onAppForeground(listener: () => void): () => void {
  let appState: AppStateLike | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    appState = (require('react-native') as { AppState?: AppStateLike }).AppState;
  } catch {
    return () => undefined;
  }
  if (!appState) return () => undefined;
  let last = appState.currentState;
  const subscription = appState.addEventListener('change', (next) => {
    if (next === 'active' && last !== 'active') listener();
    last = next;
  });
  return () => subscription.remove();
}
