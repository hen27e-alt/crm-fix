'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeFirestore } = require('./helpers/fakeFirestore');
const { config, paidOrder, ev } = require('./helpers/fixtures');
const { processPaymentEvent, handleWebhook } = require('../src/webhook');

const NOW = new Date('2026-06-01T12:00:00Z');
const DAY = 86400000;
const proc = (db, event, now = NOW) => processPaymentEvent({ db, config, event, now });

function setup(orderOver = {}, member = null) {
  const db = new FakeFirestore();
  db.seed('orders/ord1', paidOrder(orderOver));
  if (member) db.seed('members/u1', member);
  return db;
}
const ent = (db, f) => db.read(`users/u1/entitlements/${f}`);

test('paid: marks order paid, grants entitlement, updates club, stores receipt + txn uid', async () => {
  const db = setup();
  const r = await proc(db, ev());
  assert.equal(r.result, 'paid');
  const o = db.read('orders/ord1');
  assert.equal(o.status, 'paid');
  assert.equal(o.paidAt.getTime(), NOW.getTime());
  assert.equal(o.providerTxnUid, 'txn-1');
  assert.equal(o.receiptUrl, 'https://receipts.example/r1');
  const e = ent(db, 'feat_a');
  assert.deepEqual([e.feature, e.productId, e.orderId, e.expiresAt], ['feat_a', 'p1', 'ord1', null]);
  const m = db.read('members/u1');
  assert.deepEqual([m.points, m.lifetimeSpendAgorot, m.ordersCount, m.tier], [200, 20000, 1, 'silver']);
});

test('paid: time-limited access expires accessDays*qty days from payment; lifetime wins; extends remaining time', async () => {
  const db = setup({
    items: [
      { productId: 'p2', name: 'ב', priceAgorot: 10000, qty: 2, grants: ['feat_b'], accessDays: 30 },
      { productId: 'p1', name: 'א', priceAgorot: 10000, qty: 1, grants: ['feat_a'], accessDays: null },
    ],
  });
  db.seed('users/u1/entitlements/feat_b', { feature: 'feat_b', productId: 'old', orderId: 'older', grantedAt: NOW, expiresAt: new Date(NOW.getTime() + 10 * DAY) });
  await proc(db, ev());
  assert.equal(ent(db, 'feat_b').expiresAt.getTime(), NOW.getTime() + (10 + 60) * DAY);
  assert.equal(ent(db, 'feat_b').orderId, 'ord1');
  assert.equal(ent(db, 'feat_a').expiresAt, null);
});

test('paid: an expired entitlement restarts from now; an existing lifetime one is not shortened', async () => {
  const db = setup({ items: [{ productId: 'p2', name: 'ב', priceAgorot: 20000, qty: 1, grants: ['feat_b', 'feat_c'], accessDays: 30 }] });
  db.seed('users/u1/entitlements/feat_b', { feature: 'feat_b', productId: 'o', orderId: 'x', grantedAt: NOW, expiresAt: new Date(NOW.getTime() - DAY) });
  db.seed('users/u1/entitlements/feat_c', { feature: 'feat_c', productId: 'o', orderId: 'x', grantedAt: NOW, expiresAt: null });
  await proc(db, ev());
  assert.equal(ent(db, 'feat_b').expiresAt.getTime(), NOW.getTime() + 30 * DAY);
  assert.equal(ent(db, 'feat_c').expiresAt, null);
  assert.equal(ent(db, 'feat_c').orderId, 'x');
});

test('club progression uses existing member totals and can change tier', async () => {
  const db = setup({}, { points: 50, lifetimeSpendAgorot: 45000, ordersCount: 3, tier: 'silver', updatedAt: NOW });
  await proc(db, ev());
  const m = db.read('members/u1');
  assert.deepEqual([m.points, m.lifetimeSpendAgorot, m.ordersCount, m.tier], [250, 65000, 4, 'gold']);
});

test('idempotency: replaying the same paid event changes nothing (no double points/entitlement)', async () => {
  const db = setup();
  await proc(db, ev());
  const snapshot = JSON.stringify([db.read('orders/ord1'), db.read('members/u1'), ent(db, 'feat_a')]);
  const r2 = await proc(db, ev(), new Date(NOW.getTime() + 5000));
  assert.equal(r2.result, 'noop');
  assert.equal(JSON.stringify([db.read('orders/ord1'), db.read('members/u1'), ent(db, 'feat_a')]), snapshot);
  assert.equal(db.read('members/u1').points, 200);
});

test('idempotency under CONCURRENT duplicate deliveries: exactly one wins', async () => {
  const db = setup();
  const results = await Promise.all(Array.from({ length: 8 }, () => proc(db, ev())));
  assert.equal(results.filter((r) => r.result === 'paid').length, 1);
  assert.equal(results.filter((r) => r.result === 'noop').length, 7);
  const m = db.read('members/u1');
  assert.deepEqual([m.points, m.ordersCount, m.lifetimeSpendAgorot], [200, 1, 20000]);
  assert.ok(db.txRetries > 0, 'the fake must have exercised conflict retries');
});

test('wrong amount is rejected: order stays pending, nothing granted, anomaly flagged', async () => {
  const db = setup();
  const r = await proc(db, ev({ amountAgorot: 100 }));
  assert.equal(r.result, 'rejected');
  assert.equal(db.read('orders/ord1').status, 'pending');
  assert.equal(db.read('orders/ord1').webhookAnomaly, 'amount_or_currency_mismatch');
  assert.equal(ent(db, 'feat_a'), undefined);
  assert.equal(db.read('members/u1'), undefined);
});

test('amount above the order total, wrong currency, or unparseable amount are all rejected', async () => {
  for (const bad of [{ amountAgorot: 20001 }, { currency: 'USD' }, { currency: '' }, { amountAgorot: null }, { amountAgorot: 19999 }]) {
    const db = setup();
    assert.equal((await proc(db, ev(bad))).result, 'rejected', JSON.stringify(bad));
    assert.equal(db.read('orders/ord1').status, 'pending');
  }
});

test('the webhook cannot dictate entitlements or points: event extras are ignored', async () => {
  const db = setup();
  await proc(db, { ...ev(), grants: ['premium_everything'], points: 99999, items: [{ productId: 'x' }], totalAgorot: 1 });
  assert.equal(ent(db, 'premium_everything'), undefined);
  assert.equal(db.read('members/u1').points, 200);
});

test('paid then failed does NOT downgrade (out-of-order / replay)', async () => {
  const db = setup();
  await proc(db, ev());
  const r = await proc(db, ev({ status: 'failed', reason: '999 declined', amountAgorot: null }));
  assert.equal(r.result, 'noop');
  assert.equal(db.read('orders/ord1').status, 'paid');
  assert.ok(ent(db, 'feat_a'));
});

test('failed then paid (customer retried on the same page) becomes paid', async () => {
  const db = setup();
  assert.equal((await proc(db, ev({ status: 'failed', reason: '051 insufficient funds', amountAgorot: null }))).result, 'failed');
  assert.equal(db.read('orders/ord1').status, 'failed');
  assert.match(db.read('orders/ord1').failedReason, /051/);
  await proc(db, ev());
  const o = db.read('orders/ord1');
  assert.equal(o.status, 'paid');
  assert.equal(o.failedReason, null);
  assert.ok(ent(db, 'feat_a'));
});

test('cancelled order that the provider confirms as paid is honoured', async () => {
  const db = setup({ status: 'cancelled' });
  assert.equal((await proc(db, ev())).result, 'paid');
});

test('failure: pending -> failed, repeated failure is a no-op, no entitlements', async () => {
  const db = setup();
  await proc(db, ev({ status: 'failed', reason: 'declined', amountAgorot: null, currency: '' }));
  assert.equal(db.read('orders/ord1').status, 'failed');
  assert.equal((await proc(db, ev({ status: 'failed', reason: 'again' }))).result, 'noop');
  assert.equal(db.list('users/').length, 0);
});

test('unknown order and provider-ref mismatch are ignored, nothing written', async () => {
  const db = setup();
  assert.equal((await proc(db, ev({ orderId: 'nope' }))).result, 'ignored');
  assert.equal((await proc(db, ev({ providerRef: 'some-other-page' }))).result, 'ignored');
  assert.equal(db.read('orders/ord1').status, 'pending');
  assert.equal((await proc(db, { orderId: 'x', status: 'weird' })).result, 'ignored');
  assert.equal((await proc(db, null)).result, 'ignored');
});

test('order without a stored providerRef still processes (ref is cross-checked only when both exist)', async () => {
  const db = setup({ providerRef: undefined });
  assert.equal((await proc(db, ev())).result, 'paid');
});

test('refund (full): order refunded, entitlements of THIS order revoked, points/spend reversed, tier recomputed', async () => {
  const db = setup();
  await proc(db, ev());
  assert.ok(ent(db, 'feat_a'));
  const r = await proc(db, ev({ status: 'refunded' }), new Date(NOW.getTime() + DAY));
  assert.deepEqual([r.result, r.revoked], ['refunded', ['feat_a']]);
  const o = db.read('orders/ord1');
  assert.equal(o.status, 'refunded');
  assert.equal(o.refundedAgorot, 20000);
  assert.equal(ent(db, 'feat_a'), undefined);
  const m = db.read('members/u1');
  assert.deepEqual([m.points, m.lifetimeSpendAgorot, m.ordersCount, m.tier], [0, 0, 0, 'member']);
});

test('refund is terminal and idempotent; a later paid/failed replay cannot resurrect the order', async () => {
  const db = setup();
  await proc(db, ev());
  await proc(db, ev({ status: 'refunded' }));
  assert.equal((await proc(db, ev({ status: 'refunded' }))).result, 'noop');
  assert.equal((await proc(db, ev())).result, 'noop');
  assert.equal((await proc(db, ev({ status: 'failed' }))).result, 'noop');
  assert.equal(db.read('orders/ord1').status, 'refunded');
  assert.equal(ent(db, 'feat_a'), undefined);
  assert.equal(db.read('members/u1').points, 0);
});

test('refund does not revoke an entitlement now owned by a later order, and never drives counters negative', async () => {
  const db = setup({}, null);
  await proc(db, ev());
  db.seed('users/u1/entitlements/feat_a', { feature: 'feat_a', productId: 'p1', orderId: 'LATER', grantedAt: NOW, expiresAt: null });
  db.seed('members/u1', { points: 5, lifetimeSpendAgorot: 100, ordersCount: 0, tier: 'member', updatedAt: NOW });
  await proc(db, ev({ status: 'refunded' }));
  assert.equal(ent(db, 'feat_a').orderId, 'LATER');
  const m = db.read('members/u1');
  assert.deepEqual([m.points, m.lifetimeSpendAgorot, m.ordersCount], [0, 0, 0]);
});

test('refund for an order that was never paid is ignored; wrong refund amount rejected; partial flagged for review', async () => {
  const db = setup();
  assert.equal((await proc(db, ev({ status: 'refunded' }))).result, 'ignored');
  await proc(db, ev());
  assert.equal((await proc(db, ev({ status: 'refunded', amountAgorot: 30000 }))).result, 'rejected');
  assert.equal((await proc(db, ev({ status: 'refunded', currency: 'USD' }))).result, 'rejected');
  assert.equal(db.read('orders/ord1').status, 'paid');
  assert.equal((await proc(db, ev({ status: 'refunded', amountAgorot: 5000 }))).result, 'partial_refund_flagged');
  const o = db.read('orders/ord1');
  assert.deepEqual([o.status, o.lastPartialRefundAgorot, o.needsManualReview], ['paid', 5000, true]);
  assert.ok(ent(db, 'feat_a'));
});

test('order of a deleted account: paid is recorded, but no user/member/entitlement data is created', async () => {
  const db = setup({ uid: 'deleted' });
  assert.equal((await proc(db, ev())).result, 'paid');
  assert.equal(db.read('orders/ord1').status, 'paid');
  assert.equal(db.list('users/').length + db.list('members/').length, 0);
});

// ---------------- HTTP layer ----------------
function mkRes() {
  const res = { statusCode: null, body: null, headers: {} };
  res.status = (c) => ((res.statusCode = c), res);
  res.json = (b) => ((res.body = b), res);
  res.set = (k, v) => ((res.headers[k] = v), res);
  return res;
}
const providerReturning = (v) => ({ verifyWebhook: () => v });

test('HTTP: non-POST -> 405; bad signature -> 401 and nothing is processed', async () => {
  const db = setup();
  let res = mkRes();
  await handleWebhook({ req: { method: 'GET' }, res, provider: providerReturning({ ok: true, event: ev() }), db, config });
  assert.equal(res.statusCode, 405);
  res = mkRes();
  await handleWebhook({ req: { method: 'POST' }, res, provider: providerReturning({ ok: false, reason: 'bad_signature' }), db, config });
  assert.equal(res.statusCode, 401);
  assert.equal(db.read('orders/ord1').status, 'pending');
});

test('HTTP: valid event -> 200 and processed; replay -> 200 again; rejected amount -> still 200 (no endless retries)', async () => {
  const db = setup();
  let res = mkRes();
  await handleWebhook({ req: { method: 'POST' }, res, provider: providerReturning({ ok: true, event: ev({ amountAgorot: 5 }) }), db, config });
  assert.equal(res.statusCode, 200);
  assert.equal(db.read('orders/ord1').status, 'pending');
  for (let i = 0; i < 2; i++) {
    res = mkRes();
    await handleWebhook({ req: { method: 'POST' }, res, provider: providerReturning({ ok: true, event: ev() }), db, config });
    assert.equal(res.statusCode, 200);
  }
  assert.equal(db.read('orders/ord1').status, 'paid');
  assert.equal(db.read('members/u1').ordersCount, 1);
});

test('HTTP: signed message without a payment event -> 200 ignored; internal failure -> 500 (provider retries; processing is idempotent)', async () => {
  const db = setup();
  let res = mkRes();
  await handleWebhook({ req: { method: 'POST' }, res, provider: providerReturning({ ok: true, event: null }), db, config });
  assert.equal(res.statusCode, 200);
  res = mkRes();
  const brokenDb = { collection: () => { throw new Error('db down'); } };
  await handleWebhook({ req: { method: 'POST' }, res, provider: providerReturning({ ok: true, event: ev() }), db: brokenDb, config });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { ok: false });
});

test('HTTP: provider misconfiguration (no secret) -> 500, not 401', async () => {
  const db = setup();
  const res = mkRes();
  await handleWebhook({ req: { method: 'POST' }, res, provider: providerReturning({ ok: false, reason: 'not_configured' }), db, config });
  assert.equal(res.statusCode, 500);
});
