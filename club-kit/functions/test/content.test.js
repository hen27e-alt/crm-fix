'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeFirestore } = require('./helpers/fakeFirestore');
const { getEntitledContentCore } = require('../src/content');

const NOW = new Date('2026-06-01T12:00:00Z');
const err = async (p) => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  return null;
};

function setup() {
  const db = new FakeFirestore();
  db.seed('protectedContent/read1', { feature: 'premium', kind: 'text', title: 'כותרת', body: 'תוכן בתשלום' });
  db.seed('protectedContent/data1', { feature: 'premium', kind: 'json', title: 'j', data: { a: 1 } });
  db.seed('protectedContent/file1', { feature: 'premium', kind: 'file', title: 'f', storagePath: 'protected/guide.pdf' });
  db.seed('protectedContent/evil', { feature: 'premium', kind: 'file', title: 'f', storagePath: 'protected/../secrets.json' });
  db.seed('protectedContent/outside', { feature: 'premium', kind: 'file', title: 'f', storagePath: 'public/x.pdf' });
  db.seed('users/u1/entitlements/premium', { feature: 'premium', orderId: 'o', expiresAt: new Date(NOW.getTime() + 86400000) });
  db.seed('users/u2/entitlements/premium', { feature: 'premium', orderId: 'o', expiresAt: new Date(NOW.getTime() - 1000) });
  db.seed('users/u3/entitlements/other', { feature: 'other', orderId: 'o', expiresAt: null });
  return db;
}
const signUrl = async (path, exp) => `https://signed.example/${path}?exp=${exp.getTime()}`;

test('entitled user gets text / json / signed file URL', async () => {
  const db = setup();
  const t = await getEntitledContentCore({ db, uid: 'u1', data: { contentId: 'read1' }, signUrl, now: NOW });
  assert.deepEqual([t.kind, t.body, t.title], ['text', 'תוכן בתשלום', 'כותרת']);
  assert.equal((await getEntitledContentCore({ db, uid: 'u1', data: { contentId: 'data1' }, signUrl, now: NOW })).data.a, 1);
  const f = await getEntitledContentCore({ db, uid: 'u1', data: { contentId: 'file1' }, signUrl, now: NOW });
  assert.match(f.url, /^https:\/\/signed\.example\/protected\/guide\.pdf/);
  assert.equal(new Date(f.urlExpiresAt).getTime() - NOW.getTime(), 10 * 60 * 1000);
});

test('expired, missing or different-feature entitlement is denied with the SAME error as unknown content', async () => {
  const db = setup();
  const codes = [];
  for (const [uid, id] of [['u2', 'read1'], ['u3', 'read1'], ['nobody', 'read1'], ['u1', 'does-not-exist']]) {
    const e = await err(getEntitledContentCore({ db, uid, data: { contentId: id }, signUrl, now: NOW }));
    codes.push([e.code, e.message]);
  }
  assert.ok(codes.every((c) => c[0] === 'permission-denied' && c[1] === codes[0][1]));
});

test('lifetime entitlement works; expiry is enforced at request time', async () => {
  const db = setup();
  db.seed('users/u3/entitlements/premium', { feature: 'premium', orderId: 'o', expiresAt: null });
  assert.equal((await getEntitledContentCore({ db, uid: 'u3', data: { contentId: 'read1' }, signUrl, now: NOW })).body, 'תוכן בתשלום');
  const later = new Date(NOW.getTime() + 2 * 86400000);
  assert.equal((await err(getEntitledContentCore({ db, uid: 'u1', data: { contentId: 'read1' }, signUrl, now: later }))).code, 'permission-denied');
});

test('bad input, unauthenticated, path traversal and files outside protected/ are refused', async () => {
  const db = setup();
  for (const d of [null, {}, { contentId: '../x' }, { contentId: 5 }, { contentId: 'a'.repeat(65) }]) assert.equal((await err(getEntitledContentCore({ db, uid: 'u1', data: d, signUrl, now: NOW }))).code, 'invalid-argument');
  assert.equal((await err(getEntitledContentCore({ db, uid: '', data: { contentId: 'read1' }, signUrl, now: NOW }))).code, 'unauthenticated');
  for (const id of ['evil', 'outside']) assert.equal((await err(getEntitledContentCore({ db, uid: 'u1', data: { contentId: id }, signUrl, now: NOW }))).code, 'internal');
  assert.equal((await err(getEntitledContentCore({ db, uid: 'u1', data: { contentId: 'file1' }, signUrl: async () => { throw new Error('iam boom'); }, now: NOW }))).message.includes('boom'), false);
});
