// PostEx courier (postex.pk): create and cancel shipments from the admin.
// Merchant API: https://api.postex.pk/services/integration/api/order, authenticated with a `token` header.

const postexError = message => Object.assign(new Error(message), { status: 422 });

export function postexConfig(env = process.env) {
 return { token: env.POSTEX_API_TOKEN || '', baseUrl: (env.POSTEX_API_URL || 'https://api.postex.pk').replace(/\/$/, ''), pickupAddressCode: env.POSTEX_PICKUP_ADDRESS_CODE || '', storeAddressCode: env.POSTEX_STORE_ADDRESS_CODE || '' };
}
export const postexConfigured = (env = process.env) => !!postexConfig(env).token;

async function postexRequest(path, { method = 'GET', body } = {}, config = postexConfig()) {
 const url = config.baseUrl + '/services/integration/api/order' + path;
 let res;
 try { res = await fetch(url, { method, headers: { token: config.token, 'Content-Type': 'application/json', Accept: 'application/json' }, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) }); }
 catch (e) { throw postexError('Could not reach PostEx (' + e.message + (e.cause?.message ? ' | ' + e.cause.message : '') + ').'); }
 const text = await res.text().catch(() => '');
 let json = null; try { json = JSON.parse(text); } catch {}
 const refused = json && json.statusCode !== undefined && String(json.statusCode) !== '200';
 if (!res.ok || refused) throw postexError('PostEx: ' + (json?.statusMessage || text.slice(0, 300) || 'HTTP ' + res.status));
 return json;
}

// PostEx only accepts its own city names, so keep a list of the cities it delivers to.
let cityCache = { at: 0, token: '', cities: [] };
export async function postexCities(config = postexConfig()) {
 if (cityCache.cities.length && cityCache.token === config.token && Date.now() - cityCache.at < 6 * 3600 * 1000) return cityCache.cities;
 try {
  const json = await postexRequest('/v2/get-operational-city?operationalCityType=Delivery', {}, config);
  const rows = Array.isArray(json?.dist) ? json.dist : [];
  const cities = [...new Set(rows.map(c => typeof c === 'string' ? c : c?.operationalCityName || c?.cityName || c?.name).filter(Boolean).map(c => String(c).trim()))].sort((a, b) => a.localeCompare(b));
  cityCache = { at: Date.now(), token: config.token, cities };
  return cities;
 } catch (e) { console.log('[postex cities]', e.message); return []; }
}

const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').replace(/\bcity\b/g, '').trim();
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Map what the customer typed ("karachi", "Lahore, Pakistan") onto PostEx's exact city name, or '' if unsure.
export function matchCity(input, cities) {
 if (!input || !cities.length) return '';
 for (const candidate of [input, String(input).split(',')[0]]) {
  const exact = cities.find(c => norm(c) === norm(candidate));
  if (exact) return exact;
 }
 const inside = cities.filter(c => new RegExp('\\b' + escapeRe(c) + '\\b', 'i').test(input));
 return inside.length === 1 ? inside[0] : '';
}

// PostEx wants Pakistani mobiles as 03xxxxxxxxx.
export function normalizePhone(phone) {
 let d = String(phone || '').replace(/\D/g, '');
 if (d.startsWith('0092')) d = d.slice(4);
 else if (d.startsWith('92') && d.length === 12) d = d.slice(2);
 if (d.length === 10 && d.startsWith('3')) d = '0' + d;
 return /^03\d{9}$/.test(d) ? d : '';
}

export function buildBooking(order, cityName, config = postexConfig()) {
 const phone = normalizePhone(order.customer.phone);
 if (!phone) throw postexError('The customer phone number "' + order.customer.phone + '" is not a valid Pakistani mobile number (03xxxxxxxxx). Fix it before booking.');
 const prepaid = order.paymentMethod === 'safepay';
 return {
  cityName,
  customerName: order.customer.name,
  customerPhone: phone,
  deliveryAddress: order.customer.address,
  invoiceDivision: 1,
  // Cash on delivery: PostEx collects the order total. Paid online: nothing to collect.
  invoicePayment: prepaid ? 0 : Math.round(order.total),
  items: order.items.reduce((n, i) => n + i.quantity, 0),
  orderDetail: order.items.map(i => i.name + (i.size ? ' (' + i.size + ')' : '') + ' x' + i.quantity).join(', ').slice(0, 500),
  orderRefNumber: order.reference,
  orderType: 'Normal',
  transactionNotes: prepaid ? 'Paid online. Do not collect cash.' : 'Cash on delivery.',
  pickupAddressCode: config.pickupAddressCode || undefined,
  storeAddressCode: config.storeAddressCode || undefined,
 };
}

export async function createPostexOrder(order, cityName, config = postexConfig()) {
 const json = await postexRequest('/v3/create-order', { method: 'POST', body: buildBooking(order, cityName, config) }, config);
 const trackingNumber = json?.dist?.trackingNumber || json?.trackingNumber;
 if (!trackingNumber) {
  console.log('[postex create-order] no tracking number in response:', JSON.stringify(json).slice(0, 500));
  throw postexError('PostEx did not return a tracking number. Check the order in your PostEx portal before trying again. Response: ' + JSON.stringify(json).slice(0, 200));
 }
 return { trackingNumber: String(trackingNumber) };
}

export async function cancelPostexOrder(trackingNumber, config = postexConfig()) {
 await postexRequest('/v1/cancel-order', { method: 'PUT', body: { trackingNumber } }, config);
}
