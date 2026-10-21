// Product customisation (0.22.0): the questions from a metafield, which show, when they're answered, and the
// answers to and from cart line attributes.
import assert from 'node:assert/strict';

const {
  parseCustomisation, customisationQuestions, visibleQuestions, customisationComplete,
  customisationAttributes, answersFromAttributes, lineNeedsCustomisation,
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

console.log(`\n${pass} checks passed`);
