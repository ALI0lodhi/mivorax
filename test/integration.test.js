import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import sharp from 'sharp';
import {existsSync,readFileSync} from 'node:fs';
const maintenanceFile=new URL('../.security/database-admin.json',import.meta.url);
const testUri=process.env.MONGODB_TEST_URI||(process.env.MONGODB_URI?.includes('@127.0.0.1:27018/')&&existsSync(maintenanceFile)?JSON.parse(readFileSync(maintenanceFile,'utf8')).adminUri:process.env.MONGODB_URI);
import { createApp } from '../src/app.js';
import { seedDatabase } from '../src/initialize.js';
import { Product, Category, Collection, Site, Order, Coupon, Review } from '../src/models.js';

test('MongoDB-backed administration, publishing, media and order lifecycle', { skip: !testUri, timeout: 90000 }, async t => {
  const database = 'mivorax_integration_' + crypto.randomBytes(8).toString('hex');
  await mongoose.connect(testUri, { dbName: database, serverSelectionTimeoutMS: 5000 });
  const email = 'integration@example.test', password = crypto.randomBytes(24).toString('hex');
  let server, token;
  try {
    await seedDatabase({ email, password });
    server = createApp({ secret: crypto.randomBytes(48).toString('hex') }).listen(0, '127.0.0.1');
    await new Promise(resolve => server.on('listening', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    async function request(path, { method = 'GET', data, auth = true, headers = {} } = {}) {
      const response = await fetch(origin + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(path==='/orders'&&method==='POST'?{'Idempotency-Key':crypto.randomUUID()}:{}), ...(auth && token ? { Authorization: 'Bearer ' + token } : {}), ...headers }, body: data === undefined ? undefined : JSON.stringify(data) });
      return { status: response.status, body: await response.json() };
    }
    await t.test('seed is idempotent and public catalog uses actual MongoDB IDs', async () => {
      const before = await Product.countDocuments();
      await seedDatabase({ email, password }); // seeding twice must not duplicate the sample catalog
      assert.equal(await Product.countDocuments(), before);
      const products = await request('/products');
      assert(products.body.length > 0 && products.body.every(p => mongoose.isValidObjectId(p._id)));
      assert.equal((await request('/health')).body.transactions, true);
    });
    await t.test('admin authentication and origin allowlist are enforced', async () => {
      assert.equal((await request('/admin/dashboard', { auth: false })).status, 401);
      assert.equal((await request('/products', { headers: { Origin: 'https://unapproved.example' } })).status, 403);
      const login = await request('/admin/login', { method: 'POST', data: { email, password } });
      assert.equal(login.status, 200); token = login.body.token;
      const dashboard = await request('/admin/dashboard');
      assert.equal(dashboard.body.counts.products, 4);
      const punctuation = await request('/admin/products?q=' + encodeURIComponent('['));
      assert.equal(punctuation.status, 200);
      assert.equal(punctuation.body.total, 0);
      assert.equal((await request('/admin/products?q=' + encodeURIComponent('*'))).body.total, 0);
    });
    let category, child, product, collection, coupon;
    await t.test('guided CRUD supports category trees and rejects cycles and missing references', async () => {
      const parentResult = await request('/admin/categories', { method: 'POST', data: { name: 'Test parent', slug: 'test-parent', status: 'published' } });
      assert.equal(parentResult.status, 201, JSON.stringify(parentResult.body)); category = parentResult.body;
      const childResult = await request('/admin/categories', { method: 'POST', data: { name: 'Test child', slug: 'test-child', parent: category.slug, status: 'published' } });
      assert.equal(childResult.status, 201, JSON.stringify(childResult.body)); child = childResult.body;
      assert.equal((await request('/admin/categories/' + category._id, { method: 'PUT', data: { ...category, parent: child.slug, _version: category.__v } })).status, 400);
      assert.equal((await request('/admin/products', { method: 'POST', data: { name: 'Bad', slug: 'bad-product', category: 'missing', price: 100 } })).status, 400);
      const result = await request('/admin/products', { method: 'POST', data: { name: 'Integration fragrance', slug: 'integration-fragrance', category: child.slug, price: 600, salePrice: 500, stock: 2, status: 'published', demo: false, images: [] } });
      assert.equal(result.status, 201, JSON.stringify(result.body)); product = result.body;
      collection = (await request('/admin/collections', { method: 'POST', data: { name: 'Integration collection', slug: 'integration-collection', status: 'published', productIds: [product._id] } })).body;
      const store = await request('/store');
      assert(store.body.categories.some(c => c.slug === category.slug));
      assert(store.body.collections.some(c => c.slug === collection.slug));
    });
    await t.test('hidden ancestors, archival and restoration propagate to public APIs', async () => {
      category = (await request('/admin/categories/' + category._id, { method: 'PUT', data: { ...category, status: 'hidden', _version: category.__v } })).body;
      assert(!(await request('/products')).body.some(p => p._id === product._id));
      assert(!(await request('/store')).body.collections.some(c => c.slug === collection.slug));
      category = (await request('/admin/categories/' + category._id, { method: 'PUT', data: { ...category, status: 'published', _version: category.__v } })).body;
      await request('/admin/products/' + product._id + '/archive', { method: 'POST', data: {} });
      assert(!(await request('/products')).body.some(p => p._id === product._id));
      await request('/admin/products/' + product._id + '/archive', { method: 'POST', data: { restore: true } });
      assert((await request('/products')).body.some(p => p._id === product._id));
    });
    await t.test('homepage, menu and policy edits persist with stale-write and unsafe-URL protection', async () => {
      const site = (await request('/admin/dashboard')).body.site;
      site.sections[0].title = 'Database-driven heading';
      site.navigation.push({ label: 'New policy', href: '/pages/integration-policy', enabled: true });
      const siteSave = await request('/admin/site', { method: 'PUT', data: { ...site, _version: site.__v } });
      assert.equal(siteSave.status, 200, JSON.stringify(siteSave.body));
      assert.equal((await request('/store')).body.site.sections[0].title, 'Database-driven heading');
      assert.equal((await request('/admin/site', { method: 'PUT', data: { ...site, _version: site.__v } })).status, 409);
      const current = (await request('/admin/dashboard')).body.site;
      current.navigation.push({ label: 'Unsafe', href: 'javascript:alert(1)', enabled: true });
      assert.equal((await request('/admin/site', { method: 'PUT', data: { ...current, _version: current.__v } })).status, 400);
      const page = await request('/admin/pages', { method: 'POST', data: { slug: 'integration-policy', title: 'Integration policy', blocks: [{ heading: 'Details', text: 'Persisted policy text.' }], status: 'published' } });
      assert.equal(page.status, 201);
      assert((await request('/store')).body.pages.some(p => p.slug === page.body.slug));
      const future = await request('/admin/posts', { method: 'POST', data: { title: 'Scheduled article', slug: 'scheduled-article', publishedAt: '2099-01-01', status: 'published', body: [] } });
      assert.equal(future.status, 201);
      assert(!(await request('/posts')).body.some(p => p.slug === 'scheduled-article'));
    });
    await t.test('homepage visibility saves despite unchanged archived references and rejects new unavailable selections', async () => {
      let site = (await request('/admin/dashboard')).body.site;
      const hero = site.sections.find(section => section.type === 'hero');
      const featured = site.sections.find(section => section.type === 'products');
      featured.collectionSlug = collection.slug;
      assert.equal((await request('/admin/site', { method: 'PUT', data: { ...site, _version: site.__v } })).status, 200);
      await request('/admin/products/' + hero.productId + '/archive', { method: 'POST', data: {} });
      await request('/admin/collections/' + collection._id + '/archive', { method: 'POST', data: {} });
      site = (await request('/admin/dashboard')).body.site;
      site.sections.find(section => section.type === 'journal').enabled = false;
      const hidden = await request('/admin/site', { method: 'PUT', data: { ...site, _version: site.__v } });
      assert.equal(hidden.status, 200, JSON.stringify(hidden.body));
      assert.equal(hidden.body.sections.find(section => section.type === 'hero').productId, hero.productId);
      assert(!(await request('/store')).body.site.sections.some(section => section.type === 'journal'));
      site = (await request('/admin/dashboard')).body.site;
      assert.equal(site.sections.find(section => section.type === 'journal').enabled, false);
      site.sections.find(section => section.type === 'journal').enabled = true;
      assert.equal((await request('/admin/site', { method: 'PUT', data: { ...site, _version: site.__v } })).status, 200);
      assert((await request('/store')).body.site.sections.some(section => section.type === 'journal'));
      site = (await request('/admin/dashboard')).body.site;
      site.sections.find(section => section.type === 'hero').productId = String(new mongoose.Types.ObjectId());
      assert.equal((await request('/admin/site', { method: 'PUT', data: { ...site, _version: site.__v } })).status, 400);
      site = (await request('/admin/dashboard')).body.site;
      site.sections.find(section => section.type === 'products').collectionSlug = 'missing-collection';
      assert.equal((await request('/admin/site', { method: 'PUT', data: { ...site, _version: site.__v } })).status, 400);
      await request('/admin/products/' + hero.productId + '/archive', { method: 'POST', data: { restore: true } });
      await request('/admin/collections/' + collection._id + '/archive', { method: 'POST', data: { restore: true } });
    });
    await t.test('GridFS upload, library metadata and public image streaming work', async () => {
      const png = await sharp({create:{width:2,height:2,channels:3,background:'#ffffff'}}).png().toBuffer();
      const form = new FormData(); form.append('image', new Blob([png], { type: 'image/png' }), 'integration.png');
      const response = await fetch(origin + '/api/admin/images', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: form });
      assert.equal(response.status, 201); const image = await response.json();
      const downloaded = await fetch(origin + image.url); assert.equal(downloaded.headers.get('content-type'), 'image/png');
      assert.equal((await sharp(Buffer.from(await downloaded.arrayBuffer())).metadata()).format,'png');
      assert.equal((await request('/admin/images/' + image._id, { method: 'PUT', data: { alt: 'Integration pixel' } })).status, 200);
      assert((await request('/admin/images')).body.items.some(i => i.metadata.alt === 'Integration pixel'));
      assert.equal((await request('/admin/images/' + image._id + '/archive', { method: 'POST', data: {} })).status, 200);
      assert(!(await request('/admin/images')).body.items.some(i => i._id === image._id));
      assert((await request('/admin/images?archived=true')).body.items.some(i => i._id === image._id));
      assert.equal((await fetch(origin + image.url)).status, 200);
      await request('/admin/images/' + image._id + '/archive', { method: 'POST', data: { restore: true } });
      const bad = new FormData(); bad.append('image', new Blob(['not an image']), 'bad.png');
      assert.equal((await fetch(origin + '/api/admin/images', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: bad })).status, 400);
    });
    await t.test('journal feature control hides scheduled content and posts from the public API', async () => {
      await request('/admin/settings', { method: 'PUT', data: { journalEnabled: false } });
      assert.deepEqual((await request('/posts')).body, []);
      assert(!(await request('/store')).body.site.sections.some(s => s.type === 'journal'));
      await request('/admin/settings', { method: 'PUT', data: { journalEnabled: true } });
    });
    await t.test('online payments require Safepay keys before they can be switched on', async () => {
      // Clear any Safepay env (a local .env may set mock mode) so this asserts the unconfigured state.
      for (const k of ['SAFEPAY_ENV', 'SAFEPAY_API_KEY', 'SAFEPAY_V1_SECRET', 'SAFEPAY_WEBHOOK_SECRET']) delete process.env[k];
      assert.equal((await request('/admin/settings', { method: 'PUT', data: { prepaidEnabled: true } })).status, 400);
      assert.equal((await request('/store')).body.settings.prepaidEnabled, false);
    });
    await t.test('Safepay order stays pending until a verified webhook confirms payment and deducts stock', async () => {
      const realFetch = globalThis.fetch;
      const sfpyEnv = { SAFEPAY_ENV: 'sandbox', SAFEPAY_API_KEY: 'sec_test', SAFEPAY_V1_SECRET: 'v1_test_secret', SAFEPAY_WEBHOOK_SECRET: 'wh_test_secret' };
      Object.assign(process.env, sfpyEnv);
      let initCalls = 0;
      // Simulate Safepay's /order/v1/init without any real network call or keys.
      const json = body => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      globalThis.fetch = (url, opts) => {
        if (String(url).includes('/order/payments/v3/')) { initCalls++; return json({ data: { tracker: { token: 'trk_' + crypto.randomBytes(6).toString('hex'), state: 'TRACKER_STARTED' } } }); }
        if (String(url).includes('/client/passport/v1/token')) return json({ data: 'tbt_test_token' });
        return realFetch(url, opts);
      };
      try {
        assert.equal((await request('/admin/settings', { method: 'PUT', data: { checkoutEnabled: true, supportEmail: 'support@example.test', prepaidEnabled: true } })).status, 200);
        assert.equal((await request('/store')).body.settings.prepaidEnabled, true);
        const stockBefore = (await Product.findById(product._id)).stock;
        const payload = { customer: { name: 'Online buyer', email: 'online@example.test', phone: '03007654321', address: 'Card street', city: 'Karachi', country: 'Pakistan' }, paymentMethod: 'safepay', items: [{ productId: product._id, quantity: 1 }] };
        const placed = await request('/orders', { method: 'POST', data: payload });
        assert.equal(placed.status, 201, JSON.stringify(placed.body));
        assert.equal(placed.body.status, 'pending_payment');
        assert.equal(placed.body.paymentStatus, 'unpaid');
        assert(typeof placed.body.checkoutUrl === 'string' && placed.body.checkoutUrl.includes('/embedded/?'), placed.body.checkoutUrl);
        assert.equal(initCalls, 1);
        assert.equal((await Product.findById(product._id)).stock, stockBefore); // unpaid orders never reserve stock
        const order = await Order.findOne({ reference: placed.body.reference }).select('+safepayToken').lean();
        assert(order.safepayToken && order.safepayToken.startsWith('trk_'));
        assert.equal(order.unseen, false); // an unpaid online order is not a new order yet
        assert.equal(order.unseen, false); // an unpaid online order is not a new order yet
        const paid = { type: 'payment:succeeded', data: { tracker: order.safepayToken, state: 'TRACKER_ENDED', amount: order.total * 100 } };
        const body = JSON.stringify(paid);
        const sig = crypto.createHmac('sha512', sfpyEnv.SAFEPAY_WEBHOOK_SECRET).update(Buffer.from(JSON.stringify(paid.data))).digest('hex');
        const sendHook = headers => fetch(origin + '/api/payments/safepay/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
        assert.equal((await sendHook({ 'x-sfpy-signature': 'deadbeef' })).status, 401); // forged signature rejected
        assert.equal((await Order.findById(order._id)).paymentStatus, 'unpaid');
        assert.equal((await sendHook({ 'x-sfpy-signature': sig })).status, 200); // genuine webhook accepted
        const afterPaid = await Order.findById(order._id);
        assert.equal(afterPaid.paymentStatus, 'paid');
        assert.equal(afterPaid.status, 'confirmed');
        assert.equal(afterPaid.unseen, true); // paying makes it a new order
        assert.equal(afterPaid.unseen, true); // paying makes it a new order
        assert.equal((await Product.findById(product._id)).stock, stockBefore - 1); // stock deducted on payment
        assert.equal((await sendHook({ 'x-sfpy-signature': sig })).status, 200); // replay is idempotent
        assert.equal((await Product.findById(product._id)).stock, stockBefore - 1); // no double deduction
        const reload = await Order.findById(order._id).lean();
        assert.equal((await request('/admin/orders/' + order._id, { method: 'PUT', data: { _version: reload.__v, status: 'cancelled' } })).status, 200);
        assert.equal((await Product.findById(product._id)).stock, stockBefore); // paid order cancel restores stock
        const abandoned = await request('/orders', { method: 'POST', data: payload });
        assert.equal(abandoned.body.status, 'pending_payment');
        const ab = await Order.findOne({ reference: abandoned.body.reference }).lean();
        assert.equal((await request('/admin/orders/' + ab._id, { method: 'PUT', data: { _version: ab.__v, status: 'cancelled' } })).status, 200);
        assert.equal((await Product.findById(product._id)).stock, stockBefore); // never-paid order does NOT restock
        for (const k of Object.keys(sfpyEnv)) delete process.env[k];
        assert.equal((await request('/store')).body.settings.prepaidEnabled, false); // keys gone → forced off
        assert.equal((await request('/orders', { method: 'POST', data: payload })).status, 400); // and refused
      } finally {
        globalThis.fetch = realFetch;
        for (const k of Object.keys(sfpyEnv)) delete process.env[k];
      }
    });
    await t.test('mock payment mode clicks through to a paid order with no gateway keys', async () => {
      process.env.SAFEPAY_ENV = 'mock';
      try {
        assert.equal((await request('/admin/settings', { method: 'PUT', data: { checkoutEnabled: true, supportEmail: 'support@example.test', prepaidEnabled: true } })).status, 200);
        const stockBefore = (await Product.findById(product._id)).stock;
        const payload = { customer: { name: 'Demo buyer', email: 'demo@example.test', phone: '03001112222', address: 'Demo street', city: 'Lahore', country: 'Pakistan' }, paymentMethod: 'safepay', items: [{ productId: product._id, quantity: 1 }] };
        const placed = await request('/orders', { method: 'POST', data: payload });
        assert.equal(placed.status, 201, JSON.stringify(placed.body));
        assert(placed.body.checkoutUrl.includes('/api/payments/safepay/mock?'), placed.body.checkoutUrl);
        const mockPage = await fetch(origin + placed.body.checkoutUrl.slice(placed.body.checkoutUrl.indexOf('/api')));
        assert.equal(mockPage.status, 200);
        assert((await mockPage.text()).toLowerCase().includes('simulated'));
        const order = await Order.findOne({ reference: placed.body.reference }).select('+safepayToken').lean();
        const pay = await fetch(origin + '/api/payments/safepay/mock/pay?order=' + order.reference + '&token=' + order.safepayToken, { redirect: 'manual' });
        assert([301, 302, 303, 307, 308].includes(pay.status));
        assert.equal((await Order.findById(order._id)).paymentStatus, 'paid');
        assert.equal((await Product.findById(product._id)).stock, stockBefore - 1);
      } finally {
        delete process.env.SAFEPAY_ENV;
        const cancel = await Order.findOne({ 'customer.email': 'demo@example.test', paymentStatus: 'paid' }).lean();
        if (cancel) await request('/admin/orders/' + cancel._id, { method: 'PUT', data: { _version: cancel.__v, status: 'cancelled' } });
      }
    });
    await t.test('checkout uses database prices and enforces single-use coupons under concurrency', async () => {
      assert.equal((await request('/admin/settings', { method: 'PUT', data: { checkoutEnabled: true, supportEmail: 'support@example.test' } })).status, 200);
      coupon = (await request('/admin/coupons', { method: 'POST', data: { code: 'ONE-USE', kind: 'percentage', amount: 10, minOrder: 0, usageLimit: 1, enabled: true } })).body;
      const payload = { customer: { name: 'Integration customer', email: 'buyer@example.test', phone: '03001234567', address: 'Test address', city: 'Lahore', country: 'Pakistan' }, paymentMethod: 'cod', items: [{ productId: product._id, quantity: 1, unitPrice: 1 }], coupon: coupon.code, total: 1 };
      const results = await Promise.all([request('/orders', { method: 'POST', data: payload }), request('/orders', { method: 'POST', data: payload })]);
      assert.equal(results.filter(r => r.status === 201).length, 1, JSON.stringify(results));
      const placed = results.find(r => r.status === 201).body;
      assert.equal(placed.total, 700);
      assert.equal((await Product.findById(product._id)).stock, 1);
      assert.equal((await Coupon.findById(coupon._id)).used, 1);
      const tracking = await request('/orders/track', { method: 'POST', data: { reference: placed.reference, token: placed.token } });
      assert.equal(tracking.status, 200); assert(!tracking.body.customer);
      assert.deepEqual([tracking.body.subtotal, tracking.body.shipping, tracking.body.discount, tracking.body.coupon, tracking.body.items[0].unitPrice], [500, 250, 50, 'ONE-USE', 500]); // enough for a receipt, without personal details
      assert.equal((await request('/orders/track', { method: 'POST', data: { reference: placed.reference, token: 'wrong' } })).status, 404);
      let order = await Order.findOne({ reference: placed.reference }).lean();
      assert.equal((await request('/admin/orders/' + order._id, { method: 'PUT', data: { _version: order.__v, status: 'cancelled' } })).status, 200);
      assert.equal((await Product.findById(product._id)).stock, 2);
      assert.equal((await Coupon.findById(coupon._id)).used, 0);
      assert.equal((await request('/admin/orders/' + order._id, { method: 'PUT', data: { _version: order.__v, status: 'cancelled' } })).status, 409);
      assert.equal((await Product.findById(product._id)).stock, 2);
      assert.equal((await request('/admin/customers')).body.items[0].spent, 0);
      // Ordering a product that is not in the live catalog is rejected.
      assert.equal((await request('/orders', { method: 'POST', data: { ...payload, coupon: '', items: [{ productId: String(new mongoose.Types.ObjectId()), quantity: 1 }] } })).status, 400);
    });
    await t.test('deleting a record removes whatever pointed at it instead of being blocked', async () => {
      const make = async (path, data) => { const r = await request(path, { method: 'POST', data }); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body; };
      const parent = await make('/admin/categories', { name: 'Del parent', slug: 'del-parent', status: 'published' });
      const kid = await make('/admin/categories', { name: 'Del kid', slug: 'del-kid', parent: 'del-parent', status: 'published' });
      const item = await make('/admin/products', { name: 'Del item', slug: 'del-item', category: 'del-kid', price: 100, stock: 1, status: 'published', images: [] });
      const group = await make('/admin/collections', { name: 'Del group', slug: 'del-group', status: 'published', productIds: [item._id] });
      await Review.create({ productId: item._id, author: 'Zed', text: 'Nice item here.', rating: 5, status: 'published' });
      const site = (await request('/admin/dashboard')).body.site;
      site.navigation.push({ label: 'Kid link', href: '/shop?category=del-kid', enabled: true, category: 'del-kid' });
      site.sections.find(s => s.type === 'hero').productId = item._id;
      site.sections.find(s => s.type === 'products').categorySlug = 'del-kid';
      assert.equal((await request('/admin/site', { method: 'PUT', data: { ...site, _version: site.__v } })).status, 200);

      // The admin is told what will happen before confirming.
      assert.deepEqual((await request('/admin/delete-impact/categories/' + kid._id)).body.lines, ['1 product will move to “Del parent”', 'removed from 1 homepage section', '1 menu link will be removed']);
      const productImpact = (await request('/admin/delete-impact/products/' + item._id)).body;
      assert.deepEqual(productImpact.lines, ['removed from 1 collection', 'removed from 1 homepage section', '1 review of this product will be deleted']);

      // A category in use can be deleted: its product moves up, and the menu link and homepage section are cleaned.
      assert.equal((await request('/admin/categories/' + kid._id, { method: 'DELETE' })).status, 200);
      assert.equal((await Product.findById(item._id)).category, 'del-parent');
      const afterCategory = await Site.findOne({ key: 'website' }).lean();
      assert(!afterCategory.navigation.some(l => l.category === 'del-kid'));
      assert.equal(afterCategory.sections.find(s => s.type === 'products').categorySlug, '');

      // A product in a collection, on the homepage and with reviews can be deleted too.
      assert.equal((await request('/admin/products/' + item._id, { method: 'DELETE' })).status, 200);
      assert.deepEqual((await Collection.findById(group._id)).productIds, []);
      assert(!(await Site.findOne({ key: 'website' }).lean()).sections.find(s => s.type === 'hero').productId);
      assert.equal(await Review.countDocuments({ author: 'Zed' }), 0);

      // With no parent category to move into, the products are archived rather than lost.
      const solo = await make('/admin/categories', { name: 'Del solo', slug: 'del-solo', status: 'published' });
      const other = await make('/admin/products', { name: 'Del other', slug: 'del-other', category: 'del-solo', price: 100, stock: 1, status: 'published', images: [] });
      assert.equal((await request('/admin/categories/' + solo._id, { method: 'DELETE' })).status, 200);
      assert((await Product.findById(other._id)).archivedAt);

      for (const [path, record] of [['products', other], ['collections', group], ['categories', parent]]) assert.equal((await request('/admin/' + path + '/' + record._id, { method: 'DELETE' })).status, 200);
    });
    await t.test('new orders are counted until the admin has seen them', async () => {
      const newOrders = async () => (await request('/admin/badges')).body.newOrders;
      const place = async () => { const placed = await request('/orders', { method: 'POST', data: { customer: { name: 'Badge Buyer', email: 'badge@example.test', phone: '03001234567', address: 'House 1', city: 'Karachi', country: 'Pakistan' }, paymentMethod: 'cod', items: [{ productId: product._id, quantity: 1 }] } }); assert.equal(placed.status, 201, JSON.stringify(placed.body)); return Order.findOne({ reference: placed.body.reference }).lean(); };
      const cancel = async id => { const o = await Order.findById(id).lean(); assert.equal((await request('/admin/orders/' + id, { method: 'PUT', data: { _version: o.__v, status: 'cancelled' } })).status, 200); };
      await request('/admin/orders/seen-all', { method: 'POST', data: {} });
      assert.equal(await newOrders(), 0);

      const first = await place();
      assert.equal(first.unseen, true);
      assert.equal(await newOrders(), 1);
      assert.equal((await request('/admin/dashboard')).body.newOrders, 1);

      // Opening an order clears it, without changing its version (an open order form can still be saved).
      assert.equal((await request('/admin/orders/' + first._id + '/seen', { method: 'POST', data: {} })).status, 200);
      assert.equal(await newOrders(), 0);
      assert.equal((await Order.findById(first._id)).__v, first.__v);
      assert.equal((await request('/admin/orders/' + first._id + '/seen', { method: 'POST', data: {} })).status, 200); // harmless to repeat
      await cancel(first._id); // gives the stock back so two more orders fit

      const second = await place(), third = await place();
      assert.equal(await newOrders(), 2);
      assert.equal((await request('/admin/orders/seen-all', { method: 'POST', data: {} })).body.cleared, 2);
      assert.equal(await newOrders(), 0);
      for (const order of [second, third]) await cancel(order._id);
    });
    await t.test('one-click PostEx booking sends the customer details, saves the tracking number and cannot double-book', async () => {
      const realFetch = globalThis.fetch;
      const sent = [];
      const json = body => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      globalThis.fetch = (url, opts) => {
        const u = String(url);
        if (u.includes('/v2/get-operational-city')) return json({ statusCode: '200', statusMessage: 'OK', dist: [{ operationalCityName: 'Karachi' }, { operationalCityName: 'Lahore' }] });
        if (u.includes('/v3/create-order')) { sent.push({ token: opts.headers.token, body: JSON.parse(opts.body) }); return json({ statusCode: '200', statusMessage: 'ORDER HAS BEEN CREATED', dist: { trackingNumber: '3010100012' + sent.length } }); }
        if (u.includes('/v1/cancel-order')) { sent.push({ cancel: JSON.parse(opts.body) }); return json({ statusCode: '200', statusMessage: 'CANCELLED' }); }
        return realFetch(url, opts);
      };
      const place = async city => { const placed = await request('/orders', { method: 'POST', data: { customer: { name: 'PostEx Buyer', email: 'px@example.test', phone: '+923001234567', address: 'House 1, Street 2', city, country: 'Pakistan' }, paymentMethod: 'cod', items: [{ productId: product._id, quantity: 1 }] } }); assert.equal(placed.status, 201, JSON.stringify(placed.body)); return Order.findOne({ reference: placed.body.reference }).lean(); };
      const cancelOrder = async id => { const o = await Order.findById(id).lean(); assert.equal((await request('/admin/orders/' + id, { method: 'PUT', data: { _version: o.__v, status: 'cancelled' } })).status, 200); };
      const book = (id, data = {}) => request('/admin/orders/' + id + '/postex', { method: 'POST', data });
      const orders = [];
      try {
        const first = await place('karachi'); orders.push(first);
        delete process.env.POSTEX_API_TOKEN;
        assert.equal((await book(first._id)).status, 400); // not set up yet
        assert.equal((await request('/admin/postex/cities')).body.configured, false);

        process.env.POSTEX_API_TOKEN = 'pk_test_token';
        const cities = await request('/admin/postex/cities?city=karachi');
        assert.deepEqual([cities.body.configured, cities.body.match], [true, 'Karachi']);
        const booked = await book(first._id);
        assert.equal(booked.status, 200, JSON.stringify(booked.body));
        assert.equal(booked.body.postexState, 'booked');
        assert.equal(booked.body.postexTracking, '30101000121');
        assert.equal(booked.body.courier, 'PostEx');
        assert.equal(booked.body.trackingNumber, '30101000121');
        assert.equal(booked.body.status, 'processing');
        assert.equal(sent[0].token, 'pk_test_token');
        assert.deepEqual({ ...sent[0].body, orderDetail: undefined, transactionNotes: undefined }, { cityName: 'Karachi', customerName: 'PostEx Buyer', customerPhone: '03001234567', deliveryAddress: 'House 1, Street 2', invoiceDivision: 1, invoicePayment: first.total, items: 1, orderDetail: undefined, orderRefNumber: first.reference, orderType: 'Normal', transactionNotes: undefined });
        assert.equal((await book(first._id)).status, 409); // already booked
        assert.equal(sent.length, 1);

        const second = await place('Atlantis'); orders.push(second);
        const refused = await book(second._id);
        assert.equal(refused.status, 422);
        assert.match(refused.body.error, /does not recognise the city "Atlantis"/);
        assert.equal((await Order.findById(second._id)).postexState, ''); // nothing was claimed or sent
        assert.equal(sent.length, 1);
        const retried = await book(second._id, { cityName: 'Lahore' });
        assert.equal(retried.status, 200, JSON.stringify(retried.body));
        assert.equal(sent[1].body.cityName, 'Lahore');

        const cancelled = await request('/admin/orders/' + first._id + '/postex/cancel', { method: 'POST', data: {} });
        assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
        assert.deepEqual(sent[2].cancel, { trackingNumber: '30101000121' });
        assert.equal(cancelled.body.postexState, 'cancelled');
        assert(!cancelled.body.courier && !cancelled.body.trackingNumber);
        assert.equal((await request('/admin/orders/' + first._id + '/postex/cancel', { method: 'POST', data: {} })).status, 400);
      } finally {
        globalThis.fetch = realFetch;
        delete process.env.POSTEX_API_TOKEN;
        for (const o of orders) await cancelOrder(o._id);
      }
    });
    await t.test('security boundaries, malformed input, session revocation and throttling', async()=>{
      for(const path of ['/admin/dashboard','/admin/products','/admin/orders','/admin/customers','/admin/audit','/admin/images'])assert.equal((await request(path,{auth:false})).status,401,path);
      assert.equal((await request('/admin/site',{method:'PUT',data:{},auth:false})).status,401);
      assert.equal((await request('/admin/login',{method:'POST',data:{email:{$ne:null},password:'anything'},auth:false})).status,400);
      assert.equal((await request('/orders',{method:'POST',data:[]})).status,400);
      assert.equal((await request('/coupons/validate',{method:'POST',data:{items:[null]}})).status,400);
      const health=await fetch(origin+'/api/health');assert.equal(health.headers.get('x-content-type-options'),'nosniff');assert.equal(health.headers.get('x-powered-by'),null);assert.equal(health.headers.get('cache-control'),'no-store');
      const malformed=await fetch(origin+'/api/orders',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"secret":"hidden",'});assert.equal(malformed.status,400);assert(!JSON.stringify(await malformed.json()).includes('hidden'));
      assert.equal((await fetch(origin+'/.env')).status,404);
      assert.equal((await request('/admin/logout',{method:'POST',data:{}})).status,200);
      assert.equal((await request('/admin/dashboard')).status,401);
      const login=await request('/admin/login',{method:'POST',data:{email,password},auth:false});token=login.body.token;assert.equal(login.status,200);
      const changedPassword=crypto.randomBytes(24).toString('hex');
      assert.equal((await request('/admin/password',{method:'POST',data:{currentPassword:password,newPassword:changedPassword}})).status,200);
      assert.equal((await request('/admin/dashboard')).status,401);
      const renewed=await request('/admin/login',{method:'POST',data:{email,password:changedPassword},auth:false});assert.equal(renewed.status,200);token=renewed.body.token;
      assert.equal((await request('/admin/dashboard',{headers:{Authorization:'Bearer '+token.slice(0,-4)+'xxxx'}})).status,401);
      let limited;for(let i=0;i<12;i++)limited=await request('/admin/login',{method:'POST',data:{email,password:'incorrect'},auth:false});assert.equal(limited.status,429);
    });
    await t.test('customer reviews wait for admin approval and administration activity is recorded', async () => {
      const review = { productId: product._id, name: 'Sana', rating: 4, message: 'Lovely fragrance, lasts all day.' };
      assert.equal((await request('/reviews', { method: 'POST', data: { ...review, rating: undefined } })).status, 400);
      assert.equal((await request('/reviews', { method: 'POST', data: { ...review, rating: 6 } })).status, 400);
      assert.equal((await request('/reviews', { method: 'POST', data: { ...review, rating: 3.5 } })).status, 400);
      assert.equal((await request('/reviews', { method: 'POST', data: { ...review, message: 'ab' } })).status, 400);
      assert.equal((await request('/reviews', { method: 'POST', data: { ...review, email: 'not-an-email' } })).status, 400);
      assert.equal((await request('/reviews', { method: 'POST', data: { ...review, productId: String(new mongoose.Types.ObjectId()) } })).status, 404);
      assert.equal((await request('/reviews', { method: 'POST', data: { ...review, name: 'Bot', website: 'spam.example' } })).status, 201);
      assert.equal(await Review.countDocuments({ author: 'Bot' }), 0);
      assert.equal((await request('/reviews', { method: 'POST', data: { ...review, message: 'Great, visit www.spam.example now' } })).status, 400);
      assert.equal((await request('/reviews', { method: 'POST', data: review })).status, 201);
      assert.equal((await request('/reviews', { method: 'POST', data: review })).status, 201);
      assert.equal(await Review.countDocuments({ author: 'Sana' }), 1);
      let blocked;
      for (let i = 0; i < 10 && !blocked; i++) { const attempt = await request('/reviews', { method: 'POST', data: review }); if (attempt.status === 429) blocked = attempt; }
      assert(blocked, 'review form must stop accepting submissions after a handful per hour');
      assert.match(blocked.body.error, /several reviews/);
      const saved = await Review.findOne({ author: 'Sana' }).lean();
      assert.equal(saved.status, 'pending');
      assert.equal(saved.rating, 4);
      assert.equal((await request('/store')).body.settings.reviewsEnabled, false); // approved reviews must show on product pages even with the homepage section off
      assert(!(await request('/store')).body.reviews.some(r => r._id === String(saved._id)));
      assert.equal((await request('/admin/reviews', { method: 'POST', data: { productId: product._id, author: 'Admin', text: 'Admins cannot add reviews.' } })).status, 404);
      assert.equal((await request('/admin/reviews/' + saved._id, { method: 'PUT', data: { _version: saved.__v, status: 'published', text: 'Edited by admin' } })).status, 200);
      assert.equal((await Review.findById(saved._id)).text, saved.text);
      const shown = (await request('/store')).body.reviews.find(r => r._id === String(saved._id));
      assert(shown && shown.author === 'Sana' && shown.rating === 4 && !('email' in shown));
      assert((await request('/admin/audit')).body.total > 10);
      assert.equal((await Site.findOne({ key: 'website' })).sections[0].title, 'Database-driven heading');
    });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    // Only this randomly generated, test-owned database may be removed.
    assert.equal(mongoose.connection.name, database);
    assert(database.startsWith('mivorax_integration_'));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
