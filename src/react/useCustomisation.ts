/**
 * Product customisation on a page and on the cart (0.22.0; `../customisation.ts`).
 *
 * - `useProductCustomisation({ productHandle, variantId, cartLineId? })`: the questions for the variant,
 *   answers prefilled from the cart line, else what this device last saved for the variant, and `save()`:
 *   the answers onto the line (its `_` attributes kept) and onto this device.
 * - `useCartCustomisation()`: the cart lines that still need answers, for holding checkout. `known` stays
 *   false until every line's product has been read, so a gate can wait rather than guess.
 * - `useSavedCustomisations()`: what this device saved per variant, answers and line attributes, for items
 *   bought outside the cart (an auction's wins): their answers go on the cart that is made for them.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  answersFromAttributes,
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
import { useCart, useShopify } from './ShopifyProvider';
import { useProduct } from './useProduct';
import { useProductsById } from './useProductsById';

/**
 * Where this device keeps the last answers per variant: one JSON record, by the variant's number, each
 * `{ answers, attributes }` (the answers by question id, and as the line attributes they save as).
 */
export const CUSTOMISATION_STORAGE_KEY = 'customisation.answers';

const tail = (id: string | null | undefined) => (id ? id.split('/').pop() ?? id : null);

type Attribute = { key: string; value: string };
interface SavedEntry {
  answers: CustomisationAnswers;
  attributes: Attribute[];
}
type SavedRecord = Record<string, SavedEntry>;
type DeviceStorage = NonNullable<ReturnType<typeof useShopify>['deviceStorage']>;

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

/** One copy of the device's record per storage, shared by every hook, told of each save. */
const savedStores = new WeakMap<DeviceStorage, { record: SavedRecord | null; reading: Promise<SavedRecord> | null; listeners: Set<() => void> }>();
function savedStore(storage: DeviceStorage) {
  let store = savedStores.get(storage);
  if (!store) {
    store = { record: null, reading: null, listeners: new Set() };
    savedStores.set(storage, store);
  }
  return store;
}
async function readSaved(storage: DeviceStorage): Promise<SavedRecord> {
  const store = savedStore(storage);
  if (store.record) return store.record;
  store.reading ??= (async () => {
    let record: SavedRecord = {};
    try {
      const stored = await storage.getItem(CUSTOMISATION_STORAGE_KEY);
      const parsed = stored ? JSON.parse(stored) : {};
      if (parsed && typeof parsed === 'object') record = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, toEntry(v)]));
    } catch {
      // Unreadable: start empty.
    }
    store.record ??= record;
    return store.record;
  })();
  return store.reading;
}
async function writeSaved(storage: DeviceStorage, variantId: string, entry: SavedEntry): Promise<void> {
  const store = savedStore(storage);
  const record = { ...(await readSaved(storage)), [tail(variantId) as string]: entry };
  await storage.setItem(CUSTOMISATION_STORAGE_KEY, JSON.stringify(record));
  store.record = record;
  store.listeners.forEach((listener) => listener());
}

export interface ProductCustomisation {
  questions: CustomisationQuestion[];
  /** The questions showing for the answers so far. */
  visible: CustomisationQuestion[];
  answers: CustomisationAnswers;
  setAnswer: (questionId: string, answer: CustomisationAnswer) => void;
  /** Every question showing is answered. */
  complete: boolean;
  loading: boolean;
  saving: boolean;
  /** Saves onto the cart line (when given) and this device. False when the line, or with none this device, couldn't be. */
  save: () => Promise<boolean>;
}

export function useProductCustomisation(options: { productHandle: string | null | undefined; variantId: string | null | undefined; cartLineId?: string | null }): ProductCustomisation {
  const { productHandle, variantId, cartLineId } = options;
  const { ready, deviceStorage } = useShopify();
  const customisation = ready || isConfigured() ? getConfig().customisation : undefined;
  const { cart, updateLine } = useCart();
  const product = useProduct(productHandle);
  const shown = product.product ?? product.preview;
  const questions = useMemo(() => customisationQuestions(shown, variantId, customisation), [shown, variantId, customisation]);
  const line = cartLineId ? cart?.lines.find((l) => l.id === cartLineId) ?? null : null;

  const [answers, setAnswers] = useState<CustomisationAnswers>({});
  const [prefilledFor, setPrefilledFor] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Prefill once per variant and question set: the line's own answers, else this device's last for the variant.
  const prefillKey = questions.length ? `${tail(variantId)}|${questions.map((q) => q.id).join(',')}` : null;
  useEffect(() => {
    if (!prefillKey || prefilledFor === prefillKey) return;
    let current = true;
    void (async () => {
      const fromLine = line ? answersFromAttributes(questions, line.attributes) : {};
      const fromDevice = deviceStorage ? (await readSaved(deviceStorage))[tail(variantId) ?? '']?.answers ?? {} : {};
      if (!current) return;
      setAnswers({ ...fromDevice, ...fromLine });
      setPrefilledFor(prefillKey);
    })();
    return () => {
      current = false;
    };
  }, [prefillKey, prefilledFor, line, questions, deviceStorage, variantId]);

  const setAnswer = useCallback((questionId: string, answer: CustomisationAnswer) => setAnswers((a) => ({ ...a, [questionId]: answer })), []);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const attributes = customisationAttributes(questions, answers);
      if (line) {
        const kept = line.attributes.filter((a) => a.key.startsWith('_') && a.value != null).map((a) => ({ key: a.key, value: a.value as string }));
        if (!(await updateLine(line.id, line.quantity, [...kept, ...attributes]))) return false;
      }
      if (deviceStorage && variantId) {
        try {
          await writeSaved(deviceStorage, variantId, { answers, attributes });
        } catch {
          // Without a line, this copy is where the answers live: a failed write is a failed save.
          if (!line) return false;
        }
      }
      return true;
    } finally {
      setSaving(false);
    }
  }, [questions, answers, line, updateLine, deviceStorage, variantId]);

  return {
    questions,
    visible: visibleQuestions(questions, answers),
    answers,
    setAnswer,
    complete: customisationComplete(questions, answers),
    loading: !shown && product.loading,
    saving,
    save,
  };
}

export interface CartCustomisation {
  /** The cart lines whose product asks questions. */
  customisableLineIds: string[];
  /** The cart lines that still need answers. */
  lineIds: string[];
  /** Every line's product has been read: until then, don't let checkout through on a guess. */
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
    if (!customisation) return { customisableLineIds: [], lineIds: [], known: true };
    // Read once, or failed: a gone product leaves `byId` short for good, so "all present" can't be the test.
    const known = productIds.every((id) => id in products.byId) || (!products.loading && (products.products.length > 0 || products.error));
    const asking = lines.flatMap((l) => {
      const product = l.product ? products.byId[l.product.id] : undefined;
      const questions = product ? customisationQuestions(product, l.merchandise.id, customisation) : [];
      return questions.length ? [{ line: l, questions }] : [];
    });
    return {
      customisableLineIds: asking.map(({ line }) => line.id),
      lineIds: asking.filter(({ line, questions }) => lineNeedsCustomisation(questions, line.attributes)).map(({ line }) => line.id),
      known,
    };
  }, [customisation, products, productIds, lines]);
}

export interface SavedCustomisations {
  /** This device's record has been read. */
  loaded: boolean;
  /** The answers this device last saved for a variant (by question id), or none. */
  answersFor: (variantId: string | null | undefined) => CustomisationAnswers;
  /** The same as the line attributes they save as (`key: label`), or none. */
  attributesFor: (variantId: string | null | undefined) => { key: string; value: string }[];
}

/** What this device saved per variant (`useProductCustomisation`'s `save()`), kept current as saves happen. */
export function useSavedCustomisations(): SavedCustomisations {
  const { deviceStorage } = useShopify();
  const [record, setRecord] = useState<SavedRecord | null>(() => (deviceStorage ? savedStore(deviceStorage).record : null));
  useEffect(() => {
    if (!deviceStorage) return;
    let current = true;
    const store = savedStore(deviceStorage);
    const update = () => {
      if (current && store.record) setRecord(store.record);
    };
    store.listeners.add(update);
    void readSaved(deviceStorage).then(update);
    return () => {
      current = false;
      store.listeners.delete(update);
    };
  }, [deviceStorage]);
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
  /** Of those, the ones this device has no answers for yet (a question that always shows is unanswered). */
  unansweredIds: string[];
  /** Each item's saved answers, as line attributes. */
  attributesById: Record<string, { key: string; value: string }[]>;
  /** This device's answers have been read: until then, don't let checkout through on a guess. */
  known: boolean;
}

/**
 * `useCartCustomisation` for items that aren't cart lines yet (0.22.0): an auction's wins, paid on a cart
 * made at checkout. Each item's product (with its metafields) and variant; answers are this device's
 * (`useSavedCustomisations`), to put on the cart that is made for them.
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
    for (const item of items) {
      const questions = customisationQuestions(item.product, item.variantId, customisation);
      if (!questions.length) continue;
      const attributes = saved.attributesFor(item.variantId);
      customisableIds.push(item.id);
      attributesById[item.id] = attributes;
      if (lineNeedsCustomisation(questions, attributes)) unansweredIds.push(item.id);
    }
    return { customisableIds, unansweredIds, attributesById, known: saved.loaded };
  }, [items, customisation, saved]);
}
