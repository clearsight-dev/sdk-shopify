import { useCallback, useMemo, useRef } from "react";

import { readAlertSettings, readCartPolicy, isAlertSilenced } from "../alertSettings";
import type { AlertMessages, CartPolicy } from "../types";
import type { ShopifyEvent } from "./ShopifyProvider";

export interface UseAlertSettingsOptions {
  /** The Live Layer's `settings.alerts` subtree (`ALERT_SETTINGS_PATH`). */
  alerts: unknown;
  /** The Live Layer's `settings.cart.maxLineItems` (`MAX_LINE_ITEMS_SETTING_PATH`). */
  maxLineItems?: unknown;
  /** Show one alert, e.g. the app's toast. Not called for alerts the merchant cleared. */
  show: (message: string, severity: ShopifyEvent["severity"]) => void;
}

export interface AlertSettingsProps {
  messages: AlertMessages;
  cartPolicy: CartPolicy;
  onEvent: (event: ShopifyEvent) => void;
}

/**
 * The Settings panel's alerts and cart limit, as `ShopifyProvider` props. The app
 * reads the two Live Layer values and passes its toast; the path table, the
 * "cleared means silent" rule and the limit bounds stay here.
 *
 * ```tsx
 * const alerts = useLL(ALERT_SETTINGS_PATH);
 * const maxLineItems = useLL(MAX_LINE_ITEMS_SETTING_PATH);
 * const props = useAlertSettings({ alerts, maxLineItems, show: showToast });
 * <ShopifyProvider config={config} {...props}>
 * ```
 *
 * `onEvent` keeps one identity for the provider's lifetime, so a new `show`
 * arrow on each render rebuilds nothing.
 */
export function useAlertSettings({ alerts, maxLineItems, show }: UseAlertSettingsOptions): AlertSettingsProps {
  const { messages, silenced } = useMemo(() => readAlertSettings(alerts), [alerts]);
  const cartPolicy = useMemo(() => readCartPolicy(maxLineItems), [maxLineItems]);

  const latest = useRef({ silenced, show });
  latest.current = { silenced, show };

  const onEvent = useCallback((event: ShopifyEvent) => {
    const { silenced: quiet, show: display } = latest.current;
    if (isAlertSilenced(event, quiet)) return;
    if (event.message) display(event.message, event.severity);
  }, []);

  return { messages, cartPolicy, onEvent };
}
