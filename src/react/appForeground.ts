/**
 * Calls `listener` each time the app comes back to the foreground; returns the unsubscribe. This is the
 * web build (and Node's): the page becoming visible again. `appForeground.native.ts` is the phone's.
 */
export function onAppForeground(listener: () => void): () => void {
  const page = (globalThis as { document?: Document }).document;
  if (!page || typeof page.addEventListener !== 'function') return () => undefined;
  const changed = () => {
    if (page.visibilityState === 'visible') listener();
  };
  page.addEventListener('visibilitychange', changed);
  return () => page.removeEventListener('visibilitychange', changed);
}
