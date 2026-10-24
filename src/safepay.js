// Safepay payment gateway (https://getsafepay.pk) — hosted checkout integration.
// Dependency-free port of the official @sfpy/node-sdk flow: create a payment
// tracker, send the shopper to Safepay's hosted page, then confirm the result
// server-to-server (webhook + signed redirect). No card data ever touches us.
import crypto from 'node:crypto';

const API = { sandbox: 'https://sandbox.api.getsafepay.com', production: 'https://api.getsafepay.com', development: 'https://dev.api.getsafepay.com' };
const CHECKOUT = { sandbox: 'https://sandbox.api.getsafepay.com/checkout', production: 'https://getsafepay.com/checkout', development: 'https://dev.api.getsafepay.com/checkout' };

export function safepayConfig(env = process.env) {
 const environment = env.SAFEPAY_ENV === 'production' ? 'production' : env.SAFEPAY_ENV === 'development' ? 'development' : 'sandbox';
 return { environment, apiKey: env.SAFEPAY_API_KEY || '', v1Secret: env.SAFEPAY_V1_SECRET || '', webhookSecret: env.SAFEPAY_WEBHOOK_SECRET || '' };
}
// Online payment is offered only when every Safepay credential is present.
export const safepayConfigured = (env = process.env) => { const c = safepayConfig(env); return !!(c.apiKey && c.v1Secret && c.webhookSecret); };

// Step 1 — ask Safepay to start an order and hand back a tracker token.
// `amount` is in minor units (paisa for PKR); `currency` is 'PKR' or 'USD'.
export async function createPaymentToken({ amount, currency }, config = safepayConfig()) {
 if (!Number.isInteger(amount) || amount <= 0) throw Object.assign(new Error('Invalid payment amount.'), { status: 500 });
 let res;
 try { res = await fetch(API[config.environment] + '/order/v1/init', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount, client: config.apiKey, currency, environment: config.environment }), signal: AbortSignal.timeout(15000) }); }
 catch { throw Object.assign(new Error('Could not reach the payment gateway.'), { status: 502 }); }
 if (!res.ok) throw Object.assign(new Error('The payment gateway rejected the request.'), { status: 502 });
 const json = await res.json().catch(() => null);
 const token = json?.data?.token;
 if (!token || typeof token !== 'string') throw Object.assign(new Error('The payment gateway did not return a token.'), { status: 502 });
 return token;
}

// Step 2 — build the hosted checkout URL to redirect the shopper to.
export function buildCheckoutUrl({ token, orderId, cancelUrl, redirectUrl, source = 'custom', webhooks = true }, config = safepayConfig()) {
 const params = new URLSearchParams({ beacon: token, cancel_url: cancelUrl, env: config.environment, order_id: orderId, redirect_url: redirectUrl, source, webhooks: String(webhooks) });
 return CHECKOUT[config.environment] + '/pay?' + params.toString();
}

const safeEqualHex = (a, b) => { try { const x = Buffer.from(String(a), 'hex'), y = Buffer.from(String(b), 'hex'); return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y); } catch { return false; } };

// Confirm the signed server-to-server redirect: sig === HMAC-SHA256(v1Secret, tracker).
export function verifyRedirect({ sig, tracker }, config = safepayConfig()) {
 if (typeof sig !== 'string' || typeof tracker !== 'string' || !sig || !tracker) return false;
 return safeEqualHex(sig, crypto.createHmac('sha256', config.v1Secret).update(tracker).digest('hex'));
}

// Confirm a webhook delivery: header x-sfpy-signature === HMAC-SHA512(webhookSecret, body).
// Safepay's SDK generations have signed either the raw body or JSON.stringify(data),
// so we accept a match against either to stay compatible with both.
export function verifyWebhook({ signature, rawBody, data }, config = safepayConfig()) {
 if (typeof signature !== 'string' || !signature) return false;
 const candidates = [];
 if (rawBody && rawBody.length) candidates.push(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody));
 if (data !== undefined) candidates.push(Buffer.from(JSON.stringify(data)));
 return candidates.some(buf => safeEqualHex(signature, crypto.createHmac('sha512', config.webhookSecret).update(buf).digest('hex')));
}

// Only treat a webhook as "money captured" on an affirmative success signal — never
// on a mere "created" event — so we never fulfil an order that wasn't actually paid.
// Safepay labels success either in the event name or in a tracker state field.
const PAID_STATES = new Set(['TRACKER_ENDED', 'PAID', 'COMPLETED', 'SUCCEEDED', 'CAPTURED']);
export function isPaidWebhook(type, data) {
 const name = String(type || '').toLowerCase();
 const state = (data?.state || data?.status || '').toString().toUpperCase();
 return /succeeded|paid|captured|complete/.test(name) || PAID_STATES.has(state);
}
