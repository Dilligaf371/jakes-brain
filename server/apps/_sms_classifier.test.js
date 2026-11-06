// Run: node --test server/apps/_sms_classifier.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySms } from './_sms_classifier.js';

test('one-time codes are never kept', () => {
  assert.equal(classifySms('Careem', 'Your Careem verification code is 482913'), null);
  assert.equal(classifySms('AmazonAE', '123456 is your Amazon OTP. Do not share it.'), null);
  assert.equal(classifySms('UAEPASS', 'Use code 8812 to sign in to UAE PASS'), null);
});

test('bills, deliveries and official matters', () => {
  const bill = classifySms('etisalat', 'Dear customer, your bill of AED 412.50 is due on 15/11.');
  assert.equal(bill.kind, 'bill');
  assert.equal(bill.provider, 'e&');
  assert.equal(bill.done, false);
  assert.equal(classifySms('du', 'Thank you for your payment of AED 299.')?.done, true);
  assert.equal(classifySms('Salik', 'Your Salik balance is low: AED 12. Recharge now.')?.provider, 'Salik');
  const order = classifySms('noon', 'Your order N-123 is out for delivery today.');
  assert.equal(order.kind, 'delivery');
  assert.equal(order.done, false);
  assert.equal(classifySms('AmazonAE', 'Delivered: your package was handed to resident.')?.done, true);
  assert.equal(classifySms('RTA', 'A traffic fine of AED 600 was recorded on plate 12345.')?.kind, 'official');
  assert.equal(classifySms('UAEICP', 'Your Emirates ID application has been approved.')?.provider, 'ICP');
});

test('promos, unknown senders and the "du" prefix trap', () => {
  assert.equal(classifySms('noon', 'Yellow Friday: 70% off your next order!'), null);
  assert.equal(classifySms('+971501234567', 'Your order is out for delivery'), null);
  assert.equal(classifySms('DubaiPolice', 'A traffic fine was recorded.')?.provider, 'Police');
});

test('long digit runs are masked and the ref is stable', () => {
  const a = classifySms('DEWA', 'Bill for account 2003456789 is AED 310, due 20/11.');
  assert.ok(!a.title.includes('2003456789'));
  assert.ok(a.title.includes('••••6789'));
  assert.equal(a.ref, classifySms('DEWA', 'Bill for account  2003456789 is AED 310, due 20/11.').ref);
});
