/**
 * VIP early access for a product (0.23.0; `../earlyAccess.ts`), for the signed-in customer's tags
 * (`useCustomerTags`). Draws again when the lock lifts, so a countdown that reaches zero opens the buy bar
 * without a refresh.
 *
 * ```tsx
 * const access = useEarlyAccess(productPage.product, { active: isFocused });
 * if (access.locked) // "Unlocks in …" until access.unlocksAtMs; access.isVip for the VIP line
 * ```
 *
 * While the tags are unread (`known` false) a VIP reads as everyone else: locked to the end.
 */
import { useEffect, useMemo, useState } from 'react';
import { earlyAccessOf, type EarlyAccess } from '../earlyAccess';
import { useCustomerTags } from './useCustomerTags';

export interface UseEarlyAccess extends EarlyAccess {
  /** Not yet buyable by this customer. */
  locked: boolean;
  /** The customer's tags have been read (always, signed out). */
  known: boolean;
}

/** setTimeout's longest wait; a later unlock is waited for in steps. */
const MAX_TIMER_MS = 2_147_483_647;

export function useEarlyAccess(
  product: { metafields?: Record<string, string> | null } | null | undefined,
  options: { active?: boolean } = {},
): UseEarlyAccess {
  const tags = useCustomerTags({ active: options.active ?? true });
  const [now, setNow] = useState(() => Date.now());
  const access = useMemo(() => earlyAccessOf(product, tags.tags, now), [product, tags.tags, now]);

  // Again at the next change: the lock lifting, or the product opening to everyone (the badge going).
  const nextChangeMs = access.unlocksAtMs ?? access.gatedUntilMs;
  useEffect(() => {
    if (nextChangeMs === null) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(Math.max(nextChangeMs - Date.now(), 0) + 50, MAX_TIMER_MS));
    return () => clearTimeout(timer);
  }, [nextChangeMs]);

  return useMemo(() => ({ ...access, locked: access.unlocksAtMs !== null, known: tags.known }), [access, tags.known]);
}
