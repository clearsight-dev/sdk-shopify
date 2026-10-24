/**
 * Product customisation (0.23.0): questions a product asks before checkout, answered onto its cart line.
 *
 * The questions are JSON in a product metafield, or a variant's (the variant's wins), named by
 * `ShopifyConfig.customisation` and read with every product (add the same ids to `productMetafields` /
 * `variantMetafields`):
 *
 * ```json
 * { "questions": [
 *   { "id": "q1", "key": "wrist_size", "question": "Wrist size", "type": "text_input" },
 *   { "id": "q2", "key": "engraving", "question": "Engrave?", "type": "choice",
 *     "options": [{ "id": "y", "label": "Yes" }, { "id": "n", "label": "No" }] },
 *   { "id": "q3", "key": "text", "type": "text_input", "condition": [{ "question_id": "q2", "answer": ["y"] }] }
 * ] }
 * ```
 *
 * Types: `text_input` and `number_input` (free text), `multi_select` (several option ids), anything else
 * one option id (`images` use `option.url`, `colors` `option.value`). An answer is saved on the line as
 * `key: label` (several joined with ", "); a question without a `key` isn't saved. A question with a
 * `condition` shows only while each named question's answer is one of its `answer` ids.
 */

export interface CustomisationOption {
  id: string;
  /** What the shopper sees, and what is saved. */
  label: string;
  /** A colour (`colors`), or the swatch caption. */
  value?: string | null;
  /** An image (`images`). */
  url?: string | null;
}

export interface CustomisationQuestion {
  id: string;
  /** The line attribute the answer is saved under. None: never saved. */
  key?: string | null;
  question?: string | null;
  type: string;
  options?: CustomisationOption[] | null;
  condition?: { question_id: string; answer: string[] }[] | null;
}

export type CustomisationAnswer = string | string[];
/** Answers by question id. */
export type CustomisationAnswers = Record<string, CustomisationAnswer>;

/** Where a store keeps its questions: `namespace.key` metafield ids. */
export interface CustomisationConfig {
  product?: string;
  variant?: string;
  /**
   * The customer metafield the shopper's answers are kept in too, `namespace.key` (a JSON metafield; see
   * `AccountCustomisations`). Unset: answers stay on the device.
   */
  accountMetafield?: string;
  /**
   * Where this device keeps the answers (default `CUSTOMISATION_STORAGE_KEY`): an app moving from an
   * earlier app passes the key that app used, so answers saved there still read.
   */
  storageKey?: string;
}

/** The question list in a metafield's JSON, entries with an id only; null when it has no list (unset, or a typo). */
function questionList(json: string | null | undefined): CustomisationQuestion[] | null {
  if (!json) return null;
  try {
    const raw = (JSON.parse(json) as { questions?: unknown } | null)?.questions;
    return Array.isArray(raw) ? raw.filter((q): q is CustomisationQuestion => !!q && typeof q.id === 'string' && !!q.id) : null;
  } catch {
    return null;
  }
}

/** The questions in a metafield's JSON; a typo or anything else reads as none. Only entries with an id. */
export function parseCustomisation(json: string | null | undefined): CustomisationQuestion[] {
  return questionList(json) ?? [];
}

type WithMetafields = { metafields?: Record<string, string> | null };

/**
 * A product's questions for a variant: the variant's own list when it has one (`{"questions":[]}` is a
 * variant that asks nothing), else the product's.
 */
export function customisationQuestions(
  product: (WithMetafields & { variants?: ReadonlyArray<WithMetafields & { id: string }> | null }) | null | undefined,
  variantId: string | null | undefined,
  config: CustomisationConfig | null | undefined,
): CustomisationQuestion[] {
  if (!product || !config) return [];
  const tail = (id: string) => id.split('/').pop();
  const variant = variantId ? product.variants?.find((v) => tail(v.id) === tail(variantId)) : undefined;
  const own = config.variant ? questionList(variant?.metafields?.[config.variant]) : null;
  return own ?? (config.product ? parseCustomisation(product.metafields?.[config.product]) : []);
}

const isFreeText = (q: CustomisationQuestion) => q.type === 'text_input' || q.type === 'number_input';
const given = (answer: CustomisationAnswer | undefined): string[] =>
  (Array.isArray(answer) ? answer : answer != null ? [answer] : []).filter((a) => a !== '' && a !== 'not_selected');

/** Whether a question shows, given the answers so far. */
export function isQuestionVisible(question: CustomisationQuestion, answers: CustomisationAnswers, questions: readonly CustomisationQuestion[]): boolean {
  return (question.condition ?? []).every(
    (c) => !!c && questions.some((q) => q.id === c.question_id) && Array.isArray(c.answer) && given(answers[c.question_id]).some((a) => c.answer.includes(a)),
  );
}

export function visibleQuestions(questions: readonly CustomisationQuestion[], answers: CustomisationAnswers): CustomisationQuestion[] {
  return questions.filter((q) => isQuestionVisible(q, answers, questions));
}

export function isAnswered(question: CustomisationQuestion, answer: CustomisationAnswer | undefined): boolean {
  return question.type === 'multi_select' ? Array.isArray(answer) && answer.length > 0 : given(answer).length > 0;
}

/** Every question showing is answered. */
export function customisationComplete(questions: readonly CustomisationQuestion[], answers: CustomisationAnswers): boolean {
  return visibleQuestions(questions, answers).every((q) => isAnswered(q, answers[q.id]));
}

/** The answers as cart line attributes: the questions showing that have a key, saved as labels. */
export function customisationAttributes(questions: readonly CustomisationQuestion[], answers: CustomisationAnswers): { key: string; value: string }[] {
  return visibleQuestions(questions, answers).flatMap((q) => {
    const answer = answers[q.id];
    if (!q.key || !isAnswered(q, answer)) return [];
    const labels = isFreeText(q)
      ? [String(answer)]
      : (q.options ?? []).filter((o) => given(answer).includes(o.id)).map((o) => o.label);
    return labels.length ? [{ key: q.key, value: labels.join(', ') }] : [];
  });
}

/**
 * Answers back from saved attributes (a line's, or any `key: label` record, a list of labels for several):
 * labels mapped to option ids.
 */
export function answersFromAttributes(
  questions: readonly CustomisationQuestion[],
  attributes: ReadonlyArray<{ key: string; value: string | null }> | Record<string, string | string[]> | null | undefined,
): CustomisationAnswers {
  const byKey: Record<string, string | string[]> = Array.isArray(attributes)
    ? Object.fromEntries(attributes.filter((a) => a.value != null).map((a) => [a.key, a.value as string]))
    : { ...(attributes ?? {}) };
  const out: CustomisationAnswers = {};
  for (const q of questions) {
    const saved = q.key ? byKey[q.key] : undefined;
    if (!saved || (Array.isArray(saved) && !saved.length)) continue;
    if (isFreeText(q)) out[q.id] = Array.isArray(saved) ? saved.join(', ') : saved;
    else {
      const labels = Array.isArray(saved) ? saved.map(String) : saved.split(', ');
      const ids = (q.options ?? []).filter((o) => labels.includes(o.label)).map((o) => o.id);
      if (ids.length) out[q.id] = q.type === 'multi_select' ? ids : ids[0];
    }
  }
  return out;
}

/**
 * A cart line still needs answers: it has none at all (a product whose every question is conditional
 * would otherwise pass unanswered), or a question that always shows has no attribute on the line.
 * Attributes starting with `_` are the app's own (`_lotNumber`), never answers. Questions with no `key`
 * are never saved, so a product asking only those needs nothing on the line.
 */
export function lineNeedsCustomisation(questions: readonly CustomisationQuestion[], attributes: ReadonlyArray<{ key: string; value: string | null }>): boolean {
  if (!questions.some((q) => !!q.key)) return false;
  const saved = new Set(attributes.filter((a) => a.value && !a.key.startsWith('_')).map((a) => a.key));
  return saved.size === 0 || questions.some((q) => !q.condition?.length && !!q.key && !saved.has(q.key));
}

// ─── On the customer's account (0.23.0) ──────────────────────────────────────────────────────────────

/**
 * What a customer's metafield (`CustomisationConfig.accountMetafield`) holds: one JSON object, shared with
 * the store's website, of two shapes told apart by their value:
 *
 * - under a variant's id (`gid://shopify/ProductVariant/…`), an object: the answers the shopper saved for
 *   that variant, by question key, as labels (several as a list);
 * - under any other name, a label or a list of labels: what the shopper chose last anywhere, a choice
 *   question's answer (by its key) or a product option (`Size: '6"'`), so the next product opens on it.
 *   Free text (an engraving) belongs to one item: it stays under its variant and never prefills another.
 */
export type AccountCustomisations = Record<string, unknown>;
/** Labels by question key or option name; a list for several. */
export type SavedLabels = Record<string, string | string[]>;

/** The metafield's value as an object; none is empty. **Throws** for anything else, so a write never replaces what it couldn't read. */
export function parseAccountCustomisations(raw: string | null | undefined): AccountCustomisations {
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('[sdk-shopify] the customisation metafield is not a JSON object');
  return parsed as AccountCustomisations;
}

/** A variant's key in the record: its full id. */
export function accountVariantKey(variantId: string): string {
  return variantId.startsWith('gid://') ? variantId : `gid://shopify/ProductVariant/${variantId}`;
}

const isLabels = (value: unknown): value is string | string[] =>
  typeof value === 'string' || (Array.isArray(value) && value.every((v) => typeof v === 'string'));
const labelsOf = (value: unknown): SavedLabels =>
  Object.fromEntries(Object.entries(value && typeof value === 'object' && !Array.isArray(value) ? value : {}).filter(([, v]) => isLabels(v))) as SavedLabels;

/** The answers saved for a variant, by question key. */
export function accountAnswersFor(record: AccountCustomisations, variantId: string | null | undefined): SavedLabels {
  return variantId ? labelsOf(record[accountVariantKey(variantId)]) : {};
}

/** What the shopper chose last anywhere: the record's labels, without the variants' answers. */
export function accountPreferences(record: AccountCustomisations): SavedLabels {
  return labelsOf(record);
}

/** The answers as the record keeps them: the questions showing that have a key, as labels (a list for `multi_select`). */
export function customisationLabels(questions: readonly CustomisationQuestion[], answers: CustomisationAnswers): SavedLabels {
  const out: SavedLabels = {};
  for (const q of visibleQuestions(questions, answers)) {
    const answer = answers[q.id];
    if (!q.key || !isAnswered(q, answer)) continue;
    if (isFreeText(q)) out[q.key] = String(answer);
    else {
      const labels = (q.options ?? []).filter((o) => given(answer).includes(o.id)).map((o) => o.label);
      if (labels.length) out[q.key] = q.type === 'multi_select' ? labels : labels[0];
    }
  }
  return out;
}

const chosen = (labels: SavedLabels): SavedLabels =>
  Object.fromEntries(Object.entries(labels).filter(([, v]) => (Array.isArray(v) ? v.length > 0 : !!v)));

/** The last choices anywhere as answers to these questions: choice questions only, never free text. */
export function lastChoicesAsAnswers(questions: readonly CustomisationQuestion[], record: AccountCustomisations): CustomisationAnswers {
  return answersFromAttributes(questions.filter((q) => !isFreeText(q)), accountPreferences(record));
}

/**
 * The record with a variant's answers saved: the questions showing, under the variant (what else the
 * website keeps there is kept, a hidden question's old answer is dropped), and the choices among them as
 * the shopper's last choices (free text stays with its variant).
 */
export function withSavedCustomisation(
  record: AccountCustomisations,
  variantId: string,
  questions: readonly CustomisationQuestion[],
  answers: CustomisationAnswers,
): AccountCustomisations {
  const labels = customisationLabels(questions, answers);
  const questionKeys = new Set(questions.map((q) => q.key).filter(Boolean));
  const freeTextKeys = new Set(questions.filter(isFreeText).map((q) => q.key).filter(Boolean));
  const before = record[accountVariantKey(variantId)];
  const others = Object.fromEntries(
    Object.entries(before && typeof before === 'object' && !Array.isArray(before) ? before : {}).filter(([key]) => !questionKeys.has(key)),
  );
  const choices = Object.fromEntries(Object.entries(labels).filter(([key]) => !freeTextKeys.has(key)));
  return { ...record, [accountVariantKey(variantId)]: { ...others, ...labels }, ...chosen(choices) };
}

/** The record with the shopper's choices remembered (empty ones left out). */
export function withPreferences(record: AccountCustomisations, preferences: SavedLabels): AccountCustomisations {
  return { ...record, ...chosen(preferences) };
}
