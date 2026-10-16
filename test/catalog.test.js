import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleCategorySlugs, visibleNavigationCategories, categoryTreeError } from '../src/catalog.js';
import { cleanSettings } from '../src/settings.js';
test('hidden ancestors and cycles never publish descendant products', () => {
  const categories = [{ slug: 'men', status: 'hidden' }, { slug: 'shirts', parent: 'men', status: 'published' }, { slug: 'fragrance', status: 'published' }, { slug: 'a', parent: 'b', status: 'published' }, { slug: 'b', parent: 'a', status: 'published' }];
  assert.deepEqual(visibleCategorySlugs(categories), ['fragrance']);
  assert.match(categoryTreeError(categories, categories[3]), /ancestor/);
  assert.deepEqual(visibleNavigationCategories(categories, [{ category: 'shirts' }]), []);
});
test('category navigation includes populated ancestors and intentional coming-soon categories', () => {
  const categories = [{ slug: 'men', status: 'published', order: 0 }, { slug: 'shirts', parent: 'men', status: 'published', order: 1 }, { slug: 'gifts', status: 'coming-soon', order: 2 }, { slug: 'empty', status: 'published', order: 3 }];
  assert.deepEqual(visibleNavigationCategories(categories, [{ category: 'shirts' }]).map(c => c.slug), ['men', 'shirts', 'gifts']);
});
test('store controls reject unsupported integrations and invalid shipping amounts', () => {
  assert.throws(() => cleanSettings({ prepaidEnabled: true }), /implementation/);
  assert.throws(() => cleanSettings({ shippingFee: -1 }), /non-negative/);
  assert.throws(() => cleanSettings({ checkoutEnabled: 'true' }), /true or false/);
  assert.throws(() => cleanSettings({ supportEmail: 'invalid' }), /valid support/);
  assert.equal(cleanSettings({ newsletterEnabled: false }).newsletterEnabled, false);
});
