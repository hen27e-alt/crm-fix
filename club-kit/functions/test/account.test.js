'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeFirestore } = require('./helpers/fakeFirestore');
const { paidOrder } = require('./helpers/fixtures');
const { deleteAccountCore, ensureUserAndMember } = require('../src/account');

const NOW = new Date('2026-06-01T12:00:00Z');

function seedUser(db) {
  db.seed('users/u1', { displayName: 'דנה', email: 'a@b.co', marketingConsent: true, createdAt: NOW });
  db.seed('users/u1/entitlements/feat_a', { feature: 'feat_a', orderId: 'o1', expiresAt: null });
  db.seed('users/u1/entitlements/feat_b', { feature: 'feat_b', orderId: 'o2', expiresAt: null });
  db.seed('users/u1/other/x', { junk: true });
  db.seed('members/u1', { points: 10, lifetimeSpendAgorot: 1000, ordersCount: 1, tier: 'member', updatedAt: NOW });
  db.seed('users/u2', { displayName: 'אחר', marketingConsent: false, createdAt: NOW });
  db.seed('members/u2', { points: 1, lifetimeSpendAgorot: 1, ordersCount: 1, tier: 'member', updatedAt: NOW });
  db.seed('orders/o1', paidOrder({ status: 'paid', receiptUrl: 'https://r/1' }));
  db.seed('orders/o2', paidOrder({ status: 'pending' }));
  db.seed('orders/o3', paidOrder({ uid: 'u2', status: 'paid' }));
}
const mkAuth = (fail) => {
  const deleted = [];
  return { deleted, deleteUser: async (uid) => { if (fail) throw fail; deleted.push(uid); } };
};

test('deleteAccount: removes user, subcollections, member and auth user; anonymises orders; leaves other users alone', async () => {
  const db = new FakeFirestore();
  seedUser(db);
  const auth = mkAuth();
  await deleteAccountCore({ db, auth, uid: 'u1', now: NOW });
  assert.deepEqual(db.list('users/u1'), []);
  assert.equal(db.read('members/u1'), undefined);
  assert.deepEqual(auth.deleted, ['u1']);
  assert.equal(db.read('orders/o1').uid, 'deleted');
  assert.equal(db.read('orders/o1').status, 'paid');
  assert.equal(db.read('orders/o1').receiptUrl, 'https://r/1'); // kept for tax records
  assert.equal(db.read('orders/o1').totalAgorot, 20000);
  assert.equal(db.read('orders/o2').uid, 'deleted');
  assert.equal(db.read('orders/o2').status, 'cancelled'); // pending orders are cancelled
  assert.equal(db.read('orders/o3').uid, 'u2');
  assert.ok(db.read('users/u2') && db.read('members/u2'));
});

test('deleteAccount: handles more orders than one batch; auth user already gone is fine; other auth errors propagate AFTER data is removed', async () => {
  const db = new FakeFirestore();
  seedUser(db);
  for (let i = 0; i < 950; i++) db.seed('orders/bulk' + i, paidOrder({ status: 'paid' }));
  await deleteAccountCore({ db, auth: mkAuth({ code: 'auth/user-not-found' }), uid: 'u1', now: NOW });
  assert.equal(db.list('orders/').filter((p) => db.read(p).uid === 'u1').length, 0);

  const db2 = new FakeFirestore();
  seedUser(db2);
  await assert.rejects(deleteAccountCore({ db: db2, auth: mkAuth(new Error('auth down')), uid: 'u1', now: NOW }), /auth down/);
  assert.deepEqual(db2.list('users/u1'), []); // retry later is possible because Auth (the sign-in) is deleted last
});

test('ensureUserAndMember: creates both docs for a new user, contract shape', async () => {
  const db = new FakeFirestore();
  await ensureUserAndMember({ db, user: { uid: 'n1', displayName: 'נועה', email: 'n@x.co', phoneNumber: '+972501234567' }, now: NOW });
  assert.deepEqual(db.read('users/n1'), { displayName: 'נועה', marketingConsent: false, createdAt: NOW, email: 'n@x.co', phone: '+972501234567' });
  assert.deepEqual(db.read('members/n1'), { points: 0, lifetimeSpendAgorot: 0, ordersCount: 0, tier: 'member', updatedAt: NOW });
});

test('ensureUserAndMember: phone-only user has no email key; existing docs are never overwritten', async () => {
  const db = new FakeFirestore();
  await ensureUserAndMember({ db, user: { uid: 'n2', phoneNumber: '+972501234567' }, now: NOW });
  assert.equal('email' in db.read('users/n2'), false);
  assert.equal(db.read('users/n2').displayName, '');
  db.seed('users/n3', { displayName: 'custom', marketingConsent: true, createdAt: NOW });
  db.seed('members/n3', { points: 77, lifetimeSpendAgorot: 1, ordersCount: 1, tier: 'silver', updatedAt: NOW });
  await ensureUserAndMember({ db, user: { uid: 'n3', displayName: 'other' }, now: NOW });
  assert.equal(db.read('users/n3').displayName, 'custom');
  assert.equal(db.read('members/n3').points, 77);
});
