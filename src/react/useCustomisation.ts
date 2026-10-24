/**
 * Product customisation on a page and on the cart (0.23.0; `../customisation.ts`).
 *
 * - `useProductCustomisation({ productHandle, variantId, cartLineId? })`: the questions for the variant,
 *   answers prefilled from the cart line, else what the customer's account saved for the variant, else
 *   what this device last saved for it, else the account's last choices anywhere; and `save()`: the
 *   answers onto the line (its `_` attributes kept), this device and the account.
 * - `useOptionPreferences()`: the option choices the customer's account remembers (`Size: '6"'`), for a
 *   product page to open on, and `remember()` to save one.
 * - `useCartCustomisation()`: the cart lines that still need answers, for holding checkout. `known` stays
 *   false until every line's product has been read, so a gate can wait rather than guess.
 * - `useSavedCustomisations()`: what this device saved per variant, answers and line attributes, for items
 *   bought outside the cart (an auction's wins): their answers go on the cart that is made for them.
 *
 * Whose answers: this device keeps one shopper's at a time, marked with whose they are (the customer's
 * number, or nobody signed in). Another shopper's are never shown, put on a cart or saved to an account:
 * the first read for someone else clears them. While a stored session restores, or signed in before the
 * profile has loaded, the device's copy is neither read nor written.
 *
 * The account copy (`ShopifyConfig.customisation.accountMetafield`, `AccountCustomisations`) is read and
 * written for a Shopify sign-in only (the Customer Account API); signed out, or with a password session,
 * the device's copy is the only one.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  accountAnswersFor,
  accountPreferences,
  answersFromAttributes,
  lastChoicesAsAnswers,
  parseAccountCustomisations,
  withPreferences,
  withSavedCustomisation,
  type AccountCustomisations,
  type SavedLabels,
  customisationAttributes,
  customisationComplete,
  customisationQuestions,
  lineNeedsCustomisation,
  visibleQuestions,
  type CustomisationAnswer,
  type CustomisationAnswers,
  type CustomisationQuestion,
} from '../customisation';
import { getConfig, isConfigured } from '../client';
import { onAppForeground } from './appForeground';
import { useCart, useCustomer, useShopify, type CustomerState } from './ShopifyProvider';
import { useProduct } from './useProduct';
import { isGoneFromStore, useProductsById } from './useProductsById';

/**
 * The default for `CustomisationConfig.storageKey`: where this device keeps the last answers per variant.
 * One JSON record, by the variant's number, each `{ answers, attributes }` (the answers by question id, and
 * as the line attributes they save as), and under `_customer` whose answers they are.
 */
export const CUSTOMISATION_STORAGE_KEY = 'tile:shopify:customisation:v1';
/** The record's entry naming whose answers it holds: a customer's number, or '' for nobody signed in. */
const OWNER_ENTRY = '_customer';

const tail = (id: string | null | undefined) => (id ? id.split('/').pop() ?? id : null);

type Attribute = { key: string; value: string };
interface SavedEntry {
  answers: CustomisationAnswers;
  attributes: Attribute[];
}
type SavedRecord = Record<string, SavedEntry>;
/** The device's record: the answers by variant number, and whose (null: a record from before 0.23.0, nobody's yet). */
interface DeviceRecord {
  owner: string | null;
  byVariant: SavedRecord;
}
type DeviceStorage = NonNullable<ReturnType<typeof useShopify>['deviceStorage']>;

/** Where this app keeps the answers: `customisation.storageKey`, else the default. */
function deviceKeyOf(customisation: { storageKey?: string } | undefined): string {
  return customisation?.storageKey || CUSTOMISATION_STORAGE_KEY;
}

/**
 * Whose answers this device may show and save now: the signed-in customer's number, '' when nobody is
 * signed in, null while that isn't known (a stored session restoring, or a profile not loaded yet).
 */
function deviceOwnerOf(customer: Pick<CustomerState, 'restoring' | 'loggedIn' | 'customer'>): string | null {
  if (customer.loggedIn) return tail(customer.customer?.id);
  return customer.restoring ? null : '';
}

/** An entry as stored: `{ answers, attributes }`, or an earlier bare answers record. */
function toEntry(raw: unknown): SavedEntry {
  if (!raw || typeof raw !== 'object') return { answers: {}, attributes: [] };
  const value = raw as Partial<SavedEntry>;
  if (value.answers && typeof value.answers === 'object') {
    const attributes = Array.isArray(value.attributes) ? value.attributes.filter((a) => a && typeof a.key === 'string' && typeof a.value === 'string') : [];
    return { answers: value.answers, attributes };
  }
  return { answers: raw as CustomisationAnswers, attributes: [] };
}

function parseDeviceRecord(stored: string | null): DeviceRecord {
  const record: DeviceRecord = { owner: null, byVariant: {} };
  try {
    const parsed: unknown = stored ? JSON.parse(stored) : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed)) {
        if (key === OWNER_ENTRY) record.owner = typeof value === 'string' ? value : null;
        else record.byVariant[key] = toEntry(value);
      }
    }
  } catch {
    // Unreadable: start empty.
  }
  return record;
}

/** One copy of the device's record per storage and key, shared by every hook, told of each save. */
const deviceStores = new WeakMap<DeviceStorage, Map<string, { record: DeviceRecord | null; reading: Promise<DeviceRecord> | null; listeners: Set<() => void> }>>();
function deviceStore(storage: DeviceStorage, key: string) {
  let byKey = deviceStores.get(storage);
  if (!byKey) {
    byKey = new Map();
    deviceStores.set(storage, byKey);
  }
  let store = byKey.get(key);
  if (!store) {
    store = { record: null, reading: null, listeners: new Set() };
    byKey.set(key, store);
  }
  return store;
}
async function readDevice(storage: DeviceStorage, key: string): Promise<DeviceRecord> {
  const store = deviceStore(storage, key);
  if (store.record) return store.record;
  store.reading ??= Promise.resolve()
    .then(() => storage.getItem(key))
    .catch(() => null)
    .then((stored) => (store.record ??= parseDeviceRecord(stored)));
  return store.reading;
}
async function writeDevice(storage: DeviceStorage, key: string, record: DeviceRecord): Promise<void> {
  const store = deviceStore(storage, key);
  await storage.setItem(key, JSON.stringify({ [OWNER_ENTRY]: record.owner, ...record.byVariant }));
  store.record = record;
  store.listeners.forEach((listener) => listener());
}
const isOwners = (record: DeviceRecord, owner: string) => record.owner === null || record.owner === owner;

/** What this device holds for `owner`. Another shopper's answers are cleared, never returned; a record from before 0.23.0 is taken as this shopper's. */
async function readSaved(storage: DeviceStorage, key: string, owner: string): Promise<SavedRecord> {
  const record = await readDevice(storage, key);
  if (isOwners(record, owner)) return record.byVariant;
  try {
    await writeDevice(storage, key, { owner, byVariant: {} });
  } catch {
    // Not cleared on the phone, but still never shown.
  }
  return {};
}
async function writeSaved(storage: DeviceStorage, key: string, owner: string, variantId: string, entry: SavedEntry): Promise<void> {
  const record = await readDevice(storage, key);
  const kept = isOwners(record, owner) ? record.byVariant : {};
  await writeDevice(storage, key, { owner, byVariant: { ...kept, [tail(variantId) as string]: entry } });
}

// ─── The customer's account copy ─────────────────────────────────────────────────────────────────────

export const ACCOUNT_CUSTOMISATIONS_QUERY = /* GraphQL */ `
  query CustomerCustomisations($namespace: String!, $key: String!) {
    customer {
      id
      metafield(namespace: $namespace, key: $key) {
        value
      }
    }
  }
`;

export const ACCOUNT_CUSTOMISATIONS_SET = /* GraphQL */ `
  mutation SetCustomerCustomisations($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      userErrors {
        field
        message
      }
    }
  }
`;

type AccountSource = Pick<CustomerState, 'sessionKind' | 'request' | 'loggedIn' | 'customer'>;
interface AccountStore {
  source: AccountSource;
  customerId: string | null;
  /** The last good read, for display; null until one lands. */
  record: AccountCustomisations | null;
  reading: Promise<AccountCustomisations> | null;
  /** The last read failed (tried again on the next read). */
  failed: boolean;
  /** Writes run one at a time: each reads the whole value and writes it back. */
  writes: Promise<unknown>;
  listeners: Set<() => void>;
}

/** One per session (`request` is stable for the provider's life), shared by every hook. */
const accountStores = new WeakMap<CustomerState['request'], AccountStore>();
function accountStore(customer: CustomerState): AccountStore {
  let store = accountStores.get(customer.request);
  if (!store) {
    store = { source: customer, customerId: null, record: null, reading: null, failed: false, writes: Promise.resolve(), listeners: new Set() };
    accountStores.set(customer.request, store);
  }
  store.source = customer;
  const customerId = customer.loggedIn && customer.sessionKind === 'shopify' ? customer.customer?.id ?? null : null;
  if (customerId !== store.customerId) {
    // Another account (or none): nothing of the last one's is shown or written to.
    store.customerId = customerId;
    store.record = null;
    store.reading = null;
    store.failed = false;
  }
  return store;
}

/** A Shopify sign-in whose account can't be read yet: the session restoring, or the profile not loaded. */
function accountNotKnownYet(customer: CustomerState): boolean {
  if (!customer.loggedIn) return customer.restoring;
  return customer.sessionKind === 'shopify' && !customer.customer?.id;
}

function metafieldOf(id: string): { namespace: string; key: string } | null {
  const at = id.indexOf('.');
  return at > 0 && at < id.length - 1 ? { namespace: id.slice(0, at), key: id.slice(at + 1) } : null;
}

/** The value now, and the customer's id to write it to. Throws when it can't be read. */
async function fetchAccount(store: AccountStore, metafield: { namespace: string; key: string }) {
  const data = await store.source.request<{ customer: { id: string; metafield: { value: string | null } | null } | null }>(ACCOUNT_CUSTOMISATIONS_QUERY, metafield);
  if (!data?.customer?.id) throw new Error('[sdk-shopify] no customer for the session');
  return { ownerId: data.customer.id, record: parseAccountCustomisations(data.customer.metafield?.value) };
}

/** What the account holds, read once per customer. Empty signed out, unset, or when the read fails (tried again next time). */
async function readAccount(store: AccountStore, metafieldId: string | undefined): Promise<AccountCustomisations> {
  const metafield = metafieldId ? metafieldOf(metafieldId) : null;
  if (!metafield || !store.customerId) return {};
  if (store.record) return store.record;
  const customerId = store.customerId;
  const reading = (store.reading ??= fetchAccount(store, metafield).then(({ record }) => record));
  try {
    const record = await reading;
    if (store.customerId === customerId) {
      store.record = record;
      store.failed = false;
      store.listeners.forEach((listener) => listener());
    }
    return record;
  } catch (error) {
    if (store.reading === reading) {
      store.reading = null;
      store.failed = true;
      store.listeners.forEach((listener) => listener());
    }
    console.warn('[sdk-shopify] saved customisations did not load', error);
    return {};
  }
}

/**
 * Changes the account's value: read whole, changed, written back, one write at a time. A value that
 * can't be read is left alone (false), so a failed read never replaces everything saved with one entry;
 * and a write queued for one customer never lands in another's account.
 */
function writeAccount(store: AccountStore, metafieldId: string | undefined, change: (record: AccountCustomisations) => AccountCustomisations): Promise<boolean> {
  const metafield = metafieldId ? metafieldOf(metafieldId) : null;
  const customerId = store.customerId;
  if (!metafield || !customerId) return Promise.resolve(false);
  const write = async () => {
    if (store.customerId !== customerId) return false;
    const { ownerId, record } = await fetchAccount(store, metafield);
    // The session's customer now isn't the one this write was for.
    if (tail(ownerId) !== tail(customerId) || store.customerId !== customerId) return false;
    const next = change(record);
    const data = await store.source.request<{ metafieldsSet: { userErrors: { message: string }[] } | null }>(ACCOUNT_CUSTOMISATIONS_SET, {
      metafields: [{ ownerId, ...metafield, type: 'json', value: JSON.stringify(next) }],
    });
    const errors = data?.metafieldsSet?.userErrors ?? [];
    if (!data?.metafieldsSet || errors.length) throw new Error(errors[0]?.message ?? '[sdk-shopify] the customisation metafield was not saved');
    if (store.customerId === customerId) {
      store.record = next;
      store.listeners.forEach((listener) => listener());
    }
    return true;
  };
  const run = store.writes.then(write, write).catch((error) => {
    console.warn('[sdk-shopify] customisations were not saved to the account', error);
    return false;
  });
  store.writes = run;
  return run;
}

export interface ProductCustomisation {
  questions: CustomisationQuestion[];
  /** The questions showing for the answers so far. */
  visible: CustomisationQuestion[];
  answers: CustomisationAnswers;
  setAnswer: (questionId: string, answer: CustomisationAnswer) => void;
  /** Every question showing is answered. */
  complete: boolean;
  /** The product, or the saved answers, are still being read. What the shopper types meanwhile is kept. */
  loading: boolean;
  saving: boolean;
  /**
   * Saves onto the cart line (when given), this device and the account (not waited for). False when the
   * line isn't in the cart or couldn't be updated, or, with no line, when this device couldn't be written.
   */
  save: () => Promise<boolean>;
}

export function useProductCustomisation(options: { productHandle: string | null | undefined; variantId: string | null | undefined; cartLineId?: string | null }): ProductCustomisation {
  const { productHandle, variantId, cartLineId } = options;
  const { ready, deviceStorage } = useShopify();
  const customisation = ready || isConfigured() ? getConfig().customisation : undefined;
  const storageKey = deviceKeyOf(customisation);
  const customer = useCustomer();
  const account = accountStore(customer);
  const owner = deviceOwnerOf(customer);
  const accountMetafield = customisation?.accountMetafield;
  const { cart, updateLine } = useCart();
  const product = useProduct(productHandle);
  const shown = product.product ?? product.preview;
  const questions = useMemo(() => customisationQuestions(shown, variantId, customisation), [shown, variantId, customisation]);
  const line = cartLineId ? cart?.lines.find((l) => l.id === cartLineId) ?? null : null;

  const [answers, setAnswers] = useState<CustomisationAnswers>({});
  const [prefilledFrom, setPrefilledFrom] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // The questions the shopper answered on this form: a prefill landing later never overwrites them. A new
  // variant or question set is a new form.
  const formKey = questions.length ? `${tail(variantId)}|${questions.map((q) => q.id).join(',')}` : null;
  const typed = useRef<{ form: string | null; ids: Set<string> }>({ form: null, ids: new Set() });
  if (typed.current.form !== formKey) typed.current = { form: formKey, ids: new Set() };

  // Prefilled per form, and again when whose answers they are becomes known (a profile loading) or the
  // line turns up: each question from the first that has it, the line's own answers, the account's for
  // the variant, this device's for the variant, the account's last choices. The line's and the device's
  // show at once; the account's when its read lands.
  const sourcesKey = formKey ? `${formKey}|${owner ?? '?'}|${account.customerId ?? ''}|${line?.id ?? ''}` : null;
  const latest = useRef({ questions, line, variantId, deviceStorage, storageKey, owner, account, accountMetafield });
  latest.current = { questions, line, variantId, deviceStorage, storageKey, owner, account, accountMetafield };
  useEffect(() => {
    if (!sourcesKey) return;
    let current = true;
    const { questions, line, variantId, deviceStorage, storageKey, owner, account, accountMetafield } = latest.current;
    const fill = (found: CustomisationAnswers) =>
      setAnswers((now) => ({ ...found, ...Object.fromEntries(Object.entries(now).filter(([id]) => typed.current.ids.has(id))) }));
    void (async () => {
      const fromLine = line ? answersFromAttributes(questions, line.attributes) : {};
      const saved = deviceStorage && owner !== null ? await readSaved(deviceStorage, storageKey, owner) : {};
      const ids = new Set(questions.map((q) => q.id));
      const fromDevice = Object.fromEntries(Object.entries(saved[tail(variantId) ?? '']?.answers ?? {}).filter(([id]) => ids.has(id)));
      if (!current) return;
      fill({ ...fromDevice, ...fromLine });
      const fromAccount = await readAccount(account, accountMetafield);
      if (!current) return;
      fill({
        ...lastChoicesAsAnswers(questions, fromAccount),
        ...fromDevice,
        ...answersFromAttributes(questions, accountAnswersFor(fromAccount, variantId)),
        ...fromLine,
      });
      setPrefilledFrom(sourcesKey);
    })();
    return () => {
      current = false;
    };
  }, [sourcesKey]);

  const setAnswer = useCallback((questionId: string, answer: CustomisationAnswer) => {
    typed.current.ids.add(questionId);
    setAnswers((a) => ({ ...a, [questionId]: answer }));
  }, []);

  const save = useCallback(async () => {
    // A line was named and the cart doesn't have it: nothing is saved, so the caller isn't told it was.
    if (cartLineId && !line) return false;
    setSaving(true);
    try {
      const attributes = customisationAttributes(questions, answers);
      if (line) {
        const kept = line.attributes.filter((a) => a.key.startsWith('_') && a.value != null).map((a) => ({ key: a.key, value: a.value as string }));
        if (!(await updateLine(line.id, line.quantity, [...kept, ...attributes]))) return false;
      }
      const toAccount = variantId ? writeAccount(account, accountMetafield, (record) => withSavedCustomisation(record, variantId, questions, answers)) : null;
      if (deviceStorage && variantId && owner !== null) {
        // Only what shows: a hidden question's old answer isn't kept.
        const showing = Object.fromEntries(visibleQuestions(questions, answers).filter((q) => q.id in answers).map((q) => [q.id, answers[q.id]]));
        try {
          await writeSaved(deviceStorage, storageKey, owner, variantId, { answers: showing, attributes });
        } catch {
          // Without a line, this copy is where the answers live: a failed write is a failed save.
          if (!line) return false;
        }
      } else if (!line) {
        // No line and no device copy to write: the account is the only one.
        return toAccount ? await toAccount : false;
      }
      return true;
    } finally {
      setSaving(false);
    }
  }, [cartLineId, questions, answers, line, updateLine, deviceStorage, storageKey, owner, variantId, account, accountMetafield]);

  return {
    questions,
    visible: visibleQuestions(questions, answers),
    answers,
    setAnswer,
    complete: customisationComplete(questions, answers),
    loading: (!shown && product.loading) || (!!sourcesKey && prefilledFrom !== sourcesKey),
    saving,
    save,
  };
}

export interface CartCustomisation {
  /** The cart lines whose product asks questions. */
  customisableLineIds: string[];
  /** Of those, the lines that still need answers. */
  unansweredLineIds: string[];
  /**
   * Every line's product has been read: until then, don't let checkout through on a guess. False after a
   * failed read (tried again when the lines change or the screen mounts again) and for a line just added.
   */
  known: boolean;
}

export function useCartCustomisation(): CartCustomisation {
  const { ready } = useShopify();
  const customisation = ready || isConfigured() ? getConfig().customisation : undefined;
  const { cart } = useCart();
  const lines = cart?.lines ?? [];
  const productIds = useMemo(() => [...new Set(lines.map((l) => l.product?.id).filter((id): id is string => !!id))], [lines]);
  const products = useProductsById(customisation ? productIds : null);
  return useMemo(() => {
    if (!customisation) return { customisableLineIds: [], unansweredLineIds: [], known: true };
    // Each line's product read this session, found or gone from the store. Checked against the lines now,
    // so a line added since the last read isn't known until its own read lands.
    const known = productIds.every((id) => id in products.byId || isGoneFromStore(id));
    const asking = lines.flatMap((l) => {
      const product = l.product ? products.byId[l.product.id] : undefined;
      const questions = product ? customisationQuestions(product, l.merchandise.id, customisation) : [];
      return questions.length ? [{ line: l, questions }] : [];
    });
    return {
      customisableLineIds: asking.map(({ line }) => line.id),
      unansweredLineIds: asking.filter(({ line, questions }) => lineNeedsCustomisation(questions, line.attributes)).map(({ line }) => line.id),
      known,
    };
  }, [customisation, products, productIds, lines]);
}

export interface SavedCustomisations {
  /** This device's answers for the shopper signed in now have been read (false while whose isn't known yet). */
  loaded: boolean;
  /** The answers this device last saved for a variant (by question id), or none. */
  answersFor: (variantId: string | null | undefined) => CustomisationAnswers;
  /** The same as the line attributes they save as (`key: label`), or none. */
  attributesFor: (variantId: string | null | undefined) => { key: string; value: string }[];
}

/** What this device saved per variant (`useProductCustomisation`'s `save()`) for the shopper signed in now, kept current as saves happen. */
export function useSavedCustomisations(): SavedCustomisations {
  const { ready, deviceStorage } = useShopify();
  const storageKey = deviceKeyOf(ready || isConfigured() ? getConfig().customisation : undefined);
  const owner = deviceOwnerOf(useCustomer());
  const [saved, setSaved] = useState<{ owner: string; record: SavedRecord } | null>(() => {
    const record = deviceStorage && owner !== null ? deviceStore(deviceStorage, storageKey).record : null;
    return record && owner !== null && isOwners(record, owner) ? { owner, record: record.byVariant } : null;
  });
  useEffect(() => {
    if (!deviceStorage || owner === null) return;
    let current = true;
    const store = deviceStore(deviceStorage, storageKey);
    const update = () =>
      void readSaved(deviceStorage, storageKey, owner).then((record) => {
        if (current) setSaved({ owner, record });
      });
    store.listeners.add(update);
    update();
    return () => {
      current = false;
      store.listeners.delete(update);
    };
  }, [deviceStorage, storageKey, owner]);
  const record = saved && saved.owner === owner ? saved.record : null;
  return useMemo(
    () => ({
      loaded: !deviceStorage || record !== null,
      answersFor: (variantId) => record?.[tail(variantId) ?? '']?.answers ?? {},
      attributesFor: (variantId) => record?.[tail(variantId) ?? '']?.attributes ?? [],
    }),
    [record, deviceStorage],
  );
}

export interface ItemsCustomisation {
  /** The items whose product asks questions. */
  customisableIds: string[];
  /** Of those, the ones this device has no complete answers for yet (every question showing). */
  unansweredIds: string[];
  /** Each item's saved answers, as line attributes. */
  attributesById: Record<string, { key: string; value: string }[]>;
  /** This device's answers and every item's product have been read: until then, don't let checkout through on a guess. */
  known: boolean;
}

/**
 * `useCartCustomisation` for items that aren't cart lines yet (0.23.0): an auction's wins, paid on a cart
 * made at checkout. Each item's product (with its metafields; `undefined` while it is being read, `null`
 * when the store has no such product) and variant; answers are this device's (`useSavedCustomisations`),
 * to put on the cart that is made for them.
 */
export function useItemsCustomisation(
  items: ReadonlyArray<{ id: string; product: Parameters<typeof customisationQuestions>[0]; variantId: string | null | undefined }>,
): ItemsCustomisation {
  const { ready } = useShopify();
  const customisation = ready || isConfigured() ? getConfig().customisation : undefined;
  const saved = useSavedCustomisations();
  return useMemo(() => {
    const customisableIds: string[] = [];
    const unansweredIds: string[] = [];
    const attributesById: Record<string, { key: string; value: string }[]> = {};
    let productsRead = true;
    for (const item of items) {
      if (item.product === undefined) {
        productsRead = false;
        continue;
      }
      const questions = customisationQuestions(item.product, item.variantId, customisation);
      if (!questions.length) continue;
      const answers = saved.answersFor(item.variantId);
      const attributes = customisationAttributes(questions, answers);
      customisableIds.push(item.id);
      attributesById[item.id] = attributes;
      if (!customisationComplete(questions, answers) || lineNeedsCustomisation(questions, attributes)) unansweredIds.push(item.id);
    }
    return { customisableIds, unansweredIds, attributesById, known: saved.loaded && (!customisation || productsRead) };
  }, [items, customisation, saved]);
}

export interface OptionPreferences {
  /**
   * The account has been read, or its read failed (tried again when the app returns to the front). Always
   * true signed out, with a password session, or with no `accountMetafield`; false while a Shopify
   * sign-in's profile is still loading.
   */
  loaded: boolean;
  /** What the shopper chose last, by option name or question key: one label, or a list (a question's several). */
  preferences: SavedLabels;
  /** The option's remembered value, if the product offers it (a list never is one option's value). */
  preferredValue: (optionName: string, values: readonly string[]) => string | null;
  /**
   * Remembers choices (`{ Size: '6"' }`) on the account, merged with what is there: for the taps that mean
   * "this one" (adding to cart, bidding), not every browse. False signed out, unset or refused. Never throws.
   */
  remember: (choices: Record<string, string | null | undefined>) => Promise<boolean>;
}

/** The account's remembered option choices (0.23.0), for a product page to open on. */
export function useOptionPreferences(): OptionPreferences {
  const { ready } = useShopify();
  const accountMetafield = ready || isConfigured() ? getConfig().customisation?.accountMetafield : undefined;
  const customer = useCustomer();
  const account = accountStore(customer);
  const customerId = account.customerId;
  const waiting = accountNotKnownYet(customer);
  const [state, setState] = useState(() => ({ customerId, record: account.record, failed: account.failed }));
  useEffect(() => {
    let current = true;
    const update = () => {
      if (current) setState({ customerId: account.customerId, record: account.record, failed: account.failed });
    };
    account.listeners.add(update);
    update();
    void readAccount(account, accountMetafield).then(update);
    const offForeground = onAppForeground(() => {
      if (account.failed) void readAccount(account, accountMetafield).then(update);
    });
    return () => {
      current = false;
      account.listeners.delete(update);
      offForeground();
    };
  }, [account, accountMetafield, customerId]);
  const remember = useCallback(
    (choices: Record<string, string | null | undefined>) => {
      const picked = Object.fromEntries(Object.entries(choices).filter((entry): entry is [string, string] => !!entry[1]));
      if (!Object.keys(picked).length) return Promise.resolve(false);
      return writeAccount(account, accountMetafield, (r) => withPreferences(r, picked));
    },
    [account, accountMetafield],
  );
  // Never the last customer's, for the render before the effect catches up.
  const record = state.customerId === customerId ? state.record : null;
  const failed = state.customerId === customerId && state.failed;
  return useMemo(() => {
    const shown = customerId && accountMetafield ? record : {};
    const preferences = shown ? accountPreferences(shown) : {};
    return {
      loaded: !accountMetafield || (customerId ? record !== null || failed : !waiting),
      preferences,
      preferredValue: (optionName, values) => {
        const saved = preferences[optionName];
        return typeof saved === 'string' && values.includes(saved) ? saved : null;
      },
      remember,
    };
  }, [record, failed, customerId, accountMetafield, waiting, remember]);
}
