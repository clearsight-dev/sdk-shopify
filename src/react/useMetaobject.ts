/**
 * A Shopify metaobject by its id: a merchant's own content entry, such as a home page hero's words,
 * picture and collection. The screen lays its fields onto a tile's props; tiles never read it.
 *
 * Read once per id and kept for the session, so coming back to the page draws it at once;
 * `refresh()` reads it again (pull to refresh).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { isConfigured } from '../client';
import { shopify } from '../shopify';
import type { Metaobject, MetaobjectField } from '../types';
import { useShopify } from './ShopifyProvider';

export interface UseMetaobjectOptions {
  /** Read it. @default true */
  enabled?: boolean;
  onError?: (error: unknown, context: { at: string; id: string }) => void;
}

export interface MetaobjectState {
  metaobject: Metaobject | null;
  /** The fields by key; empty until read, or when the store has no such entry. */
  fields: Record<string, MetaobjectField>;
  /** Reading, with nothing known yet. */
  loading: boolean;
  /** The last read failed; what was known stays. */
  error: boolean;
  refresh(): void;
}

/** This session's reads, by id: the entry, or null when the store has none. */
const session = new Map<string, Metaobject | null>();

export function useMetaobject(
  id: string | null | undefined,
  options: UseMetaobjectOptions = {},
): MetaobjectState {
  const { ready } = useShopify();
  const configured = ready || isConfigured();
  const enabled = options.enabled ?? true;
  const latest = useRef(options);
  latest.current = options;

  const [state, setState] = useState(() => ({
    metaobject: id ? session.get(id) ?? null : null,
    loading: false,
    error: false,
  }));
  const [reads, setReads] = useState(0);
  const fresh = useRef(false);

  useEffect(() => {
    if (!id || !enabled || !configured) {
      setState({ metaobject: null, loading: false, error: false });
      return;
    }
    const wantsFresh = fresh.current;
    fresh.current = false;
    if (!wantsFresh && session.has(id)) {
      setState({ metaobject: session.get(id) ?? null, loading: false, error: false });
      return;
    }
    let live = true;
    setState((current) => ({ ...current, loading: !current.metaobject, error: false }));
    shopify.metaobjects
      .byId(id, { fresh: wantsFresh })
      .then((metaobject) => {
        session.set(id, metaobject);
        if (live) setState({ metaobject, loading: false, error: false });
      })
      .catch((error) => {
        latest.current.onError?.(error, { at: 'useMetaobject', id });
        if (live) setState((current) => ({ ...current, loading: false, error: true }));
      });
    return () => {
      live = false;
    };
  }, [id, enabled, configured, reads]);

  const refresh = useCallback(() => {
    fresh.current = true;
    setReads((count) => count + 1);
  }, []);

  return { ...state, fields: state.metaobject?.fields ?? {}, refresh };
}

/** Forget this session's reads (tests, or a new store). */
export function clearMetaobjects(): void {
  session.clear();
}
