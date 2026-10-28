import { MongoRateStore } from './rate-store.js';
import sharp from 'sharp';
import { inputGuard } from './security.js';
import express from 'express';
import mongoose from 'mongoose';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import crypto from 'node:crypto';
import { Product, Category, Collection, Setting, Post, Page, Site, Review, Admin, Order, Coupon, Audit, resourceModels, resourceFields, AdminSession } from './models.js';
import { calculateTotals, couponIsValid, validateCheckout, linePrice, lineStock, productHasSizes } from './commerce.js';
import { defaultSettings, cleanSettings } from './settings.js';
import { safepayConfig, safepayConfigured, safepayMock, createPaymentToken, createAuthToken, buildCheckoutUrl, verifyRedirect, verifyWebhook, isPaidWebhook, fetchTrackerPaid } from './safepay.js';
import { visibleCategorySlugs, visibleNavigationCategories, categoryTreeError } from './catalog.js';
import { deleteImpact, cleanUpReferences } from './references.js';
import { postexConfigured, postexCities, matchCity, createPostexOrder, cancelPostexOrder } from './postex.js';

const active = { archivedAt: null };
const fail = (status, message) => Object.assign(new Error(message), { status });
const pick = (input, fields) => Object.fromEntries(Object.entries(input || {}).filter(([key]) => fields.includes(key)));
const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const awaitDummyHash = () => bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);

function pagination(req) {
  const read = (key, fallback, max) => {
    const value = req.query[key];
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > max) throw fail(400, 'Invalid pagination.');
    return Number(value);
  };
  return { page: read('page', 1, 100000), limit: read('limit', 20, 100) };
}

export function createApp({ secret = process.env.JWT_SECRET, origins = (process.env.CLIENT_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173').split(',').map(s => s.trim()) } = {}) {
  const app = express();

  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY_HOPS) {
    if (!/^[1-5]$/.test(process.env.TRUST_PROXY_HOPS)) throw Error('Invalid proxy configuration.');
    app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS));
  }
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      res.vary('Origin');
      if (!origins.includes(origin)) return next(fail(403, 'This website origin is not allowed.'));
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Idempotency-Key');
      res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (/(?:^|\/)\.|\.(?:env|map|pem|key|sql|bak)$/i.test(req.path)) return res.sendStatus(404);
    next();
  });
  app.use('/api', (req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS', 'DELETE'].includes(req.method) && !req.is('application/json') && !(req.method === 'POST' && req.path === '/admin/images' && req.is('multipart/form-data'))) return res.status(415).json({ error: 'Unsupported content type.' });
    next();
  });
  // Every limiter answers with JSON so the storefront can show the message instead of a generic API error.
  const limiter = (name, windowMs, limit, message, extra = {}) => rateLimit({ windowMs, limit, store: new MongoRateStore(name), standardHeaders: 'draft-8', legacyHeaders: false, message: { error: message }, ...extra });
  const busy = 'Too many requests. Please slow down and try again in a moment.';
  app.use('/api', limiter('api', 60000, 600, busy));
  app.use(express.json({ limit: '1mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
  app.use(inputGuard);
  app.use('/api', rateLimit({ windowMs: 60000, limit: 600, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: busy } }));

  // One limiter per form, so one form can't use up another's allowance.
  const loginLimit = limiter('login', 15 * 60000, 10, 'Too many sign-in attempts. Please try again later.', { skipSuccessfulRequests: true });
  const passwordLimit = limiter('password', 15 * 60000, 5, 'Too many password change attempts. Please try again later.', { skipSuccessfulRequests: true });
  const orderLimit = limiter('orders', 15 * 60000, 20, 'Too many order attempts. Please wait a few minutes and try again.');
  const couponLimit = limiter('coupons', 15 * 60000, 20, 'Too many discount code attempts. Please wait a few minutes and try again.');
  const trackLimit = limiter('tracking', 15 * 60000, 60, 'Too many order lookups. Please wait a few minutes and try again.');
  const reviewLimit = limiter('reviews', 60 * 60000, 5, 'You have sent several reviews recently. Please try again in a while.', { skipFailedRequests: true });
  const paymentHookLimit = limiter('payment-hooks', 60000, 120, busy);
  const adminWriteLimit = limiter('admin-writes', 60000, 240, 'Too many changes in a short time. Please wait a moment and try again.');
  const ready = (req, res, next) => mongoose.connection.readyState === 1 ? next() : next(fail(503, 'MongoDB is not connected. Configure server/.env and start the local database.'));

  const settings = async session => {
    let q = Setting.findOne({ key: 'store' });
    if (session) q = q.session(session);
    const doc = await q.lean();
    if (!doc) throw fail(503, 'Store is not initialized. Run npm run seed in server.');
    return cleanSettings({}, { ...defaultSettings, ...doc.value });
  };
  const audit = (req, action, detail, session) => Audit.create([{ admin: req.admin, action, detail }], session ? { session } : undefined);

  async function auth(req, res, next) {
    try {
      if (!secret || secret.length < 32) throw Error();
      const payload = jwt.verify(req.headers.authorization?.replace(/^Bearer /, ''), secret, { algorithms: ['HS256'], issuer: 'mivorax-api', audience: 'mivorax-admin' });
      if (payload.role !== 'admin' || !mongoose.isValidObjectId(payload.sub) || !await Admin.exists({ _id: payload.sub, disabled: { $ne: true }, passwordChangedAt: payload.passwordVersion ? new Date(payload.passwordVersion) : null })) throw Error();
      const tokenHash = crypto.createHash('sha256').update(req.headers.authorization.slice(7)).digest('hex');
      if (!await AdminSession.exists({ tokenHash, admin: payload.sub, expiresAt: { $gt: new Date() } })) throw Error();
      req.admin = payload.sub;
      req.tokenHash = tokenHash;
      next();
    } catch {
      next(fail(401, 'Your session has expired. Sign in as an administrator.'));
    }
  }

  async function catalog(session) {
    let cq = Category.find().lean();
    if (session) cq = cq.session(session);
    const categories = await cq;
    const slugs = visibleCategorySlugs(categories);
    let pq = Product.find({ ...active, status: 'published', category: { $in: slugs } }).sort({ createdAt: -1 }).lean();
    if (session) pq = pq.session(session);
    return { categories, products: await pq, slugs };
  }

  async function verifyResource(resource, data, id) {
    if (resource === 'products') {
      if (!await Category.exists({ slug: data.category, ...active })) throw fail(400, 'Choose an active category.');
      if (data.salePrice != null && data.salePrice > data.price) throw fail(400, 'Sale price cannot exceed the regular price.');
      if (Array.isArray(data.sizes) && data.sizes.length) {
        if (data.sizes.some(s => !s || typeof s.label !== 'string' || !s.label.trim())) throw fail(400, 'Every size needs a name.');
        if (new Set(data.sizes.map(s => s.label.trim().toLowerCase())).size !== data.sizes.length) throw fail(400, 'Size names must be unique.');
        if (data.sizes.some(s => !(s.price > 0))) throw fail(400, 'Every size needs a price above zero.');
      }
    }
    if (resource === 'categories') {
      const existing = id ? await Category.findById(id).lean() : null;
      if (existing && data.slug !== existing.slug) throw fail(400, 'Category slugs are permanent so product and menu links remain valid.');
      const issue = categoryTreeError(await Category.find().lean(), data);
      if (issue) throw fail(400, issue);
    }
    if (resource === 'collections' || resource === 'posts') {
      const ids = data.productIds || [];
      if (new Set(ids.map(String)).size !== ids.length || await Product.countDocuments({ _id: { $in: ids }, ...active }) !== ids.length) throw fail(400, 'Choose existing, active products.');
    }
    if (resource === 'coupons') {
      if (data.kind === 'percentage' && data.amount > 100) throw fail(400, 'Percentage discounts cannot exceed 100.');
      if (data.startsAt && data.expiresAt && new Date(data.expiresAt) <= new Date(data.startsAt)) throw fail(400, 'Code expiry must follow its start date.');
    }
    if (resource === 'reviews') {
      if (!await Product.exists({ _id: data.productId, ...active })) throw fail(400, 'Choose an active product.');
    }
  }

  async function resolveBag(lines) {
    if (!Array.isArray(lines) || !lines.length || lines.length > 30 || new Set(lines.map(i => i?.productId + '\u0000' + (i?.size || ''))).size !== lines.length) throw fail(400, 'Your bag must contain unique product lines.');
    const { products } = await catalog();
    return lines.map(i => {
      if (!i || typeof i.productId !== 'string') throw fail(400, 'Invalid bag item.');
      const p = products.find(p => String(p._id) === i.productId);
      const price = p ? linePrice(p, i.size) : null, stock = p ? lineStock(p, i.size) : null;
      if (!p || price == null || stock == null || !Number.isInteger(i.quantity) || i.quantity < 1 || i.quantity > 10 || stock < i.quantity) throw fail(400, 'An item is unavailable or its quantity is invalid.');
      return { productId: String(p._id), quantity: i.quantity, unitPrice: price };
    });
  }

  app.get('/api/health', async (req, res) => {
    const connected = mongoose.connection.readyState === 1;
    let transactions = false;
    if (connected) {
      try {
        const hello = await mongoose.connection.db.admin().command({ hello: 1 });
        transactions = !!hello.setName || hello.msg === 'isdbgrid';
      } catch {}
    }
    if (process.env.NODE_ENV === 'production') return res.status(connected ? 200 : 503).json({ status: connected ? 'ok' : 'unavailable' });
    res.json({ status: connected ? 'ok' : 'database-unavailable', database: connected ? 'connected' : 'unavailable', transactions, demo: false });
  });
  app.use('/api', ready);

  app.get('/api/store', async (req, res) => {
    const config = await settings();
    const site = await Site.findOne({ key: 'website' }).lean();
    if (!site) throw fail(503, 'Website content is not initialized. Run npm run seed in server.');
    const { categories, products } = await catalog();
    const navigationCategories = visibleNavigationCategories(categories, products);
    const pages = await Page.find({ ...active, status: 'published' }).lean();
    const collections = await Collection.find({ ...active, status: 'published' }).sort({ order: 1 }).lean();
    const ids = new Set(products.map(p => String(p._id)));
    const publishedCollections = collections.map(c => ({ ...c, productIds: c.productIds.map(String).filter(id => ids.has(id)) })).filter(c => c.productIds.length);
    const reviews = await Review.find({ ...active, status: 'published', productId: { $in: products.map(p => p._id) } }).sort({ createdAt: -1 }).select('productId author rating text createdAt').lean();
    const allowedLink = l => {
      if (l.enabled === false) return false;
      if (l.category && !navigationCategories.some(c => c.slug === l.category)) return false;
      const href = l.href || '';
      if (!config.journalEnabled && href.startsWith('/journal')) return false;
      const categorySlug = href.startsWith('/shop?') ? new URL(href, 'http://local').searchParams.get('category') : null;
      if (categorySlug && !navigationCategories.some(c => c.slug === categorySlug)) return false;
      const collectionSlug = href.startsWith('/shop?') ? new URL(href, 'http://local').searchParams.get('collection') : null;
      if (collectionSlug && !publishedCollections.some(c => c.slug === collectionSlug)) return false;
      if (href.startsWith('/pages/') && !pages.some(p => p.slug === href.slice(7))) return false;
      if (href.startsWith('/support/') && !pages.some(p => p.slug === href.split('?')[0].slice(9))) return false;
      if (href === '/about' && !pages.some(p => p.slug === 'about')) return false;
      return true;
    };
    site.navigation = site.navigation.filter(allowedLink);
    site.footer.groups = site.footer.groups.map(g => ({ ...g, links: g.links.filter(allowedLink) }));
    site.footer.socialLinks = site.footer.socialLinks.filter(allowedLink);
    site.sections = site.sections.filter(x => x.enabled && (x.type !== 'journal' || config.journalEnabled) && (x.type !== 'reviews' || config.reviewsEnabled)).sort((a, b) => a.order - b.order);
    const homepageCategories = categories.filter(c => c.showOnHomepage && !c.archivedAt && c.status === 'published').sort((a, b) => a.order - b.order);
    res.json({ settings: config, site, categories: navigationCategories, homepageCategories, pages, collections: publishedCollections, reviews });
  });
  app.get('/api/products', async (req, res) => res.json((await catalog()).products));
  app.get('/api/posts', async (req, res) => res.json((await settings()).journalEnabled ? await Post.find({ ...active, status: 'published', publishedAt: { $lte: new Date() } }).sort({ publishedAt: -1 }).lean() : []));

  app.post('/api/reviews', reviewLimit, async (req, res) => {
    const { productId, name, email, message, rating, website } = req.body;
    const thanks = { message: 'Thank you! Your review was submitted and will appear once it has been approved.' };
    if (website) return res.status(201).json(thanks);
    if (typeof productId !== 'string' || !mongoose.isValidObjectId(productId)) throw fail(400, 'Choose a product to review.');
    const author = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : '';
    const text = typeof message === 'string' ? message.trim() : '';
    const mail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const hasLink = value => /https?:\/\/|www\./i.test(value);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw fail(400, 'Choose a star rating from 1 to 5.');
    if (!author || author.length > 100) throw fail(400, 'Enter your name (up to 100 characters).');
    if (text.length < 5 || text.length > 2000) throw fail(400, 'Write a message between 5 and 2000 characters.');
    if (hasLink(author) || hasLink(text)) throw fail(400, 'Please remove web links from your review.');
    if (mail && (mail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail))) throw fail(400, 'Enter a valid email address, or leave it empty.');
    if (!await Product.exists({ _id: productId, ...active, status: 'published' })) throw fail(404, 'Product not found.');
    if (await Review.exists({ productId, author, text })) return res.status(201).json(thanks);
    if (await Review.countDocuments({ status: 'pending' }) >= 500) throw fail(503, 'We are not accepting new reviews right now. Please try again later.');
    await Review.create({ productId, author, email: mail || undefined, rating, text, status: 'pending' });
    res.status(201).json(thanks);
  });

  app.post('/api/coupons/validate', couponLimit, async (req, res) => {
    if (typeof req.body.code !== 'string' || req.body.code.length > 80) throw fail(400, 'Enter a valid discount code.');
    const coupon = await Coupon.findOne({ code: req.body.code.trim().toUpperCase(), ...active });
    const items = await resolveBag(req.body.items);
    const config = await settings();
    if (!couponIsValid(coupon, calculateTotals(items, config).subtotal)) throw fail(400, 'This code is unavailable or does not apply to your bag.');
    res.json({ code: coupon.code, ...calculateTotals(items, config, coupon) });
  });

  app.post('/api/orders', orderLimit, async (req, res) => {
    const key = req.get('Idempotency-Key');
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(key) || key.length > 128) throw fail(400, 'Please refresh checkout and try again.');
    const idempotencyHash = crypto.createHash('sha256').update(key).digest('hex');
    const config = await settings();
    const issue = validateCheckout(req.body, config);
    if (issue) throw fail(400, issue);
    const fingerprint = JSON.stringify({ customer: Object.fromEntries(['name', 'email', 'phone', 'address', 'city', 'country'].map(k => [k, k === 'email' ? req.body.customer[k].trim().toLowerCase() : req.body.customer[k].trim()])), items: req.body.items.map(i => ({ productId: i.productId, quantity: i.quantity })), paymentMethod: req.body.paymentMethod, coupon: typeof req.body.coupon === 'string' ? req.body.coupon.trim().toUpperCase() : '' });
    const requestHash = crypto.createHash('sha256').update(fingerprint).digest('hex');
    const trackingToken = crypto.createHmac('sha256', secret).update('order-tracking:' + key).digest('hex');

    if (req.body.paymentMethod === 'safepay') {
      if (!config.prepaidEnabled || !safepayConfigured()) throw fail(400, 'Online payment is unavailable.');
      const mock = safepayMock();
      const spconf = safepayConfig();
      const siteBase = (process.env.PUBLIC_SITE_URL || origins[0] || '').replace(/\/$/, '');
      const apiBase = (process.env.PUBLIC_API_URL || (req.protocol + '://' + req.get('host'))).replace(/\/$/, '');
      const trackingHash = crypto.createHash('sha256').update(trackingToken).digest('hex');
      const checkoutUrlFor = async (ref, token) => mock
        ? apiBase + '/api/payments/safepay/mock?order=' + encodeURIComponent(ref) + '&token=' + encodeURIComponent(token)
        : buildCheckoutUrl({ tracker: token, tbt: await createAuthToken(spconf), redirectUrl: apiBase + '/api/payments/safepay/return', cancelUrl: siteBase + '/checkout?payment=cancelled' }, spconf);
      const existing = await Order.findOne({ idempotencyHash }).select('+requestHash +trackingHash +safepayToken');
      if (existing) {
        if (existing.requestHash !== requestHash) throw fail(409, 'Your checkout details changed. Please refresh checkout and try again.');
        if (existing.trackingHash !== trackingHash) throw fail(409, 'This order was already placed. Please use your saved tracking details.');
        return res.json({ reference: existing.reference, token: trackingToken, total: existing.total, status: existing.status, paymentStatus: existing.paymentStatus, checkoutUrl: existing.paymentStatus === 'unpaid' && existing.safepayToken ? await checkoutUrlFor(existing.reference, existing.safepayToken) : null });
      }
      const { slugs } = await catalog();
      const items = [];
      for (const item of req.body.items) {
        const p = await Product.findOne({ _id: item.productId, ...active, status: 'published', category: { $in: slugs } }).lean();
        const price = p ? linePrice(p, item.size) : null, stock = p ? lineStock(p, item.size) : null;
        if (!p || price == null || stock == null || stock < item.quantity) throw fail(400, 'An item is unavailable or no longer has enough stock.');
        items.push({ productId: String(p._id), name: p.name, quantity: item.quantity, unitPrice: price, volume: p.volume, size: item.size || '' });
      }
      let coupon = null;
      if (req.body.coupon) {
        coupon = await Coupon.findOne({ code: String(req.body.coupon).trim().toUpperCase(), ...active });
        if (!couponIsValid(coupon, calculateTotals(items, config).subtotal)) throw fail(400, 'The discount code is no longer valid.');
      }
      const totals = calculateTotals(items, config, coupon);
      const reference = 'MVX-' + crypto.randomBytes(6).toString('hex').toUpperCase();
      const safepayToken = mock ? 'mock_' + crypto.randomBytes(16).toString('hex') : await createPaymentToken({ amount: totals.total, currency: config.currency, orderId: reference }, spconf);
      const customer = Object.fromEntries(['name', 'email', 'phone', 'address', 'city', 'country'].map(k => [k, req.body.customer[k].trim()]));
      customer.email = customer.email.toLowerCase();
      let order;
      try {
        [order] = await Order.create([{ reference, idempotencyHash, requestHash, trackingHash, customer, items, ...totals, coupon: coupon?.code, paymentMethod: 'safepay', status: 'pending_payment', paymentStatus: 'unpaid', safepayToken }]);
      } catch (error) {
        const dup = await Order.findOne({ idempotencyHash }).select('+safepayToken');
        if (!dup) throw error;
        order = dup;
      }
      return res.status(201).json({ reference: order.reference, token: trackingToken, total: order.total, status: order.status, paymentStatus: order.paymentStatus, checkoutUrl: await checkoutUrlFor(order.reference, order.safepayToken || safepayToken) });
    }

    const receipt = order => {
      if (order.requestHash !== requestHash) throw fail(409, 'Your checkout details changed. Please refresh checkout and try again.');
      if (order.trackingHash !== crypto.createHash('sha256').update(trackingToken).digest('hex')) throw fail(409, 'This order was already placed. Please use your saved tracking details.');
      return { reference: order.reference, token: trackingToken, total: order.total, status: order.status };
    };
    const previous = await Order.findOne({ idempotencyHash }).select('+requestHash +trackingHash');
    if (previous) return res.json(receipt(previous));
    const session = await mongoose.startSession();
    let result;
    try {
      await session.withTransaction(async () => {
        const latest = await settings(session);
        const issue = validateCheckout(req.body, latest);
        if (issue) throw fail(400, issue);
        const { slugs } = await catalog(session);
        const items = [];
        for (const item of req.body.items) {
          const base = { _id: item.productId, ...active, status: 'published', category: { $in: slugs } };
          const prod = await Product.findOne(base).session(session);
          if (!prod) throw fail(400, 'An item is unavailable or no longer has enough stock.');
          const price = linePrice(prod, item.size);
          if (price == null) throw fail(400, 'Choose an available size.');
          const p = productHasSizes(prod)
            ? await Product.findOneAndUpdate({ ...base, sizes: { $elemMatch: { label: item.size, stock: { $gte: item.quantity } } } }, { $inc: { 'sizes.$.stock': -item.quantity, __v: 1 } }, { new: true, session })
            : await Product.findOneAndUpdate({ ...base, stock: { $gte: item.quantity } }, { $inc: { stock: -item.quantity, __v: 1 } }, { new: true, session });
          if (!p) throw fail(400, 'An item is unavailable or no longer has enough stock.');
          items.push({ productId: String(p._id), name: p.name, quantity: item.quantity, unitPrice: price, volume: p.volume, size: item.size || '' });
        }
        let coupon = null;
        if (req.body.coupon) {
          coupon = await Coupon.findOne({ code: String(req.body.coupon).trim().toUpperCase(), ...active }).session(session);
          if (!couponIsValid(coupon, calculateTotals(items, latest).subtotal)) throw fail(400, 'The discount code is no longer valid.');
          const updated = await Coupon.updateOne({ _id: coupon._id, used: coupon.used }, { $inc: { used: 1 } }, { session });
          if (!updated.modifiedCount) throw fail(409, 'The code changed. Please try again.');
        }
        const token = trackingToken;
        const reference = 'MVX-' + crypto.randomBytes(6).toString('hex').toUpperCase();
        const customer = Object.fromEntries(['name', 'email', 'phone', 'address', 'city', 'country'].map(k => [k, req.body.customer[k].trim()]));
        customer.email = customer.email.toLowerCase();
        const [order] = await Order.create([{ reference, idempotencyHash, requestHash, trackingHash: crypto.createHash('sha256').update(token).digest('hex'), customer, items, ...calculateTotals(items, latest, coupon), coupon: coupon?.code, paymentMethod: 'cod', unseen: true }], { session });
        result = { reference: order.reference, token, total: order.total, status: order.status };
      });
      res.status(201).json(result);
    } catch (error) {
      const existing = await Order.findOne({ idempotencyHash }).select('+requestHash +trackingHash');
      if (!existing) throw error;
      res.json(receipt(existing));
    } finally {
      await session.endSession();
    }
  });

  app.post('/api/orders/track', trackLimit, async (req, res) => {
    if (typeof req.body.reference !== 'string' || !/^MVX-[A-F0-9]{12}$/.test(req.body.reference) || typeof req.body.token !== 'string' || !/^(?:[a-f0-9]{48}|[a-f0-9]{64})$/.test(req.body.token)) throw fail(404, 'Order not found. Check your reference and private key.');
    const match = { reference: String(req.body.reference || ''), trackingHash: crypto.createHash('sha256').update(String(req.body.token || '')).digest('hex') };
    const fields = 'reference status paymentStatus paymentMethod courier trackingNumber subtotal shipping discount coupon total createdAt items';
    let order = await Order.findOne(match).select(fields + ' +safepayToken');
    if (!order) throw fail(404, 'Order not found. Check your reference and private key.');
    // For an unpaid online order, ask Safepay directly whether it was paid (works without inbound webhooks).
    if (order.paymentMethod === 'safepay' && order.paymentStatus === 'unpaid' && safepayConfigured()) {
      const paid = await fetchTrackerPaid(order.safepayToken);
      console.log('[safepay track]', order.reference, 'tracker paid?', paid);
      if (paid) { await fulfillSafepay(order); order = await Order.findOne(match).select(fields); }
      else { order = order.toObject(); delete order.safepayToken; }
    } else {
      order = order.toObject();
      delete order.safepayToken;
    }
    res.json(order);
  });

  const fulfillSafepay = async order => {
    if (!order || order.paymentMethod !== 'safepay') return;
    const marked = await Order.findOneAndUpdate({ _id: order._id, paymentStatus: 'unpaid' }, { $set: { paymentStatus: 'paid', paidAt: new Date(), status: 'confirmed', unseen: true }, $inc: { __v: 1 } }, { new: true });
    if (!marked) return;
    if (marked.coupon) await Coupon.updateOne({ code: marked.coupon }, { $inc: { used: 1 } }).catch(() => {});
    for (const line of marked.items) {
      const ok = line.size
        ? await Product.findOneAndUpdate({ _id: line.productId, sizes: { $elemMatch: { label: line.size, stock: { $gte: line.quantity } } } }, { $inc: { 'sizes.$.stock': -line.quantity, __v: 1 } })
        : await Product.findOneAndUpdate({ _id: line.productId, stock: { $gte: line.quantity } }, { $inc: { stock: -line.quantity, __v: 1 } });
      if (!ok) await Order.updateOne({ _id: marked._id }, { $set: { adminNote: ((marked.adminNote ? marked.adminNote + ' ' : '') + '[Paid online but stock ran short for ' + line.name + ' — review before dispatch.]').slice(0, 4000) } }).catch(() => {});
    }
  };
  app.post('/api/payments/safepay/webhook', paymentHookLimit, async (req, res) => {
    if (!safepayConfigured()) return res.sendStatus(503);
    if (!verifyWebhook({ signature: req.get('x-sfpy-signature'), rawBody: req.rawBody, data: req.body?.data }, safepayConfig())) return res.sendStatus(401);
    const data = req.body?.data || {};
    const tracker = data.tracker || data.token || data.tbt;
    if (tracker && isPaidWebhook(req.body?.type, data)) {
      const order = await Order.findOne({ safepayToken: tracker }).select('+safepayToken');
      await fulfillSafepay(order);
    }
    res.sendStatus(200);
  });
  app.get('/api/payments/safepay/return', paymentHookLimit, async (req, res) => {
    const siteBase = (process.env.PUBLIC_SITE_URL || origins[0] || '').replace(/\/$/, '');
    const q = req.query;
    const queryTracker = String(q.tracker || q.beacon || '');
    let reference = (String(q.order_id || q.order || '').match(/MVX-[A-F0-9]{12}/i) || [''])[0].toUpperCase();
    let order = queryTracker ? await Order.findOne({ safepayToken: queryTracker }).select('+safepayToken') : null;
    if (!order && reference) order = await Order.findOne({ reference }).select('+safepayToken');
    let confirmed = false;
    if (order && safepayConfigured()) {
      reference = order.reference;
      const sigOk = queryTracker && verifyRedirect({ sig: q.sig, tracker: queryTracker }, safepayConfig());
      if (sigOk || await fetchTrackerPaid(order.safepayToken)) { await fulfillSafepay(order); confirmed = true; }
    }
    console.log('[safepay return]', JSON.stringify(q), '| confirmed:', confirmed, '| ref:', reference || '(none)');
    res.redirect(siteBase + '/checkout/complete?order=' + encodeURIComponent(reference));
  });
  app.post('/api/payments/safepay/return', paymentHookLimit, async (req, res) => {
    if (!safepayConfigured()) return res.sendStatus(503);
    if (!verifyRedirect({ sig: req.body?.sig, tracker: req.body?.tracker }, safepayConfig())) return res.sendStatus(401);
    const order = await Order.findOne({ safepayToken: req.body.tracker }).select('+safepayToken');
    await fulfillSafepay(order);
    res.sendStatus(200);
  });

  const mockOnly = (req, res, next) => safepayMock() ? next() : res.sendStatus(404);
  const mockSiteBase = () => (process.env.PUBLIC_SITE_URL || origins[0] || '').replace(/\/$/, '');
  app.get('/api/payments/safepay/mock', mockOnly, async (req, res) => {
    const order = await Order.findOne({ reference: String(req.query.order || ''), safepayToken: String(req.query.token || '') }).select('+safepayToken');
    if (!order) return res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;text-align:center;padding:60px">Order not found.</body>');
    const payUrl = '/api/payments/safepay/mock/pay?order=' + encodeURIComponent(order.reference) + '&token=' + encodeURIComponent(String(req.query.token || ''));
    const cancelUrl = mockSiteBase() + '/checkout?payment=cancelled';
    const amount = 'PKR ' + Number(order.total).toLocaleString('en-PK');
    res.type('html').send('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Simulated payment</title><style>body{margin:0;font-family:system-ui,sans-serif;background:#f4f1ec;color:#1b1b1b;display:flex;min-height:100vh;align-items:center;justify-content:center}.card{background:#fff;max-width:420px;width:90%;padding:36px;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.08);text-align:center}.tag{display:inline-block;background:#fde68a;color:#7c5a00;font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;padding:4px 10px;border-radius:999px;margin-bottom:18px}h1{font-size:22px;margin:0 0 6px}.amt{font-size:30px;font-weight:800;margin:14px 0}.ref{color:#888;font-size:12px;margin-bottom:26px}a{display:block;text-decoration:none;padding:14px;border-radius:10px;font-weight:700;margin-top:10px}.pay{background:#1b1b1b;color:#fff}.cancel{background:transparent;color:#888}</style></head><body><div class="card"><span class="tag">Test mode · no real payment</span><h1>Simulated checkout</h1><div class="amt">' + amount + '</div><div class="ref">Order ' + order.reference + '</div><a class="pay" href="' + payUrl + '">Pay now (simulate success)</a><a class="cancel" href="' + cancelUrl + '">Cancel payment</a></div></body></html>');
  });
  app.get('/api/payments/safepay/mock/pay', mockOnly, async (req, res) => {
    const order = await Order.findOne({ reference: String(req.query.order || ''), safepayToken: String(req.query.token || '') }).select('+safepayToken');
    if (order) await fulfillSafepay(order);
    res.redirect(mockSiteBase() + '/checkout/complete?order=' + encodeURIComponent(String(req.query.order || '')));
  });

  const dummyHash = awaitDummyHash();
  app.post('/api/admin/login', loginLimit, async (req, res) => {
    if (!secret || secret.length < 32) throw fail(503, 'Sign-in is temporarily unavailable.');
    const { email, password } = req.body;
    if (typeof email !== 'string' || email.length > 254 || typeof password !== 'string' || Buffer.byteLength(password) > 72 || password.includes('\0')) throw fail(401, 'Incorrect email or password.');
    const admin = await Admin.findOne({ email: email.trim().toLowerCase(), disabled: { $ne: true } }).select('+passwordHash');
    const loginKey = crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
    const window = Math.floor(Date.now() / (15 * 60000));
    const attempts = await mongoose.connection.db.collection('login_attempts').findOneAndUpdate({ _id: loginKey + ':' + window }, { $inc: { count: 1 }, $set: { expiresAt: new Date((window + 2) * 15 * 60000) } }, { upsert: true, returnDocument: 'after' });
    if (attempts.count > 10) throw fail(429, 'Too many sign-in attempts. Please try again later.');
    const valid = await bcrypt.compare(password, admin?.passwordHash || await dummyHash);
    if (!admin || !valid) throw fail(401, 'Incorrect email or password.');
    const token = jwt.sign({ role: 'admin', passwordVersion: admin.passwordChangedAt?.getTime() || 0 }, secret, { subject: String(admin._id), expiresIn: '30m', algorithm: 'HS256', issuer: 'mivorax-api', audience: 'mivorax-admin', jwtid: crypto.randomUUID() });
    await AdminSession.create({ admin: admin._id, tokenHash: crypto.createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 30 * 60000) });
    res.json({ token });
  });

  app.use('/api/admin', auth);
  app.use('/api/admin', (req, res, next) => ['POST', 'PUT', 'DELETE'].includes(req.method) ? adminWriteLimit(req, res, next) : next());

  app.post('/api/admin/password', passwordLimit, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string' || Buffer.byteLength(currentPassword) > 72 || newPassword.length < 14 || Buffer.byteLength(newPassword) > 72 || newPassword.includes('\0')) throw fail(400, 'Use a password of at least 14 characters, up to 72 UTF-8 bytes.');
    const admin = await Admin.findById(req.admin).select('+passwordHash');
    if (!await bcrypt.compare(currentPassword, admin.passwordHash)) throw fail(401, 'Incorrect current password.');
    if (await bcrypt.compare(newPassword, admin.passwordHash)) throw fail(400, 'Choose a different password.');
    const updated = await Admin.updateOne({ _id: admin._id, passwordHash: admin.passwordHash }, { $set: { passwordHash: await bcrypt.hash(newPassword, 12), passwordChangedAt: new Date() } });
    if (!updated.modifiedCount) throw fail(409, 'Your account changed. Sign in again.');
    await AdminSession.deleteMany({ admin: admin._id });
    await audit(req, 'update password', 'Administrator password changed');
    res.json({ message: 'Password changed. Sign in again.' });
  });
  app.post('/api/admin/logout', async (req, res) => {
    await AdminSession.deleteOne({ tokenHash: req.tokenHash });
    res.json({ message: 'Signed out.' });
  });
  app.param('id', (req, res, next, id) => mongoose.isValidObjectId(id) ? next() : next(fail(400, 'Invalid record ID.')));

  app.get('/api/admin/dashboard', async (req, res) => {
    const counts = Object.fromEntries(await Promise.all(Object.entries({ ...resourceModels, orders: Order }).map(async ([k, M]) => [k, await M.countDocuments(k === 'orders' ? {} : active)])));
    res.json({ counts, settings: await settings(), site: await Site.findOne({ key: 'website' }).lean(), categories: await Category.find(active).sort({ order: 1 }).limit(1000).lean(), products: await Product.find(active).select('name slug category images price stock status').limit(1000).lean(), pendingReviews: await Review.countDocuments({ ...active, status: 'pending' }), newOrders: await Order.countDocuments({ unseen: true }), database: mongoose.connection.name });
  });

  for (const [resource, Model] of Object.entries({ ...resourceModels, orders: Order, audit: Audit })) {
    app.get('/api/admin/' + resource, async (req, res) => {
      const { page, limit } = pagination(req);
      const filter = ['orders', 'audit'].includes(resource) ? {} : req.query.archived === 'true' ? { archivedAt: { $ne: null } } : { ...active };
      if (resource === 'reviews' && ['pending', 'published', 'rejected'].includes(req.query.status)) filter.status = req.query.status;
      const query = String(req.query.q || '').trim().slice(0, 200);
      if (query) {
        const keys = resource === 'orders' ? ['reference', 'customer.email', 'customer.name'] : resource === 'audit' ? ['action', 'detail'] : ['name', 'title', 'slug', 'code', 'author'];
        filter.$or = keys.map(k => ({ [k]: { $regex: escapeRegex(query), $options: 'i' } }));
      }
      const total = await Model.countDocuments(filter);
      const items = await Model.find(filter).sort(resource === 'categories' ? { order: 1, createdAt: -1 } : { createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean();
      res.json({ items, total, page, pages: Math.max(1, Math.ceil(total / limit)) });
    });
    if (!resourceModels[resource]) continue;
    if (resource !== 'reviews') app.post('/api/admin/' + resource, async (req, res) => {
      const data = pick(req.body, resourceFields[resource]);
      const doc = new Model(data);
      await doc.validate();
      await verifyResource(resource, doc.toObject());
      await doc.save();
      await audit(req, 'create ' + resource, String(doc._id));
      res.status(201).json(doc);
    });
    app.put('/api/admin/' + resource + '/:id', async (req, res) => {
      const doc = await Model.findById(req.params.id);
      if (!doc) throw fail(404, 'Record not found.');
      if (req.body._version !== doc.__v) throw fail(409, 'This record changed in another session. Reload before saving.');
      doc.set(pick(req.body, resource === 'reviews' ? ['status'] : resourceFields[resource]));
      await doc.validate();
      await verifyResource(resource, doc.toObject(), doc._id);
      const update = pick(doc.toObject(), resourceFields[resource]);
      const unset = {};
      for (const key of resourceFields[resource]) if (update[key] === undefined) unset[key] = 1;
      const saved = await Model.findOneAndUpdate({ _id: doc._id, __v: doc.__v }, { $set: update, $unset: unset, $inc: { __v: 1 } }, { new: true, runValidators: true });
      if (!saved) throw fail(409, 'Record changed. Reload before saving.');
      await audit(req, 'update ' + resource, String(doc._id));
      res.json(saved);
    });
    app.post('/api/admin/' + resource + '/:id/archive', async (req, res) => {
      const record = await Model.findById(req.params.id);
      if (!record) throw fail(404, 'Record not found.');
      record.archivedAt = req.body.restore === true ? null : new Date();
      record.increment();
      await record.save();
      await audit(req, req.body.restore ? 'restore ' + resource : 'archive ' + resource, String(record._id));
      res.json(record);
    });
    app.delete('/api/admin/' + resource + '/:id', async (req, res) => {
      const removed = await Model.findByIdAndDelete(req.params.id);
      if (!removed) throw fail(404, 'Record not found.');
      const { lines } = await cleanUpReferences(resource, removed.toObject());
      await audit(req, 'delete ' + resource, String(removed._id) + ' ' + (removed.name || removed.title || removed.code || removed.author || '') + (lines.length ? ' (' + lines.join('; ') + ')' : ''));
      res.json({ message: 'Permanently deleted.', cleaned: lines });
    });
  }

  // What deleting a record will also change, so the admin can confirm with the facts in front of them.
  app.get('/api/admin/delete-impact/:resource/:id', async (req, res) => {
    const { resource } = req.params;
    if (!['categories', 'collections', 'pages', 'products', 'images'].includes(resource)) return res.json({ lines: [], notes: [] });
    const doc = resource === 'images' ? { _id: req.params.id } : await resourceModels[resource].findById(req.params.id).lean();
    if (!doc) throw fail(404, 'Record not found.');
    res.json(await deleteImpact(resource, doc));
  });

  app.put('/api/admin/site', async (req, res) => {
    const current = await Site.findOne({ key: 'website' });
    if (!current) throw fail(503, 'Run the seed command first.');
    if (req.body._version !== current.__v) throw fail(409, 'Website settings changed. Reload before saving.');
    const previousSections = new Map(current.sections.map(section => [section.key, { productId: section.productId ? String(section.productId) : null, collectionSlug: section.collectionSlug || '' }]));
    const allowed = Object.keys(Site.schema.paths).map(k => k.split('.')[0]).filter(k => !['_id', '__v', 'key', 'createdAt', 'updatedAt'].includes(k));
    current.set(pick(req.body, allowed));
    await current.validate();
    const keys = current.sections.map(s => s.key);
    if (new Set(keys).size !== keys.length) throw fail(400, 'Homepage section keys must be unique.');
    for (const s of current.sections) {
      if (s.productId && String(s.productId) !== previousSections.get(s.key)?.productId && !await Product.exists({ _id: s.productId, ...active })) throw fail(400, 'Choose an active hero product.');
      if (s.collectionSlug && s.collectionSlug !== previousSections.get(s.key)?.collectionSlug && !await Collection.exists({ slug: s.collectionSlug, ...active })) throw fail(400, 'Choose an active collection.');
    }
    const update = pick(current.toObject(), allowed);
    const saved = await Site.findOneAndUpdate({ _id: current._id, __v: current.__v }, { $set: update, $inc: { __v: 1 } }, { new: true, runValidators: true });
    if (!saved) throw fail(409, 'Website changed. Reload before saving.');
    await audit(req, 'update website', 'Branding, sections, navigation and content');
    res.json(saved);
  });

  app.put('/api/admin/settings', async (req, res) => {
    let next;
    try {
      next = cleanSettings(req.body, await settings());
    } catch (e) {
      throw fail(400, e.message);
    }
    if (next.checkoutEnabled && (!next.supportEmail || !next.deliveryEstimate)) throw fail(400, 'Configure support email and delivery information before opening checkout.');
    if (next.checkoutEnabled) {
      const hello = await mongoose.connection.db.admin().command({ hello: 1 });
      if (!hello.setName && hello.msg !== 'isdbgrid') throw fail(400, 'Checkout requires a MongoDB replica set for safe inventory transactions.');
    }
    await Setting.updateOne({ key: 'store' }, { $set: { value: next } }, { upsert: true });
    await audit(req, 'update settings', 'Store controls and delivery');
    res.json(next);
  });

  app.put('/api/admin/orders/:id', async (req, res) => {
    const session = await mongoose.startSession();
    let result;
    try {
      await session.withTransaction(async () => {
        const order = await Order.findById(req.params.id).session(session);
        if (!order) throw fail(404, 'Order not found.');
        if (req.body._version !== order.__v) throw fail(409, 'Order changed. Reload before saving.');
        const next = req.body.status || order.status;
        const transitions = { pending_payment: ['cancelled'], confirmed: ['processing', 'cancelled'], processing: ['shipped', 'cancelled'], shipped: ['delivered'], delivered: [], cancelled: [] };
        if (next !== order.status && !transitions[order.status].includes(next)) throw fail(400, 'Invalid order status transition.');
        if (next === 'cancelled' && order.status !== 'cancelled') {
          const stockTaken = order.paymentMethod !== 'safepay' || order.paymentStatus === 'paid';
          if (stockTaken) {
            for (const item of order.items) item.size
              ? await Product.updateOne({ _id: item.productId, 'sizes.label': item.size }, { $inc: { 'sizes.$.stock': item.quantity, __v: 1 } }, { session })
              : await Product.updateOne({ _id: item.productId }, { $inc: { stock: item.quantity, __v: 1 } }, { session });
            if (order.coupon) await Coupon.updateOne({ code: order.coupon, used: { $gt: 0 } }, { $inc: { used: -1 } }, { session });
          }
          order.cancelledAt = new Date();
        }
        order.set(pick(req.body, ['trackingNumber', 'courier', 'adminNote']));
        order.status = next;
        order.increment();
        await order.save({ session });
        await audit(req, 'update order', order.reference + ' ' + next, session);
        result = order;
      });
      res.json(result);
    } finally {
      await session.endSession();
    }
  });

  // Small counts for the admin menu badges; the admin polls this so new orders and reviews show up without a reload.
  app.get('/api/admin/badges', async (req, res) => res.json({ newOrders: await Order.countDocuments({ unseen: true }), pendingReviews: await Review.countDocuments({ ...active, status: 'pending' }) }));

  // Opening an order marks it seen. This must not change its version, so an order form that is already open can still be saved.
  app.post('/api/admin/orders/seen-all', async (req, res) => {
    const result = await Order.updateMany({ unseen: true }, { $set: { unseen: false } }, { timestamps: false });
    res.json({ cleared: result.modifiedCount });
  });
  app.post('/api/admin/orders/:id/seen', async (req, res) => {
    await Order.updateOne({ _id: req.params.id, unseen: true }, { $set: { unseen: false } }, { timestamps: false });
    res.json({ ok: true });
  });

  // PostEx: the admin form uses this to know whether booking is set up and which city PostEx will use.
  app.get('/api/admin/postex/cities', async (req, res) => {
    if (!postexConfigured()) return res.json({ configured: false, cities: [], match: '' });
    const cities = await postexCities();
    res.json({ configured: true, cities, match: matchCity(String(req.query.city || ''), cities) });
  });

  app.post('/api/admin/orders/:id/postex', async (req, res) => {
    if (!postexConfigured()) throw fail(400, 'PostEx is not set up yet. Add POSTEX_API_TOKEN to the server settings.');
    const chosenCity = typeof req.body.cityName === 'string' ? req.body.cityName.trim().slice(0, 100) : '';
    // Claim the order first so a double click can't book it twice. A claim stuck for 2+ minutes can be retaken.
    const claimable = [{ postexState: { $in: ['', 'cancelled'] } }, { postexState: { $exists: false } }, { postexState: 'booking', postexClaimedAt: { $lt: new Date(Date.now() - 2 * 60000) } }];
    const order = await Order.findOneAndUpdate({ _id: req.params.id, status: { $in: ['confirmed', 'processing'] }, $or: claimable }, { $set: { postexState: 'booking', postexClaimedAt: new Date() } }, { new: true });
    if (!order) {
      const current = await Order.findById(req.params.id).select('status postexState');
      if (!current) throw fail(404, 'Order not found.');
      if (current.postexState === 'booked') throw fail(409, 'This order is already booked with PostEx.');
      if (current.postexState === 'booking') throw fail(409, 'A PostEx booking for this order is already in progress.');
      throw fail(400, 'Only confirmed or processing orders can be booked with PostEx.');
    }
    let created;
    try {
      const cities = await postexCities();
      // With PostEx's city list we insist on an exact match; if the list couldn't be loaded we send the city as typed.
      const city = cities.length ? matchCity(chosenCity || order.customer.city, cities) : (chosenCity || order.customer.city);
      if (!city) throw fail(422, 'PostEx does not recognise the city "' + (chosenCity || order.customer.city) + '". Choose the delivery city from the list and try again.');
      created = { ...(await createPostexOrder(order, city)), city };
    } catch (error) {
      await Order.updateOne({ _id: order._id, postexState: 'booking' }, { $set: { postexState: '' }, $unset: { postexClaimedAt: 1 } });
      throw error;
    }
    const saved = await Order.findOneAndUpdate({ _id: order._id }, { $set: { postexState: 'booked', postexTracking: created.trackingNumber, postexCity: created.city, postexBookedAt: new Date(), courier: 'PostEx', trackingNumber: created.trackingNumber, ...(order.status === 'confirmed' ? { status: 'processing' } : {}) }, $unset: { postexClaimedAt: 1 }, $inc: { __v: 1 } }, { new: true }).catch(error => { console.error('PostEx booked order', order.reference, 'as', created.trackingNumber, 'but saving it failed:', error.message); throw error; });
    await audit(req, 'update order', order.reference + ' booked with PostEx ' + created.trackingNumber);
    res.json(saved);
  });

  app.post('/api/admin/orders/:id/postex/cancel', async (req, res) => {
    if (!postexConfigured()) throw fail(400, 'PostEx is not set up yet. Add POSTEX_API_TOKEN to the server settings.');
    const order = await Order.findById(req.params.id);
    if (!order) throw fail(404, 'Order not found.');
    if (order.postexState !== 'booked' || !order.postexTracking) throw fail(400, 'This order has no active PostEx booking.');
    await cancelPostexOrder(order.postexTracking);
    const saved = await Order.findOneAndUpdate({ _id: order._id }, { $set: { postexState: 'cancelled', ...(order.courier === 'PostEx' ? { courier: '', trackingNumber: '' } : {}) }, $unset: { postexTracking: 1, postexCity: 1, postexBookedAt: 1 }, $inc: { __v: 1 } }, { new: true });
    await audit(req, 'update order', order.reference + ' PostEx booking ' + order.postexTracking + ' cancelled');
    res.json(saved);
  });

  app.get('/api/admin/customers', async (req, res) => {
    const { page, limit } = pagination(req);
    const q = String(req.query.q || '').trim().slice(0, 200);
    const rows = await Order.aggregate([
      { $match: q ? { 'customer.email': { $regex: escapeRegex(q), $options: 'i' } } : {} },
      { $group: { _id: '$customer.email', name: { $last: '$customer.name' }, orders: { $sum: 1 }, spent: { $sum: { $cond: [{ $in: ['$status', ['cancelled', 'pending_payment']] }, 0, '$total'] } }, lastOrder: { $max: '$createdAt' } } },
      { $sort: { lastOrder: -1 } },
      { $facet: { items: [{ $skip: (page - 1) * limit }, { $limit: limit }], count: [{ $count: 'total' }] } },
    ]);
    const total = rows[0]?.count[0]?.total || 0;
    res.json({ items: rows[0]?.items || [], total, page, pages: Math.max(1, Math.ceil(total / limit)) });
  });

  const bucket = () => new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'images' });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 2, fieldSize: 1000, parts: 3 } });
  app.get('/api/admin/images', async (req, res) => {
    const { page, limit } = pagination(req);
    const files = mongoose.connection.db.collection('images.files');
    const filter = { 'metadata.archived': req.query.archived === 'true' ? true : { $ne: true } };
    res.json({ items: (await files.find(filter).sort({ uploadDate: -1 }).skip((page - 1) * limit).limit(limit).toArray()).map(f => ({ ...f, url: '/api/images/' + f._id })), page, pages: Math.max(1, Math.ceil(await files.countDocuments(filter) / limit)), total: await files.countDocuments(filter) });
  });
  app.post('/api/admin/images', upload.single('image'), inputGuard, async (req, res) => {
    const b = req.file?.buffer;
    const png = b?.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = b?.[0] === 255 && b?.[1] === 216 && b?.[2] === 255;
    const webp = b?.toString('ascii', 0, 4) === 'RIFF' && b?.toString('ascii', 8, 12) === 'WEBP';
    const contentType = png ? 'image/png' : jpeg ? 'image/jpeg' : webp ? 'image/webp' : null;
    if (!contentType) throw fail(400, 'Upload a PNG, JPEG or WebP, up to 8 MB.');
    let cleanImage;
    try {
      cleanImage = await sharp(b, { limitInputPixels: 25000000, animated: false }).rotate().toFormat(png ? 'png' : jpeg ? 'jpeg' : 'webp').toBuffer();
    } catch {
      throw fail(400, 'The image is invalid or too large.');
    }
    const stream = bucket().openUploadStream(crypto.randomUUID(), { metadata: { contentType, originalName: req.file.originalname.slice(0, 200), alt: String(req.body.alt || '').slice(0, 500), archived: false } });
    await new Promise((resolve, reject) => {
      stream.on('finish', resolve);
      stream.on('error', reject);
      stream.end(cleanImage);
    });
    await audit(req, 'upload image', String(stream.id));
    res.status(201).json({ _id: stream.id, url: '/api/images/' + stream.id });
  });
  app.put('/api/admin/images/:id', async (req, res) => {
    const alt = String(req.body.alt || '').slice(0, 500);
    const r = await mongoose.connection.db.collection('images.files').updateOne({ _id: new mongoose.Types.ObjectId(req.params.id) }, { $set: { 'metadata.alt': alt } });
    if (!r.matchedCount) throw fail(404, 'Image not found.');
    await audit(req, 'update image', req.params.id);
    res.json({ message: 'Image description saved.' });
  });
  app.post('/api/admin/images/:id/archive', async (req, res) => {
    const result = await mongoose.connection.db.collection('images.files').updateOne({ _id: new mongoose.Types.ObjectId(req.params.id) }, { $set: { 'metadata.archived': req.body.restore !== true } });
    if (!result.matchedCount) throw fail(404, 'Image not found.');
    await audit(req, req.body.restore ? 'restore image' : 'archive image', req.params.id);
    res.json({ message: 'Library visibility updated. Existing website placements keep working.' });
  });
  app.delete('/api/admin/images/:id', async (req, res) => {
    try {
      await bucket().delete(new mongoose.Types.ObjectId(req.params.id));
    } catch (e) {
      if (/FileNotFound/i.test(e.message)) throw fail(404, 'Image not found.');
      throw e;
    }
    const { lines } = await cleanUpReferences('images', { _id: req.params.id });
    await audit(req, 'delete image', req.params.id + (lines.length ? ' (' + lines.join('; ') + ')' : ''));
    res.json({ message: 'Image permanently deleted.', cleaned: lines });
  });
  app.get('/api/images/:id', async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw fail(404, 'Image not found.');
    const id = new mongoose.Types.ObjectId(req.params.id);
    const [file] = await bucket().find({ _id: id }).toArray();
    if (!file) throw fail(404, 'Image not found.');
    res.type(file.metadata.contentType);
    res.set('Cache-Control', 'public, max-age=86400');
    bucket().openDownloadStream(id).on('error', () => res.destroy()).pipe(res);
  });

  app.use('/api', (req, res, next) => next(fail(404, 'Endpoint not found.')));
  app.get('/', (req, res) => res.json({ service: 'MIVORAX API', health: '/api/health' }));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const mongoValidation = err instanceof mongoose.Error.ValidationError || err instanceof mongoose.Error.CastError || err instanceof mongoose.Error.StrictModeError;
    const transactionIssue = /Transaction numbers|replica set/i.test(err.message);
    const status = err.status || (err.code === 11000 ? 409 : mongoValidation || err instanceof multer.MulterError ? 400 : transactionIssue ? 503 : 500);
    const message = err.type === 'entity.parse.failed' ? 'Invalid JSON request.'
      : err.type === 'entity.too.large' ? 'Request is too large.'
      : err.status && err.status < 500 ? err.message
      : err.code === 11000 ? 'That slug or code already exists.'
      : mongoValidation ? 'Please review the submitted fields.'
      : err instanceof multer.MulterError ? 'Image exceeds upload limits.'
      : transactionIssue ? 'MongoDB must run as a replica set for order transactions.'
      : 'The request could not be completed.';
    if (status >= 500) console.error('Request failed:', req.method, req.path, status, '-', err.message);
    res.status(status).json({ error: message });
  });

  return app;
}
