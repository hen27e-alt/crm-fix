'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeFirestore } = require('./helpers/fakeFirestore');
const { config, paidOrder } = require('./helpers/fixtures');
const { captureOrderCore } = require('../src/capture');
const { handleWebhook } = require('../src/webhook');

const NOW = new Date('2026-06-01T12:00:00Z');
const err = async (p) => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  return null;
};

function setup(over = {}) {
  const db = new FakeFirestore();
  db.seed('orders/ord1', paidOrder({ providerRef: 'PP-1', ...over }));
  return db;
}
const paidEvent = (o = {}) => ({ status: 'paid', orderId: 'ord1', providerRef: 'PP-1', txnUid: 'CAP-1', amountAgorot: 20000, currency: 'ILS', receiptUrl: '', reason: '', ...o });
function fakePaypal(results) {
  const calls = [];
  const p = { calls, capture: async (a) => { calls.push(a); const r = typeof results === 'function' ? results(a, calls.length) : results; if (r instanceof Error) throw r; return r; }, verifyWebhook: () => ({ ok: false }), createPaymentPage: async () => ({}), secrets: [] };
  return p;
}
const run = (db, provider, over = {}) => captureOrderCore({ db, provider, config, orderId: 'ord1', uid: 'u1', now: NOW, ...over });

test('capture: pays the order from the STORED order data and returns paid', async () => {
  const db = setup();
  const provider = fakePaypal({ state: 'event', event: paidEvent() });
  const r = await run(db, provider);
  assert.deepEqual(r, { status: 'paid', orderId: 'ord1' });
  assert.deepEqual(provider.calls[0], { order: { id: 'ord1', totalAgorot: 20000, currency: 'ILS' }, providerRef: 'PP-1' });
  assert.equal(db.read('orders/ord1').status, 'paid');
  assert.equal(db.read('members/u1').points, 200);
  assert.ok(db.read('users/u1/entitlements/feat_a'));
});

test('capture is idempotent: second call does not touch PayPal and does not credit twice', async () => {
  const db = setup();
  const provider = fakePaypal({ state: 'event', event: paidEvent() });
  await run(db, provider);
  const r2 = await run(db, provider);
  assert.deepEqual(r2, { status: 'paid', orderId: 'ord1' });
  assert.equal(provider.calls.length, 1);
  assert.equal(db.read('members/u1').ordersCount, 1);
});

test('capture racing the webhook for the same charge: exactly one credit', async () => {
  const db = setup();
  const { processPaymentEvent } = require('../src/payments');
  const provider = fakePaypal({ state: 'event', event: paidEvent() });
  await Promise.all([run(db, provider), processPaymentEvent({ db, config, event: paidEvent({ eventId: 'WH-1' }), now: NOW }), run(db, provider)]);
  assert.equal(db.read('members/u1').ordersCount, 1);
  assert.equal(db.read('members/u1').points, 200);
  assert.equal(db.read('orders/ord1').webhookAnomaly ?? null, null);
});

test('capture: amount different from the stored total is NOT credited (flagged)', async () => {
  const db = setup();
  const r = await run(db, fakePaypal({ state: 'event', event: paidEvent({ amountAgorot: 100 }) }));
  assert.equal(r.status, 'pending');
  assert.equal(db.read('orders/ord1').needsManualReview, true);
  assert.equal(db.read('members/u1'), undefined);
});

test('capture: wrong owner / unknown order -> the same not-found; deleted account and cancelled orders are not captured', async () => {
  const db = setup();
  const provider = fakePaypal({ state: 'event', event: paidEvent() });
  const e1 = await err(run(db, provider, { uid: 'other' }));
  const e2 = await err(run(db, provider, { orderId: 'nope' }));
  assert.deepEqual([e1.code, e2.code, e1.message === e2.message], ['not-found', 'not-found', true]);
  for (const o of [{ uid: 'deleted' }, { status: 'cancelled' }, { providerRef: undefined }]) {
    const d = setup(o);
    const e = await err(run(d, provider, { uid: o.uid || 'u1' }));
    assert.equal(e.code, 'failed-precondition', JSON.stringify(o));
  }
  assert.equal(provider.calls.length, 0);
});

test('capture: not approved / pending states are returned without changing the order; failure marks failed', async () => {
  let db = setup();
  assert.equal((await run(db, fakePaypal({ state: 'not_approved' }))).status, 'not_approved');
  assert.equal((await run(db, fakePaypal({ state: 'pending' }))).status, 'pending');
  assert.equal(db.read('orders/ord1').status, 'pending');
  const r = await run(db, fakePaypal({ state: 'event', event: paidEvent({ status: 'failed', amountAgorot: 20000, reason: 'paypal DECLINED' }) }));
  assert.equal(r.status, 'failed');
  assert.equal(db.read('orders/ord1').status, 'failed');
  // a failed order can be captured again after the buyer fixes the funding source
  const r2 = await run(db, fakePaypal({ state: 'event', event: paidEvent() }));
  assert.equal(r2.status, 'paid');
});

test('capture: provider failures become a generic unavailable error; expectedProviderRef mismatch is refused', async () => {
  const db = setup();
  const boom = Object.assign(new Error('secret token abc'), { code: 'rejected', name: 'ProviderError' });
  const e = await err(run(db, fakePaypal(boom)));
  assert.equal(e.code, 'unavailable');
  assert.ok(!/secret|abc/.test(e.message));
  const e2 = await err(run(db, fakePaypal({ state: 'event', event: paidEvent() }), { expectedProviderRef: 'SOMEONE-ELSES' }));
  assert.equal(e2.code, 'failed-precondition');
  assert.equal(db.read('orders/ord1').status, 'pending');
  const e3 = await err(captureOrderCore({ db, provider: { createPaymentPage() {}, verifyWebhook() {} }, config, orderId: 'ord1', uid: 'u1' }));
  assert.equal(e3.code, 'failed-precondition');
  assert.equal((await err(run(db, fakePaypal({}), { orderId: '../x' }))).code, 'invalid-argument');
});

// ---------------- webhook backup path: CHECKOUT.ORDER.APPROVED -> server capture ----------------
function mkRes() {
  const res = { statusCode: null, body: null };
  res.status = (c) => ((res.statusCode = c), res);
  res.json = (b) => ((res.body = b), res);
  res.set = () => res;
  return res;
}
const approved = (o = {}) => ({ status: 'approved', orderId: 'ord1', providerRef: 'PP-1', eventId: 'WH-A', amountAgorot: null, currency: '', txnUid: '', receiptUrl: '', reason: '', ...o });
const hook = (db, provider) => { const res = mkRes(); return handleWebhook({ req: { method: 'POST' }, res, provider, db, config, now: NOW }).then(() => res); };

test('webhook APPROVED event captures server-side (buyer closed the tab) and the order becomes paid', async () => {
  const db = setup();
  const cap = fakePaypal({ state: 'event', event: paidEvent() });
  const provider = { ...cap, verifyWebhook: async () => ({ ok: true, event: approved() }) };
  const res = await hook(db, provider);
  assert.equal(res.statusCode, 200);
  assert.equal(db.read('orders/ord1').status, 'paid');
  assert.equal(cap.calls.length, 1);
});

test('webhook APPROVED: provider order id that is not the stored one is not captured (still 200); outage -> 500 (retry)', async () => {
  const db = setup();
  const cap = fakePaypal({ state: 'event', event: paidEvent() });
  let res = await hook(db, { ...cap, verifyWebhook: async () => ({ ok: true, event: approved({ providerRef: 'FOREIGN' }) }) });
  assert.equal(res.statusCode, 200);
  assert.equal(cap.calls.length, 0);
  assert.equal(db.read('orders/ord1').status, 'pending');
  const boom = Object.assign(new Error('x'), { code: 'network', name: 'ProviderError' });
  res = await hook(db, { ...fakePaypal(boom), verifyWebhook: async () => ({ ok: true, event: approved() }) });
  assert.equal(res.statusCode, 500);
  res = await hook(db, { verifyWebhook: async () => ({ ok: true, event: approved() }), createPaymentPage() {} }); // provider without capture()
  assert.equal(res.statusCode, 200);
});

test('webhook: async verifier outage / bad credentials -> 500 (never 200/401), bad signature -> 401', async () => {
  const db = setup();
  for (const [reason, code] of [['verify_unavailable', 500], ['not_configured', 500], ['bad_signature', 401]]) {
    const res = await hook(db, { verifyWebhook: async () => ({ ok: false, reason }) });
    assert.equal(res.statusCode, code, reason);
  }
});
