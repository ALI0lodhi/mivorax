import crypto from 'node:crypto';

const API = { sandbox: 'https://sandbox.api.getsafepay.com', production: 'https://api.getsafepay.com', development: 'https://dev.api.getsafepay.com' };
const CHECKOUT = { sandbox: 'https://sandbox.api.getsafepay.com/embedded', production: 'https://getsafepay.com/embedded', development: 'https://dev.api.getsafepay.com/embedded' };

export function safepayConfig(env = process.env) {
 const environment = env.SAFEPAY_ENV === 'production' ? 'production' : env.SAFEPAY_ENV === 'development' ? 'development' : 'sandbox';
 // SAFEPAY_API_KEY = dashboard "Public Key", SAFEPAY_V1_SECRET = dashboard "Secret Key".
 return { environment, apiKey: env.SAFEPAY_API_KEY || '', secretKey: env.SAFEPAY_V1_SECRET || env.SAFEPAY_SECRET_KEY || '', webhookSecret: env.SAFEPAY_WEBHOOK_SECRET || '' };
}
// Demo mode: simulate the gateway locally without a Safepay account. Never active in production.
export const safepayMock = (env = process.env) => env.SAFEPAY_ENV === 'mock' && env.NODE_ENV !== 'production';
export const safepayConfigured = (env = process.env) => { if (safepayMock(env)) return true; const c = safepayConfig(env); return !!(c.apiKey && c.secretKey); };

async function sfpyRequest(url, { method = 'GET', headers = {}, body } = {}) {
 let res;
 try { res = await fetch(url, { method, headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) }); }
 catch (e) { throw Object.assign(new Error('Could not reach Safepay (' + url + '): ' + e.message + (e.cause?.message ? ' | cause: ' + e.cause.message : '')), { status: 502 }); }
 const text = await res.text().catch(() => '');
 let json = null; try { json = JSON.parse(text); } catch {}
 if (!res.ok) throw Object.assign(new Error('Safepay ' + method + ' ' + url + ' returned HTTP ' + res.status + (text ? ': ' + text.slice(0, 400) : '')), { status: 502 });
 return json;
}

// Create a v3 payment tracker. amount is in whole PKR; Cybersource takes minor units, so x100.
export async function createPaymentToken({ amount, currency, orderId }, config = safepayConfig()) {
 const json = await sfpyRequest(API[config.environment] + '/order/payments/v3/', {
  method: 'POST',
  body: { merchant_api_key: config.apiKey, intent: 'CYBERSOURCE', mode: 'payment', currency, amount: Math.round(amount * 100), entry_mode: 'raw', metadata: { order_id: orderId } },
 });
 const token = json?.data?.tracker?.token;
 if (!token || typeof token !== 'string') throw Object.assign(new Error('Safepay did not return a tracker. Response: ' + JSON.stringify(json).slice(0, 300)), { status: 502 });
 return token;
}

// Time-based passport token the hosted checkout needs.
export async function createAuthToken(config = safepayConfig()) {
 const json = await sfpyRequest(API[config.environment] + '/client/passport/v1/token', { method: 'POST', headers: { 'X-SFPY-MERCHANT-SECRET': config.secretKey }, body: {} });
 const tbt = json?.data;
 if (typeof tbt !== 'string' || !tbt) throw Object.assign(new Error('Safepay did not return an auth token. Response: ' + JSON.stringify(json).slice(0, 300)), { status: 502 });
 return tbt;
}

// Hosted v3 checkout URL to redirect the shopper to.
export function buildCheckoutUrl({ tracker, tbt, redirectUrl, cancelUrl }, config = safepayConfig()) {
 const params = new URLSearchParams({ environment: config.environment, tracker, tbt, source: 'hosted', redirect_url: redirectUrl, cancel_url: cancelUrl });
 return CHECKOUT[config.environment] + '/?' + params.toString();
}

const safeEqualHex = (a, b) => { try { const x = Buffer.from(String(a), 'hex'), y = Buffer.from(String(b), 'hex'); return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y); } catch { return false; } };

// Signed redirect (when present): sig = HMAC-SHA256(secretKey, tracker).
export function verifyRedirect({ sig, tracker }, config = safepayConfig()) {
 if (typeof sig !== 'string' || typeof tracker !== 'string' || !sig || !tracker) return false;
 return safeEqualHex(sig, crypto.createHmac('sha256', config.secretKey).update(tracker).digest('hex'));
}
// Webhook: x-sfpy-signature = HMAC-SHA512(webhookSecret, body). Accept raw body or JSON.stringify(data).
export function verifyWebhook({ signature, rawBody, data }, config = safepayConfig()) {
 if (typeof signature !== 'string' || !signature || !config.webhookSecret) return false;
 const candidates = [];
 if (rawBody && rawBody.length) candidates.push(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody));
 if (data !== undefined) candidates.push(Buffer.from(JSON.stringify(data)));
 return candidates.some(buf => safeEqualHex(signature, crypto.createHmac('sha512', config.webhookSecret).update(buf).digest('hex')));
}

const PAID_STATES = new Set(['TRACKER_ENDED', 'PAID', 'COMPLETED', 'SUCCEEDED', 'CAPTURED']);
export function isPaidWebhook(type, data) {
 const name = String(type || '').toLowerCase();
 const state = (data?.state || data?.status || '').toString().toUpperCase();
 return /succeeded|paid|captured|complete/.test(name) || PAID_STATES.has(state);
}

// Ask Safepay for a tracker's state (reporter API, authenticated with the secret key).
// Outbound call, so confirmation works without Safepay reaching us (no public webhook needed).
export async function fetchTrackerState(token, config = safepayConfig()) {
 if (!token) return null;
 try {
  const json = await sfpyRequest(API[config.environment] + '/reporter/api/v1/payments/' + encodeURIComponent(token), { headers: { 'X-SFPY-MERCHANT-SECRET': config.secretKey } });
  return json?.data?.state || null;
 } catch (e) { console.log('[safepay fetchTracker]', e.message); return null; }
}
export async function fetchTrackerPaid(token, config = safepayConfig()) {
 const state = await fetchTrackerState(token, config);
 return !!state && PAID_STATES.has(String(state).toUpperCase());
}
