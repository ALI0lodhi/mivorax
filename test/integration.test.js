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
import { Product, Category, Site, Order, Coupon, Subscriber } from '../src/models.js';

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
      await seedDatabase({ email, password });
      const products = await request('/products');
      assert.equal(products.body.length, 0); // Seed concepts never appear in the live catalog.
      assert(products.body.every(p => mongoose.isValidObjectId(p._id)));
      assert.equal(await Product.countDocuments(), 4);
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
      site.sections.find(section => section.type === 'newsletter').enabled = false;
      site.sections.find(section => section.type === 'journal').enabled = false;
      const hidden = await request('/admin/site', { method: 'PUT', data: { ...site, _version: site.__v } });
      assert.equal(hidden.status, 200, JSON.stringify(hidden.body));
      assert.equal(hidden.body.sections.find(section => section.type === 'hero').productId, hero.productId);
      assert(!(await request('/store')).body.site.sections.some(section => ['newsletter', 'journal'].includes(section.type)));
      site = (await request('/admin/dashboard')).body.site;
      assert.equal(site.sections.find(section => section.type === 'newsletter').enabled, false);
      site.sections.find(section => section.type === 'newsletter').enabled = true;
      assert.equal((await request('/admin/site', { method: 'PUT', data: { ...site, _version: site.__v } })).status, 200);
      assert((await request('/store')).body.site.sections.some(section => section.type === 'newsletter'));
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
    await t.test('newsletter consent and feature controls are enforced in the database', async () => {
      assert.equal((await request('/newsletter', { method: 'POST', data: { email: 'reader@example.test', consent: false } })).status, 400);
      assert.equal((await request('/newsletter', { method: 'POST', data: { email: 'reader@example.test', consent: true } })).status, 200);
      const sub = await Subscriber.findOne({ email: 'reader@example.test' }); assert(sub.consentedAt);
      assert.equal((await request('/admin/subscribers/' + sub._id, { method: 'PUT', data: { active: false } })).status, 200);
      assert.equal((await Subscriber.findById(sub._id)).active, false);
      await request('/admin/settings', { method: 'PUT', data: { journalEnabled: false, newsletterEnabled: false } });
      assert.deepEqual((await request('/posts')).body, []);
      assert(!(await request('/store')).body.site.sections.some(s => ['newsletter', 'journal'].includes(s.type)));
      assert.equal((await request('/newsletter', { method: 'POST', data: { email: 'reader@example.test', consent: true } })).status, 403);
      assert.equal((await request('/admin/settings', { method: 'PUT', data: { prepaidEnabled: true } })).status, 400);
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
      assert.equal((await request('/orders/track', { method: 'POST', data: { reference: placed.reference, token: 'wrong' } })).status, 404);
      let order = await Order.findOne({ reference: placed.reference }).lean();
      assert.equal((await request('/admin/orders/' + order._id, { method: 'PUT', data: { _version: order.__v, status: 'cancelled' } })).status, 200);
      assert.equal((await Product.findById(product._id)).stock, 2);
      assert.equal((await Coupon.findById(coupon._id)).used, 0);
      assert.equal((await request('/admin/orders/' + order._id, { method: 'PUT', data: { _version: order.__v, status: 'cancelled' } })).status, 409);
      assert.equal((await Product.findById(product._id)).stock, 2);
      assert.equal((await request('/admin/customers')).body.items[0].spent, 0);
      const sample = await Product.findOne({ demo: true });
      assert.equal((await request('/orders', { method: 'POST', data: { ...payload, coupon: '', items: [{ productId: String(sample._id), quantity: 1 }] } })).status, 400);
    });
    await t.test('security boundaries, malformed input, session revocation and throttling', async()=>{
      for(const path of ['/admin/dashboard','/admin/products','/admin/orders','/admin/customers','/admin/subscribers','/admin/audit','/admin/images'])assert.equal((await request(path,{auth:false})).status,401,path);
      assert.equal((await request('/admin/site',{method:'PUT',data:{},auth:false})).status,401);
      assert.equal((await request('/admin/login',{method:'POST',data:{email:{$ne:null},password:'anything'},auth:false})).status,400);
      assert.equal((await request('/newsletter',{method:'POST',data:[]})).status,400);
      assert.equal((await request('/coupons/validate',{method:'POST',data:{items:[null]}})).status,400);
      const health=await fetch(origin+'/api/health');assert.equal(health.headers.get('x-content-type-options'),'nosniff');assert.equal(health.headers.get('x-powered-by'),null);assert.equal(health.headers.get('cache-control'),'no-store');
      const malformed=await fetch(origin+'/api/newsletter',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"secret":"hidden",'});assert.equal(malformed.status,400);assert(!JSON.stringify(await malformed.json()).includes('hidden'));
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
    await t.test('reviews require a delivered order and administration activity is recorded', async () => {
      assert.equal((await request('/admin/reviews', { method: 'POST', data: { productId: product._id, orderReference: 'NO-ORDER', author: 'Test', rating: 5, text: 'Not a genuine review.', status: 'published' } })).status, 400);
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
