/**
 * Product customisation on a page and on the cart (0.22.0; `../customisation.ts`).
 *
 * - `useProductCustomisation({ productHandle, variantId, cartLineId? })`: the questions for the variant,
 *   answers prefilled from the cart line, else what this device last saved for the variant, and `save()`:
 *   the answers onto the line (its `_` attributes kept) and onto this device.
 * - `useCartCustomisation()`: the cart lines that still need answers, for holding checkout. `known` stays
 *   false until every line's product has been read, so a gate can wait rather than guess.
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

/** Where this device keeps the last answers per variant (one JSON record, by the variant's number). */
export const CUSTOMISATION_STORAGE_KEY = 'customisation.answers';

const tail = (id: string | null | undefined) => (id ? id.split('/').pop() ?? id : null);

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
  /** Saves onto the cart line (when given) and this device. False when the line couldn't be updated. */
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
      let fromDevice: CustomisationAnswers = {};
      try {
        const stored = deviceStorage ? await deviceStorage.getItem(CUSTOMISATION_STORAGE_KEY) : null;
        fromDevice = (stored ? JSON.parse(stored) : {})[tail(variantId) ?? ''] ?? {};
      } catch {
        // Unreadable: start empty.
      }
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
          const stored = await deviceStorage.getItem(CUSTOMISATION_STORAGE_KEY);
          const all = stored ? JSON.parse(stored) : {};
          await deviceStorage.setItem(CUSTOMISATION_STORAGE_KEY, JSON.stringify({ ...all, [tail(variantId) as string]: answers }));
        } catch {
          // The line has the answers; this device's copy is a convenience.
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
