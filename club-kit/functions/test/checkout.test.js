'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeFirestore } = require('./helpers/fakeFirestore');
const { config, seedProducts, fakeProvider } = require('./helpers/fixtures');
const { createCheckoutCore, createCheckoutSafe } = require('../src/checkout');
const { HttpsError } = require('../src/errors');

const WEBHOOK = 'https://europe-west1-demo.cloudfunctions.net/paymentWebhook';
const NOW = new Date('2026-06-01T12:00:00Z');
const run = (db, provider, data, extra = {}) => createCheckoutCore({ db, provider, config, uid: 'u1', token: { email: 'a@b.co', phone_number: '+972501234567' }, data, now: NOW, webhookUrl: WEBHOOK, ...extra });
const cart = (items) => ({ items, consent: true });
const codeOf = async (p) => {
  try {
    await p;
  } catch (e) {
    return e.code;
  }
  return null;
};

function setup() {
  const db = new FakeFirestore();
  seedProducts(db);
  db.seed('users/u1', { displayName: 'דנה', marketingConsent: false, createdAt: NOW, adult: true, ageDeclaredAt: NOW });
  return { db, provider: fakeProvider() };
}

test('happy path: server-side price, order stored as pending, URL returned, provider called with safe args', async () => {
  const { db, provider } = setup();
  const r = await run(db, provider, { ...cart([{ productId: 'p1', qty: 2 }, { productId: 'p2', qty: 1 }]), priceAgorot: 1, totalAgorot: 1 });
  assert.match(r.orderId, /^[A-Za-z0-9_-]{20}$/);
  assert.equal(r.paymentUrl, 'https://payments.payplus.co.il/pay/abc');
  const o = db.read('orders/' + r.orderId);
  assert.equal(o.status, 'pending');
  assert.equal(o.uid, 'u1');
  assert.equal(o.appId, 'test-site');
  assert.equal(o.subtotalAgorot, 22500);
  assert.equal(o.discountAgorot, 0);
  assert.equal(o.totalAgorot, 22500);
  assert.equal(o.currency, 'ILS');
  assert.equal(o.memberTier, 'member');
  assert.equal(o.providerRef, 'page-req-1');
  assert.equal(o.consent, true);
  assert.deepEqual(o.items.map((i) => [i.productId, i.priceAgorot, i.qty]), [['p1', 10000, 2], ['p2', 2500, 1]]);
  const call = provider.calls[0];
  assert.equal(call.order.totalAgorot, 22500);
  assert.equal(call.order.id, r.orderId);
  assert.equal(call.webhookUrl, WEBHOOK);
  assert.equal(call.successUrl, `https://shop.example.com/?checkout=success&order=${r.orderId}`);
  assert.equal(call.cancelUrl, `https://shop.example.com/?checkout=cancel&order=${r.orderId}`);
  assert.equal(call.customer.phone, '+972501234567');
  assert.equal(call.customer.name, 'דנה');
  assert.equal(db.read('users/u1').termsAcceptedAt.getTime(), NOW.getTime());
});

test('tier discount is applied from lifetime spend (silver 5%, gold 10%)', async () => {
  for (const [spend, pct, total, tier] of [[20000, 5, 9500, 'silver'], [60000, 10, 9000, 'gold'], [19999, 0, 10000, 'member']]) {
    const { db, provider } = setup();
    db.seed('members/u1', { points: 0, lifetimeSpendAgorot: spend, ordersCount: 1, tier: 'ignored-by-server', updatedAt: NOW });
    const r = await run(db, provider, cart([{ productId: 'p1', qty: 1 }]));
    const o = db.read('orders/' + r.orderId);
    assert.equal(o.discountPct, pct);
    assert.equal(o.totalAgorot, total);
    assert.equal(o.memberTier, tier);
  }
});

test('with a discount the provider gets the discounted total', async () => {
  const { db, provider } = setup();
  db.seed('members/u1', { points: 0, lifetimeSpendAgorot: 60000, ordersCount: 3, tier: 'gold', updatedAt: NOW });
  await run(db, provider, cart([{ productId: 'p1', qty: 1 }]));
  assert.equal(provider.calls[0].order.discountAgorot, 1000);
  assert.equal(provider.calls[0].order.totalAgorot, 9000);
});

test('unknown / inactive products and missing consent are rejected, nothing is written', async () => {
  const { db, provider } = setup();
  assert.equal(await codeOf(run(db, provider, cart([{ productId: 'ghost', qty: 1 }]))), 'failed-precondition');
  assert.equal(await codeOf(run(db, provider, cart([{ productId: 'off', qty: 1 }]))), 'failed-precondition');
  assert.equal(await codeOf(run(db, provider, { items: [{ productId: 'p1', qty: 1 }], consent: false })), 'invalid-argument');
  assert.equal(await codeOf(run(db, provider, cart([{ productId: 'p1', qty: 11 }]))), 'invalid-argument');
  assert.equal(db.list('orders/').length, 0);
  assert.equal(provider.calls.length, 0);
});

test('unauthenticated (no uid) is rejected', async () => {
  const { db, provider } = setup();
  assert.equal(await codeOf(run(db, provider, cart([{ productId: 'p1', qty: 1 }]), { uid: undefined })), 'unauthenticated');
});

test('rate limit: 5 pending orders per hour, the 6th is refused; old ones do not count', async () => {
  const { db, provider } = setup();
  for (let i = 0; i < 5; i++) await run(db, provider, cart([{ productId: 'p1', qty: 1 }]));
  assert.equal(await codeOf(run(db, provider, cart([{ productId: 'p1', qty: 1 }]))), 'resource-exhausted');
  assert.equal(db.list('orders/').length, 5);
  // an hour and a minute later the window has passed
  const later = new Date(NOW.getTime() + 61 * 60 * 1000);
  const r = await run(db, provider, cart([{ productId: 'p1', qty: 1 }]), { now: later });
  assert.ok(r.orderId);
});

test('rate limit is per user and ignores non-pending orders', async () => {
  const { db, provider } = setup();
  for (let i = 0; i < 5; i++) db.seed('orders/old' + i, { uid: 'u1', status: 'paid', createdAt: NOW });
  for (let i = 0; i < 5; i++) db.seed('orders/oth' + i, { uid: 'u2', status: 'pending', createdAt: NOW });
  assert.ok((await run(db, provider, cart([{ productId: 'p1', qty: 1 }]))).orderId);
});

test('rate limit holds under concurrent requests (transactional)', async () => {
  const { db, provider } = setup();
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => run(db, provider, cart([{ productId: 'p1', qty: 1 }]))));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 5);
  assert.equal(results.filter((r) => r.status === 'rejected' && r.reason.code === 'resource-exhausted').length, 7);
});

test('provider failure: order marked failed, client gets a generic Hebrew error without internals', async () => {
  const { db } = setup();
  const provider = fakeProvider({ fail: 'rejected' });
  let err;
  try {
    await createCheckoutSafe({ db, provider, config, uid: 'u1', token: {}, data: cart([{ productId: 'p1', qty: 1 }]), now: NOW, webhookUrl: WEBHOOK });
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof HttpsError);
  assert.equal(err.code, 'unavailable');
  assert.match(err.message, /שירות התשלום/);
  assert.ok(!/boom|secret|XYZ|at /.test(err.message));
  const orders = db.list('orders/').map((p) => db.read(p));
  assert.equal(orders.length, 1);
  assert.equal(orders[0].status, 'failed');
  assert.equal(orders[0].failedReason, 'provider_error');
});

test('unexpected exceptions become a generic internal error (no stack/message leak)', async () => {
  const db = new FakeFirestore();
  seedProducts(db);
  db.getAll = async () => {
    throw new Error('Firestore exploded: secret-path /internal');
  };
  let err;
  try {
    await createCheckoutSafe({ db, provider: fakeProvider(), config, uid: 'u1', token: {}, data: cart([{ productId: 'p1', qty: 1 }]), now: NOW, webhookUrl: WEBHOOK });
  } catch (e) {
    err = e;
  }
  assert.equal(err.code, 'internal');
  assert.ok(!/exploded|secret-path/.test(err.message));
});

test('missing siteUrl/webhookUrl is a configuration error, not a crash', async () => {
  const { db, provider } = setup();
  assert.equal(await codeOf(run(db, provider, cart([{ productId: 'p1', qty: 1 }]), { webhookUrl: '' })), 'failed-precondition');
});

test('an existing profile termsAcceptedAt is not overwritten by later checkouts', async () => {
  const { db, provider } = setup();
  const first = new Date('2026-01-01T00:00:00Z');
  db.seed('users/u1', { displayName: 'דנה', marketingConsent: false, createdAt: NOW, termsAcceptedAt: first, adult: true });
  await run(db, provider, cart([{ productId: 'p1', qty: 1 }]));
  assert.equal(db.read('users/u1').termsAcceptedAt.getTime(), first.getTime());
});

// ============ age gate ============
test('AGE GATE: no declaration / minor / non-boolean are all refused with distinct reasons and nothing is created', async () => {
  for (const [adult, reason] of [[undefined, 'age-required'], [false, 'not-adult'], ['true', 'age-required'], [1, 'age-required']]) {
    const { db, provider } = setup();
    db.seed('users/u1', { displayName: 'x', marketingConsent: false, createdAt: NOW, ...(adult === undefined ? {} : { adult }) });
    let err;
    try {
      await run(db, provider, cart([{ productId: 'p1', qty: 1 }]));
    } catch (e) {
      err = e;
    }
    assert.equal(err.code, 'failed-precondition', String(adult));
    assert.equal(err.details.reason, reason);
    assert.match(err.message, /18/);
    assert.equal(db.list('orders/').length, 0);
    assert.equal(provider.calls.length, 0);
  }
});

test('AGE GATE: a user without any profile doc is refused; the gate can be switched off by config', async () => {
  const { db, provider } = setup();
  const noProfile = await createCheckoutCore({ db, provider, config: { ...config, ageGate: { required: false, minAge: 18 } }, uid: 'nobody', token: {}, data: cart([{ productId: 'p1', qty: 1 }]), now: NOW, webhookUrl: WEBHOOK });
  assert.ok(noProfile.orderId);
  assert.equal(await codeOf(run(db, provider, cart([{ productId: 'p1', qty: 1 }]), { uid: 'nobody' })), 'failed-precondition');
});

test('order records the terms version and that the age gate passed', async () => {
  const { db, provider } = setup();
  const r = await run(db, provider, cart([{ productId: 'p1', qty: 1 }]));
  const o = db.read('orders/' + r.orderId);
  assert.deepEqual([o.termsVersion, o.ageGateOk], ['1', true]);
});

// ============ coin packs ============
test('coin packs: the order snapshots coins per unit and is NOT discounted for gold members (noDiscount)', async () => {
  const { db, provider } = setup();
  db.seed('products/coins-850', { name: '850 מטבעות', description: '', priceAgorot: 990, currency: 'ILS', grants: [], accessDays: null, coins: 850, noDiscount: true, active: true, sort: 20 });
  db.seed('members/u1', { points: 0, lifetimeSpendAgorot: 60000, ordersCount: 3, tier: 'gold', updatedAt: NOW });
  const r = await run(db, provider, cart([{ productId: 'coins-850', qty: 2 }, { productId: 'p1', qty: 1 }]));
  const o = db.read('orders/' + r.orderId);
  assert.deepEqual([o.subtotalAgorot, o.discountAgorot, o.totalAgorot], [11980, 1000, 10980]); // 10% only on p1 (10000)
  assert.deepEqual(o.items[0], { productId: 'coins-850', name: '850 מטבעות', priceAgorot: 990, qty: 2, grants: [], accessDays: null, coins: 850, noDiscount: true });
});

test('coin packs at the owner prices: 250/3.90, 850/9.90, 5500/19.90 (agorot, VAT included)', async () => {
  const { db, provider } = setup();
  const packs = [['coins-250', 250, 390], ['coins-850', 850, 990], ['coins-5500', 5500, 1990]];
  for (const [id, coins, price] of packs) db.seed('products/' + id, { name: `${coins}`, description: '', priceAgorot: price, currency: 'ILS', grants: [], accessDays: null, coins, noDiscount: true, active: true, sort: 1 });
  const r = await run(db, provider, cart(packs.map(([id]) => ({ productId: id, qty: 1 }))));
  assert.equal(db.read('orders/' + r.orderId).totalAgorot, 390 + 990 + 1990);
});

test('provider ref write is retried; if it keeps failing the order is failed, not left payable', async () => {
  const { db, provider } = setup();
  let fails = 2;
  const orig = db.collection.bind(db);
  db.collection = (p) => {
    const c = orig(p);
    if (p !== 'orders') return c;
    const d = c.doc.bind(c);
    c.doc = (id) => {
      const ref = d(id);
      const up = ref.update.bind(ref);
      ref.update = async (patch) => {
        if (patch.providerRef && fails-- > 0) throw new Error('transient');
        return up(patch);
      };
      return ref;
    };
    return c;
  };
  const r = await run(db, provider, cart([{ productId: 'p1', qty: 1 }]));
  assert.equal(db.read('orders/' + r.orderId).providerRef, 'page-req-1', 'succeeded on the 3rd try');
  fails = 99;
  assert.equal(await codeOf(run(db, provider, cart([{ productId: 'p1', qty: 1 }]))), 'unavailable');
  const failed = db.list('orders/').map((p) => db.read(p)).filter((o) => o.status === 'failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].failedReason, 'provider_ref_not_saved');
});
