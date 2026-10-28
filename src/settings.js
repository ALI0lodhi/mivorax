import { safepayConfigured } from './safepay.js';

export const defaultSettings = {
  codEnabled: true, prepaidEnabled: false, checkoutEnabled: false, customizerEnabled: false, referralsEnabled: false,
  journalEnabled: true, reviewsEnabled: false,
  country: 'Pakistan', currency: 'PKR', shippingFee: 250, freeShippingThreshold: 5000,
  deliveryEstimate: 'Delivery estimate confirmed before dispatch', supportEmail: '', supportPhone: '', supportAddress: '',
};
export function cleanSettings(input, current = defaultSettings) {
  const next = { ...current };
  const flags = ['codEnabled', 'checkoutEnabled', 'journalEnabled', 'reviewsEnabled'];
  for (const key of flags) if (key in input) {
    if (typeof input[key] !== 'boolean') throw Error(`${key} must be true or false.`);
    next[key] = input[key];
  }
  // Online payments can only be enabled once Safepay is configured.
  if ('prepaidEnabled' in input) {
    if (typeof input.prepaidEnabled !== 'boolean') throw Error('prepaidEnabled must be true or false.');
    if (input.prepaidEnabled && !safepayConfigured()) throw Error('Add your Safepay keys (SAFEPAY_API_KEY, SAFEPAY_V1_SECRET, SAFEPAY_WEBHOOK_SECRET) to the server before enabling online payments.');
    next.prepaidEnabled = input.prepaidEnabled;
  }
  for (const key of ['shippingFee', 'freeShippingThreshold']) if (key in input) {
    if (!Number.isSafeInteger(input[key]) || input[key] < 0 || input[key] > 100000000) throw Error('Shipping amounts must be non-negative whole PKR values.');
    next[key] = input[key];
  }
  for (const key of ['deliveryEstimate', 'supportEmail', 'supportPhone', 'supportAddress']) if (key in input) {
    if (typeof input[key] !== 'string' || input[key].length > 1000) throw Error(`Invalid ${key}.`);
    next[key] = input[key].trim();
  }
  if (next.supportEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.supportEmail)) throw Error('Enter a valid support email.');
  if (input.customizerEnabled || input.referralsEnabled) throw Error('Customization and referrals need their remaining implementation before enabling.');
  // Force online payment off if the Safepay keys are gone.
  return { ...next, prepaidEnabled: next.prepaidEnabled && safepayConfigured(), customizerEnabled: false, referralsEnabled: false, country: 'Pakistan', currency: 'PKR' };
}
