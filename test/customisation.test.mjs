// Product customisation (0.22.0): the questions from a metafield, which show, when they're answered, and the
// answers to and from cart line attributes.
import assert from 'node:assert/strict';

const {
  parseCustomisation, customisationQuestions, visibleQuestions, customisationComplete,
  customisationAttributes, answersFromAttributes, lineNeedsCustomisation,
  parseAccountCustomisations, accountAnswersFor, accountPreferences, customisationLabels, withSavedCustomisation, withPreferences,
  lastChoicesAsAnswers,
} = await import('../dist/index.js');

const config = JSON.stringify({ questions: [
  { id: 'q1', key: 'wrist_size', question: 'Wrist size', type: 'text_input' },
  { id: 'q2', key: 'engraving', type: 'choice', options: [{ id: 'y', label: 'Yes' }, { id: 'n', label: 'No' }] },
  { id: 'q3', key: 'engraving_text', type: 'text_input', condition: [{ question_id: 'q2', answer: ['y'] }] },
  { id: 'q4', key: 'charms', type: 'multi_select', options: [{ id: 'h', label: 'Heart' }, { id: 's', label: 'Star' }] },
  { id: 'q5', type: 'text_input' },
  { key: 'no_id', type: 'text_input' },
] });
const questions = parseCustomisation(config);
let pass = 0;
const check = (label, fn) => { fn(); pass++; console.log('  ✓', label); };
console.log('customisation');

check('a metafield’s JSON: entries with an id; a typo or nothing is no questions', () => {
  assert.deepEqual(questions.map((q) => q.id), ['q1', 'q2', 'q3', 'q4', 'q5']);
  assert.deepEqual(parseCustomisation('{not json'), []);
  assert.deepEqual(parseCustomisation(null), []);
});

check('the variant’s questions win over the product’s; config ids name the metafields', () => {
  const variantOnly = JSON.stringify({ questions: [{ id: 'v1', type: 'text_input' }] });
  const product = { metafields: { 'custom.config': config }, variants: [{ id: 'gid://shopify/ProductVariant/1', metafields: { 'custom.vconfig': variantOnly } }, { id: 'gid://shopify/ProductVariant/2', metafields: {} }] };
  const ids = { product: 'custom.config', variant: 'custom.vconfig' };
  assert.deepEqual(customisationQuestions(product, '1', ids).map((q) => q.id), ['v1']);
  assert.equal(customisationQuestions(product, 'gid://shopify/ProductVariant/2', ids).length, 5);
  assert.deepEqual(customisationQuestions(product, '2', null), []);
});

check('a variant’s explicit empty list asks nothing; a variant with no list (or a typo) falls back to the product’s', () => {
  const ids = { product: 'custom.config', variant: 'custom.vconfig' };
  const product = (vconfig) => ({ metafields: { 'custom.config': config }, variants: [{ id: '1', metafields: vconfig === undefined ? {} : { 'custom.vconfig': vconfig } }] });
  assert.deepEqual(customisationQuestions(product(JSON.stringify({ questions: [] })), '1', ids), []);
  assert.equal(customisationQuestions(product(undefined), '1', ids).length, 5);
  assert.equal(customisationQuestions(product('{typo'), '1', ids).length, 5);
  assert.equal(customisationQuestions(product(JSON.stringify({ other: 1 })), '1', ids).length, 5);
});

check('a conditional question shows only while its condition holds; complete means every one showing is answered', () => {
  assert.deepEqual(visibleQuestions(questions, {}).map((q) => q.id), ['q1', 'q2', 'q4', 'q5']);
  assert.deepEqual(visibleQuestions(questions, { q2: 'y' }).map((q) => q.id), ['q1', 'q2', 'q3', 'q4', 'q5']);
  const base = { q1: '6.5', q2: 'n', q4: ['h'], q5: 'x' };
  assert.equal(customisationComplete(questions, base), true);
  assert.equal(customisationComplete(questions, { ...base, q2: 'y' }), false, 'the engraving text now shows, unanswered');
  assert.equal(customisationComplete(questions, { ...base, q4: [] }), false);
  assert.equal(customisationComplete(questions, { ...base, q2: 'not_selected' }), false);
});

check('saved as labels by key, several joined; no key or not showing: not saved', () => {
  assert.deepEqual(customisationAttributes(questions, { q1: '6.5', q2: 'n', q3: 'hidden', q4: ['h', 's'], q5: 'x' }), [
    { key: 'wrist_size', value: '6.5' },
    { key: 'engraving', value: 'No' },
    { key: 'charms', value: 'Heart, Star' },
  ]);
});

check('read back from a line’s attributes: labels to option ids', () => {
  const attrs = [{ key: 'wrist_size', value: '6.5' }, { key: 'engraving', value: 'Yes' }, { key: 'charms', value: 'Heart, Star' }, { key: '_wb', value: '40' }];
  assert.deepEqual(answersFromAttributes(questions, attrs), { q1: '6.5', q2: 'y', q4: ['h', 's'] });
});

check('a cart line needs answers while a question that always shows has no attribute (an _ attribute isn’t one)', () => {
  assert.equal(lineNeedsCustomisation(questions, [{ key: '_wrist_size', value: '6' }]), true);
  assert.equal(lineNeedsCustomisation(questions, [{ key: 'wrist_size', value: '6' }, { key: 'engraving', value: 'No' }, { key: 'charms', value: 'Heart' }]), false);
  assert.equal(lineNeedsCustomisation([], []), false);
});

check('no answers at all is never done, even when every question is conditional; keyless questions need nothing', () => {
  const conditionalOnly = [
    { id: 'a', key: 'engraving', type: 'choice', condition: [{ question_id: 'b', answer: ['y'] }], options: [{ id: 'y', label: 'Yes' }] },
    { id: 'b', type: 'choice', options: [{ id: 'y', label: 'Yes' }] },
  ];
  assert.equal(lineNeedsCustomisation(conditionalOnly, []), true);
  assert.equal(lineNeedsCustomisation(conditionalOnly, [{ key: '_lotNumber', value: '12' }]), true, 'an app’s own attribute isn’t an answer');
  assert.equal(lineNeedsCustomisation(conditionalOnly, [{ key: 'engraving', value: 'Yes' }]), false);
  assert.equal(lineNeedsCustomisation([{ id: 'n', type: 'text_input' }], []), false, 'nothing is ever saved for a question with no key');
});

// The customer's account copy (0.23.0): one JSON object, a variant's answers under its id, the last choices at the top.
const blob = {
  'gid://shopify/ProductVariant/77': { wrist_size: '6.5', engraving: 'Yes', charms: ['Heart', 'Star'] },
  Size: '6"',
  engraving: 'No',
  charms: ['Star'],
  odd: 3,
};

check('the account value: an object; none is empty; anything else throws, so no write replaces it', () => {
  assert.deepEqual(parseAccountCustomisations(JSON.stringify(blob)), blob);
  assert.deepEqual(parseAccountCustomisations(null), {});
  assert.deepEqual(parseAccountCustomisations(''), {});
  assert.throws(() => parseAccountCustomisations('[1]'));
  assert.throws(() => parseAccountCustomisations('{not json'));
});

check('a variant’s answers by its id (or its number); the last choices are the labels at the top, never a variant’s object', () => {
  assert.deepEqual(accountAnswersFor(blob, '77'), { wrist_size: '6.5', engraving: 'Yes', charms: ['Heart', 'Star'] });
  assert.deepEqual(accountAnswersFor(blob, 'gid://shopify/ProductVariant/77'), accountAnswersFor(blob, '77'));
  assert.deepEqual(accountAnswersFor(blob, '88'), {});
  assert.deepEqual(accountPreferences(blob), { Size: '6"', engraving: 'No', charms: ['Star'] });
});

check('saved labels read back as answers: a list for several, labels to option ids', () => {
  assert.deepEqual(answersFromAttributes(questions, accountAnswersFor(blob, '77')), { q1: '6.5', q2: 'y', q4: ['h', 's'] });
  assert.deepEqual(answersFromAttributes(questions, accountPreferences(blob)), { q2: 'n', q4: ['s'] });
});

check('answers as the account keeps them: labels by key, a list for multi_select, only what shows', () => {
  assert.deepEqual(customisationLabels(questions, { q1: '6.5', q2: 'n', q3: 'hidden', q4: ['h', 's'], q5: 'x' }), {
    wrist_size: '6.5', engraving: 'No', charms: ['Heart', 'Star'],
  });
});

check('a save: the variant’s answers under its id, its choices as the last choices; free text stays with the variant; the rest kept', () => {
  const next = withSavedCustomisation(blob, '88', questions, { q1: '7', q2: 'y', q3: 'AM', q4: [] });
  assert.deepEqual(next['gid://shopify/ProductVariant/88'], { wrist_size: '7', engraving: 'Yes', engraving_text: 'AM' });
  assert.equal(next.engraving, 'Yes');
  assert.equal('wrist_size' in next, false, 'free text (a size typed in) isn’t a last choice');
  assert.equal('engraving_text' in next, false, 'an engraving never prefills another product');
  assert.deepEqual(next.charms, ['Star'], 'an empty answer doesn’t clear the last choice');
  assert.deepEqual(next['gid://shopify/ProductVariant/77'], blob['gid://shopify/ProductVariant/77']);
  assert.deepEqual(withPreferences(blob, { Size: '7"', Color: '' }), { ...blob, Size: '7"' });
});

check('a save keeps what the website keeps under the variant, and drops a hidden question’s old answer', () => {
  const before = { 'gid://shopify/ProductVariant/77': { engraving_text: 'OLD', gift_note: 'Happy birthday', wrapped: true } };
  const next = withSavedCustomisation(before, '77', questions, { q1: '7', q2: 'n', q3: 'stale' });
  assert.deepEqual(next['gid://shopify/ProductVariant/77'], { gift_note: 'Happy birthday', wrapped: true, wrist_size: '7', engraving: 'No' });
});

check('the last choices prefill choice questions only, never free text', () => {
  assert.deepEqual(lastChoicesAsAnswers(questions, { wrist_size: '6.5', engraving: 'No', charms: ['Star'] }), { q2: 'n', q4: ['s'] });
});

console.log(`\n${pass} checks passed`);
