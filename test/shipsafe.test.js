import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { computeSignals, scoreSignals, verdictFor, looksRandomEmail } from '../src/signals.js';
import { combineScores, parseJson } from '../src/ai.js';
import { sampleOrders, buildCart, shop } from '../src/store.js';
import { app, seed } from '../server.js';

const samples = sampleOrders();
const byId = Object.fromEntries(samples.map((o) => [o.id, o]));
const verdict = (o) => verdictFor(scoreSignals(computeSignals(o, samples, shop)));

test('normal order is safe to ship', () => {
  assert.equal(verdict(byId['MT-1001']), 'SHIP');
});

test('overpayment scam order is held', () => {
  const ids = computeSignals(byId['MT-1002'], samples, shop).map((s) => s.id);
  assert.ok(ids.includes('scam_language'));
  assert.ok(ids.includes('velocity'));
  assert.equal(verdict(byId['MT-1002']), 'HOLD');
});

test('forwarder order is flagged', () => {
  const ids = computeSignals(byId['MT-1003'], samples, shop).map((s) => s.id);
  assert.ok(ids.includes('forwarder_address'));
  assert.ok(ids.includes('country_mismatch'));
  assert.notEqual(verdict(byId['MT-1003']), 'SHIP');
});

test('prompt injection in buyer note is a red flag', () => {
  const ids = computeSignals(byId['MT-1004'], samples, shop).map((s) => s.id);
  assert.ok(ids.includes('prompt_injection'));
  assert.notEqual(verdict(byId['MT-1004']), 'SHIP');
});

test('random-looking emails are detected', () => {
  assert.equal(looksRandomEmail('dbrooks48291736@example.net'), true);
  assert.equal(looksRandomEmail('emily.carter@example.com'), false);
});

test('AI cannot lower the rule score by more than 15', () => {
  assert.equal(combineScores(80, 0), 65);
  assert.equal(combineScores(20, 90), 90);
  assert.equal(combineScores(40, null), 40);
});

test('JSON is extracted from AI text', () => {
  assert.deepEqual(parseJson('Here you go: {"a": 1} thanks'), { a: 1 });
});

test('cart uses server prices and ignores bad input', () => {
  const cart = buildCart([{ id: 'scarf', quantity: 2, price: 0.01 }, { id: 'nope', quantity: 1 }, { id: 'mugs', quantity: -3 }]);
  assert.deepEqual(cart, [{ id: 'scarf', name: 'Hand-dyed Silk Scarf', price: 38, quantity: 2 }]);
});

// ---- End-to-end in simulated PayPal mode ----
let server; let base;
before(async () => {
  await seed();
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('checkout -> capture -> review -> auto-hold -> refund', async () => {
  const created = await (await post('/api/orders', {
    cart: [{ id: 'throw', quantity: 5 }],
    context: { shippingSpeed: 'overnight', buyerNote: 'My shipper will pick up. I will overpay, send the difference.' }
  })).json();
  assert.match(created.id, /^SIM-/);

  const cap = await post(`/api/orders/${created.id}/capture`, { simBuyer: { givenName: 'Chris', surname: 'Vale', email: 'cvale77310428@example.net', payerCountry: 'GB', shipCountry: 'US', addressLine1: '9 Freight Plaza Suite 50317', sellerProtection: 'NOT_ELIGIBLE' } });
  const capData = await cap.json();
  assert.equal(cap.status, 200);
  assert.equal(capData.status, 'PAID');
  assert.equal(capData.review, undefined, 'buyer must not see the risk result');

  const { orders } = await (await fetch(`${base}/api/seller/orders`)).json();
  const order = orders.find((o) => o.id === capData.orderId);
  assert.equal(order.review.verdict, 'HOLD');
  assert.equal(order.status, 'ON_HOLD');

  const refunded = await (await post(`/api/seller/orders/${order.id}/action`, { action: 'refund' })).json();
  assert.equal(refunded.order.status, 'REFUNDED');

  const again = await post(`/api/orders/${created.id}/capture`, {});
  assert.equal(again.status, 404, 'a checkout cannot be captured twice');
});

test('message checker flags overpayment scam', async () => {
  const r = await (await post('/api/seller/check-message', { text: 'I will send a cashier check for more, then refund the extra to my mover.' })).json();
  assert.equal(r.scamLikely, true);
});

test('dashboard page is not reachable as a static file', async () => {
  const res = await fetch(`${base}/dashboard.html`);
  assert.equal(res.status, 404);
});
