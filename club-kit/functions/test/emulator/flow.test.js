'use strict';
/**
 * End-to-end flow against the REAL Firestore emulator with the real Admin SDK
 * (checkout -> webhook paid -> refund -> account deletion). Skipped unless FIRESTORE_EMULATOR_HOST is set.
 * Run: npm run test:rules  (the same emulator:exec also runs this folder)  or  npm run test:emulator
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const skip = process.env.FIRESTORE_EMULATOR_HOST ? false : 'FIRESTORE_EMULATOR_HOST not set';

test('admin SDK flow on the Firestore emulator', { skip }, async () => {
  const { initializeApp } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  const { config, fakeProvider } = require('../helpers/fixtures');
  const { createCheckoutCore } = require('../../src/checkout');
  const { processPaymentEvent } = require('../../src/webhook');
  const { deleteAccountCore, ensureUserAndMember } = require('../../src/account');

  initializeApp({ projectId: 'demo-club-kit' });
  const db = getFirestore();
  const uid = 'emu-user-1';
  await db.collection('products').doc('p1').set({ name: 'מוצר א', priceAgorot: 25000, currency: 'ILS', grants: ['feat_a'], accessDays: 30, active: true, sort: 1 });
  await ensureUserAndMember({ db, user: { uid, displayName: 'דנה', email: 'd@x.co' } });
  assert.equal((await db.doc(`members/${uid}`).get()).data().tier, 'member');

  const provider = fakeProvider();
  const { orderId } = await createCheckoutCore({ db, provider, config, uid, token: {}, data: { items: [{ productId: 'p1', qty: 2 }, { productId: 'p1', qty: 1 }], consent: true }, webhookUrl: 'https://x.example/hook' });
  let order = (await db.doc(`orders/${orderId}`).get()).data();
  assert.equal(order.totalAgorot, 75000);
  assert.equal(order.status, 'pending');

  const ev = { orderId, status: 'paid', amountAgorot: 75000, currency: 'ILS', txnUid: 't1', receiptUrl: 'https://r.example/1', providerRef: 'page-req-1', reason: '' };
  const results = await Promise.all([1, 2, 3, 4].map(() => processPaymentEvent({ db, config, event: ev })));
  assert.equal(results.filter((r) => r.result === 'paid').length, 1);
  const member = (await db.doc(`members/${uid}`).get()).data();
  assert.deepEqual([member.points, member.ordersCount, member.tier], [750, 1, 'gold']);
  const ent = (await db.doc(`users/${uid}/entitlements/feat_a`).get()).data();
  assert.equal(ent.orderId, orderId);
  assert.ok(ent.expiresAt.toDate().getTime() > Date.now() + 89 * 86400000);

  assert.equal((await processPaymentEvent({ db, config, event: { ...ev, status: 'failed' } })).result, 'noop');
  assert.equal((await processPaymentEvent({ db, config, event: { ...ev, status: 'refunded' } })).result, 'refunded');
  assert.equal((await db.doc(`users/${uid}/entitlements/feat_a`).get()).exists, false);
  assert.equal((await db.doc(`members/${uid}`).get()).data().points, 0);

  // rate limit with the real transaction + query semantics
  for (let i = 0; i < 5; i++) await createCheckoutCore({ db, provider, config, uid, token: {}, data: { items: [{ productId: 'p1', qty: 1 }], consent: true }, webhookUrl: 'https://x.example/hook' });
  await assert.rejects(createCheckoutCore({ db, provider, config, uid, token: {}, data: { items: [{ productId: 'p1', qty: 1 }], consent: true }, webhookUrl: 'https://x.example/hook' }), (e) => e.code === 'resource-exhausted');

  const deleted = [];
  await deleteAccountCore({ db, auth: { deleteUser: async (u) => deleted.push(u) }, uid });
  assert.deepEqual(deleted, [uid]);
  assert.equal((await db.doc(`users/${uid}`).get()).exists, false);
  assert.equal((await db.doc(`members/${uid}`).get()).exists, false);
  assert.equal((await db.collection(`users/${uid}/entitlements`).get()).size, 0);
  order = (await db.doc(`orders/${orderId}`).get()).data();
  assert.deepEqual([order.uid, order.status, order.totalAgorot], ['deleted', 'refunded', 75000]);
  assert.equal((await db.collection('orders').where('uid', '==', uid).get()).size, 0);
});
