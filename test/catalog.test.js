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
  assert.throws(() => cleanSettings({ prepaidEnabled: true }), /Safepay/);
  assert.throws(() => cleanSettings({ customizerEnabled: true }), /implementation/);
  assert.throws(() => cleanSettings({ shippingFee: -1 }), /non-negative/);
  assert.throws(() => cleanSettings({ checkoutEnabled: 'true' }), /true or false/);
  assert.throws(() => cleanSettings({ supportEmail: 'invalid' }), /valid support/);
});
test('online payments enable only when Safepay is configured, and force off when its keys are absent', () => {
  const saved = { ...process.env };
  process.env.SAFEPAY_API_KEY = 'sec_test'; process.env.SAFEPAY_V1_SECRET = 'v1'; process.env.SAFEPAY_WEBHOOK_SECRET = 'wh';
  try { assert.equal(cleanSettings({ prepaidEnabled: true }).prepaidEnabled, true); }
  finally { for (const k of ['SAFEPAY_API_KEY', 'SAFEPAY_V1_SECRET', 'SAFEPAY_WEBHOOK_SECRET']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
  // A value stored while configured is silently forced back off once the keys are gone.
  assert.equal(cleanSettings({}, { ...cleanSettings({}), prepaidEnabled: true }).prepaidEnabled, false);
});
