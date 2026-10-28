import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, matchCity, buildBooking } from '../src/postex.js';

test('phone numbers are converted to the 03xxxxxxxxx format PostEx expects', () => {
  assert.equal(normalizePhone('03001234567'), '03001234567');
  assert.equal(normalizePhone('+92 300 1234567'), '03001234567');
  assert.equal(normalizePhone('923001234567'), '03001234567');
  assert.equal(normalizePhone('0092-300-1234567'), '03001234567');
  assert.equal(normalizePhone('3001234567'), '03001234567');
  assert.equal(normalizePhone('0211234567'), '');
  assert.equal(normalizePhone('not a phone'), '');
});

test('customer city text is matched to PostEx city names only when unambiguous', () => {
  const cities = ['Karachi', 'Lahore', 'Rawalpindi', 'Islamabad'];
  assert.equal(matchCity('karachi', cities), 'Karachi');
  assert.equal(matchCity('  Lahore City ', cities), 'Lahore');
  assert.equal(matchCity('Lahore, Pakistan', cities), 'Lahore');
  assert.equal(matchCity('DHA Karachi', cities), 'Karachi');
  assert.equal(matchCity('Between Rawalpindi and Islamabad', cities), '');
  assert.equal(matchCity('Atlantis', cities), '');
  assert.equal(matchCity('Karachi', []), '');
});

test('bookings collect cash only for cash-on-delivery orders', () => {
  const base = { reference: 'MVX-ABC', total: 4500, customer: { name: 'Sana Ali', phone: '+923001234567', address: 'House 1, Street 2' }, items: [{ name: 'Kurta', size: 'M', quantity: 2 }, { name: 'Perfume', quantity: 1 }] };
  const cod = buildBooking({ ...base, paymentMethod: 'cod' }, 'Karachi', { pickupAddressCode: 'P1', storeAddressCode: '' });
  assert.equal(cod.invoicePayment, 4500);
  assert.equal(cod.items, 3);
  assert.equal(cod.customerPhone, '03001234567');
  assert.equal(cod.orderRefNumber, 'MVX-ABC');
  assert.equal(cod.pickupAddressCode, 'P1');
  assert.equal(cod.storeAddressCode, undefined);
  assert.match(cod.orderDetail, /Kurta \(M\) x2, Perfume x1/);
  assert.equal(buildBooking({ ...base, paymentMethod: 'safepay' }, 'Karachi', {}).invoicePayment, 0);
  assert.throws(() => buildBooking({ ...base, customer: { ...base.customer, phone: '123' }, paymentMethod: 'cod' }, 'Karachi', {}), /valid Pakistani mobile/);
});
