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
}

/** The questions in a metafield's JSON; a typo or anything else reads as none. Only entries with an id. */
export function parseCustomisation(json: string | null | undefined): CustomisationQuestion[] {
  if (!json) return [];
  try {
    const raw = (JSON.parse(json) as { questions?: unknown } | null)?.questions;
    return Array.isArray(raw) ? raw.filter((q): q is CustomisationQuestion => !!q && typeof q.id === 'string' && !!q.id) : [];
  } catch {
    return [];
  }
}

type WithMetafields = { metafields?: Record<string, string> | null };

/** A product's questions for a variant: the variant's own when it has any, else the product's. */
export function customisationQuestions(
  product: (WithMetafields & { variants?: ReadonlyArray<WithMetafields & { id: string }> | null }) | null | undefined,
  variantId: string | null | undefined,
  config: CustomisationConfig | null | undefined,
): CustomisationQuestion[] {
  if (!product || !config) return [];
  const tail = (id: string) => id.split('/').pop();
  const variant = variantId ? product.variants?.find((v) => tail(v.id) === tail(variantId)) : undefined;
  const own = config.variant ? parseCustomisation(variant?.metafields?.[config.variant]) : [];
  return own.length ? own : config.product ? parseCustomisation(product.metafields?.[config.product]) : [];
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

/** Answers back from saved attributes (a line's, or any `key: label` record): labels mapped to option ids. */
export function answersFromAttributes(
  questions: readonly CustomisationQuestion[],
  attributes: ReadonlyArray<{ key: string; value: string | null }> | Record<string, string> | null | undefined,
): CustomisationAnswers {
  const byKey: Record<string, string> = Array.isArray(attributes)
    ? Object.fromEntries(attributes.filter((a) => a.value != null).map((a) => [a.key, a.value as string]))
    : { ...(attributes ?? {}) };
  const out: CustomisationAnswers = {};
  for (const q of questions) {
    const saved = q.key ? byKey[q.key] : undefined;
    if (!saved) continue;
    if (isFreeText(q)) out[q.id] = saved;
    else {
      const labels = saved.split(', ');
      const ids = (q.options ?? []).filter((o) => labels.includes(o.label)).map((o) => o.id);
      if (ids.length) out[q.id] = q.type === 'multi_select' ? ids : ids[0];
    }
  }
  return out;
}

/** A cart line still needs answers: a question that always shows has no attribute on the line. */
export function lineNeedsCustomisation(questions: readonly CustomisationQuestion[], attributes: ReadonlyArray<{ key: string; value: string | null }>): boolean {
  const saved = new Set(attributes.filter((a) => a.value && !a.key.startsWith('_')).map((a) => a.key));
  return questions.some((q) => !q.condition?.length && !!q.key && !saved.has(q.key));
}
