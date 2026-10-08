// A link's `ref` and `utm…` tags (0.11.0): reading them off a link, how long they count, and how they
// replace a cart's older tags. Pure; the provider's half is test/link-tags-provider.test.mjs.
import assert from 'node:assert/strict';

const {
  LINK_TAG_MAX_COUNT,
  LINK_TAG_MAX_LENGTH,
  cartHasLinkTags,
  isLinkTagKey,
  linkTagsFrom,
  liveLinkTags,
  readSavedLinkTags,
  withLinkTags,
} = await import('../dist/index.js');

let pass = 0;
const check = (label, fn) => { fn(); pass++; console.log('  ✓', label); };
const DAY = 24 * 60 * 60 * 1000;

console.log('reading a link');
check("the influencer link: ref and every utm_, nothing else", () => {
  assert.deepEqual(
    linkTagsFrom('https://sparklbands.com/collections/new-drops?ref=brandi10&utm_source=instagram&utm_medium=influencer&utm_campaign=fall_drop'),
    { ref: 'brandi10', utm_source: 'instagram', utm_medium: 'influencer', utm_campaign: 'fall_drop' },
  );
});
check('any name starting with utm or ref, in any case; ad click ids and product params are not tags', () => {
  assert.deepEqual(
    linkTagsFrom('https://shop.test/products/x?UTM_Source=IG&referrer=blog&ref_code=AB1&fbclid=1&gclid=2&variant=3&utmost=y'),
    { UTM_Source: 'IG', referrer: 'blog', ref_code: 'AB1', utmost: 'y' },
  );
  assert.equal(isLinkTagKey('Ref'), true);
  assert.equal(isLinkTagKey('_ref'), false);
  assert.equal(isLinkTagKey('source_name'), false);
});
check('decoded as the link meant them: %20 and + are spaces, a stray % is kept', () => {
  assert.deepEqual(linkTagsFrom('https://s.test/?utm_campaign=fall%20drop&utm_term=a+b&ref=%E2%9C%A8&utm_content=100%'), {
    utm_campaign: 'fall drop', utm_term: 'a b', ref: '✨', utm_content: '100%',
  });
});
check('a custom scheme reads the same as https; the fragment is not the query', () => {
  assert.deepEqual(linkTagsFrom('amorefashion://collections/tops?ref=a#utm_source=b'), { ref: 'a' });
});
check('no tags, empty tags, no query or no link: null', () => {
  assert.equal(linkTagsFrom('https://s.test/collections/tops'), null);
  assert.equal(linkTagsFrom('https://s.test/?ref=&utm_source=%20&variant=1'), null);
  assert.equal(linkTagsFrom(''), null);
  assert.equal(linkTagsFrom(null), null);
  assert.equal(linkTagsFrom(undefined), null);
});
check('a name given twice keeps its last value', () => {
  assert.deepEqual(linkTagsFrom('https://s.test/?ref=a&ref=b'), { ref: 'b' });
});
check(`at most ${LINK_TAG_MAX_COUNT} tags, each value at most ${LINK_TAG_MAX_LENGTH} characters`, () => {
  const many = Array.from({ length: 25 }, (_, i) => `utm_${i}=v${i}`).join('&');
  assert.equal(Object.keys(linkTagsFrom(`https://s.test/?${many}`)).length, LINK_TAG_MAX_COUNT);
  assert.equal(linkTagsFrom(`https://s.test/?ref=${'x'.repeat(300)}`).ref.length, LINK_TAG_MAX_LENGTH);
});

console.log('how long they count');
const saved = { savedAt: 1_000 * DAY, tags: { ref: 'a' } };
check('within keepDays: the tags; at keepDays or after: null', () => {
  assert.deepEqual(liveLinkTags(saved, 7, saved.savedAt + 7 * DAY - 1), { ref: 'a' });
  assert.equal(liveLinkTags(saved, 7, saved.savedAt + 7 * DAY), null);
  assert.equal(liveLinkTags(saved, 10, saved.savedAt + 9 * DAY), saved.tags, 'a longer setting counts from the same save');
});
check('keepDays 0, below 0 or not a number is off; nothing saved is null', () => {
  assert.equal(liveLinkTags(saved, 0, saved.savedAt), null);
  assert.equal(liveLinkTags(saved, -1, saved.savedAt), null);
  assert.equal(liveLinkTags(saved, Number.NaN, saved.savedAt), null);
  assert.equal(liveLinkTags(null, 7, saved.savedAt), null);
});
check('the saved record reads back; anything else is null, and only tag names are kept', () => {
  assert.deepEqual(readSavedLinkTags(JSON.stringify(saved)), saved);
  assert.deepEqual(readSavedLinkTags(JSON.stringify({ savedAt: 5, tags: { ref: 'a', other: 'b', utm_x: 3 } })), { savedAt: 5, tags: { ref: 'a' } });
  assert.equal(readSavedLinkTags('not json'), null);
  assert.equal(readSavedLinkTags(JSON.stringify({ savedAt: 'x', tags: { ref: 'a' } })), null);
  assert.equal(readSavedLinkTags(JSON.stringify({ savedAt: 5, tags: [] })), null);
  assert.equal(readSavedLinkTags(JSON.stringify({ savedAt: 5, tags: { other: 'b' } })), null);
  assert.equal(readSavedLinkTags(null), null);
});

console.log('on the cart: the last link wins');
const cart = [
  { key: 'source_name', value: 'app' },
  { key: 'ref', value: 'old' },
  { key: 'utm_content', value: 'old-post' },
  { key: '_apptile_attribution', value: '{}' },
];
check("a newer link's tags replace every older tag; every other attribute stays, in order", () => {
  assert.deepEqual(withLinkTags(cart, { ref: 'new', utm_source: 'tiktok' }), [
    { key: 'source_name', value: 'app' },
    { key: '_apptile_attribution', value: '{}' },
    { key: 'ref', value: 'new' },
    { key: 'utm_source', value: 'tiktok' },
  ]);
});
check('the cart has the tags only when its tags are exactly them', () => {
  assert.equal(cartHasLinkTags(cart, { ref: 'old', utm_content: 'old-post' }), true);
  assert.equal(cartHasLinkTags(cart, { ref: 'old' }), false, 'an older extra tag still on the cart');
  assert.equal(cartHasLinkTags(cart, { ref: 'new', utm_content: 'old-post' }), false);
  assert.equal(cartHasLinkTags([{ key: 'source_name', value: 'app' }], { ref: 'a' }), false);
});

console.log(`\n${pass} checks passed`);
