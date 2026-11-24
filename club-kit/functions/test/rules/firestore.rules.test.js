'use strict';
/**
 * Firestore rules tests (need the Firestore emulator).
 * Run:  npm run test:rules   (= firebase emulators:exec --only firestore ... "node --test test/rules/*.test.js")
 * Without FIRESTORE_EMULATOR_HOST the whole file is skipped (so `npm test` stays offline-safe).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const skip = HOST ? false : 'FIRESTORE_EMULATOR_HOST not set - run with `npm run test:rules` (needs Java + firebase-tools)';

test('firestore.rules', { skip }, async (t) => {
  const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
  const { doc, getDoc, setDoc, updateDoc, deleteDoc, getDocs, collection, query, where, Timestamp, serverTimestamp } = require('firebase/firestore');
  const [h, p] = HOST.split(':');
  const env = await initializeTestEnvironment({
    projectId: 'demo-club-kit',
    firestore: { host: h, port: Number(p), rules: fs.readFileSync(path.join(__dirname, '..', '..', '..', 'firestore.rules'), 'utf8') },
  });
  t.after(() => env.cleanup());

  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'products/active1'), { name: 'a', priceAgorot: 100, currency: 'ILS', grants: [], accessDays: null, active: true, sort: 1 });
    await setDoc(doc(db, 'products/hidden1'), { name: 'h', priceAgorot: 100, currency: 'ILS', grants: [], accessDays: null, active: false, sort: 2 });
    await setDoc(doc(db, 'orders/o1'), { uid: 'alice', status: 'paid', totalAgorot: 100 });
    await setDoc(doc(db, 'orders/o2'), { uid: 'bob', status: 'paid', totalAgorot: 100 });
    await setDoc(doc(db, 'members/alice'), { points: 5, lifetimeSpendAgorot: 100, ordersCount: 1, tier: 'member' });
    await setDoc(doc(db, 'users/alice'), { displayName: 'Alice', marketingConsent: false, createdAt: Timestamp.now() });
    await setDoc(doc(db, 'users/alice/entitlements/feat'), { feature: 'feat', productId: 'p', orderId: 'o1', grantedAt: Timestamp.now(), expiresAt: null });
    await setDoc(doc(db, 'secret/x'), { a: 1 });
    await setDoc(doc(db, 'users/carol'), { displayName: 'Carol', marketingConsent: false, createdAt: Timestamp.now(), adult: true, ageDeclaredAt: Timestamp.now(), ageGateMinAge: 18 });
    await setDoc(doc(db, 'members/carol'), { points: 0, coins: 850, tier: 'member' });
    await setDoc(doc(db, 'members/carol/coinLedger/o1'), { orderId: 'o1', type: 'purchase', coins: 850 });
    await setDoc(doc(db, 'paymentEvents/WH-1'), { orderId: 'o1' });
    await setDoc(doc(db, 'paymentTxns/CAP-1'), { orderId: 'o1' });
    await setDoc(doc(db, 'ageGates/carol'), { birthDate: '1990-01-01' });
    await setDoc(doc(db, 'protectedContent/c1'), { feature: 'premium', kind: 'text', body: 'secret' });
  });

  const anon = env.unauthenticatedContext().firestore();
  const alice = env.authenticatedContext('alice').firestore();
  const bob = env.authenticatedContext('bob').firestore();
  const now = () => Timestamp.now();
  const goodUser = (o = {}) => ({ displayName: 'Dana', marketingConsent: false, createdAt: now(), ...o });

  await t.test('products: anyone reads active, nobody reads inactive, nobody writes', async () => {
    await assertSucceeds(getDoc(doc(anon, 'products/active1')));
    await assertFails(getDoc(doc(anon, 'products/hidden1')));
    await assertSucceeds(getDocs(query(collection(anon, 'products'), where('active', '==', true))));
    await assertFails(getDocs(collection(anon, 'products'))); // unfiltered list would expose inactive items
    await assertFails(setDoc(doc(alice, 'products/new'), { name: 'x', priceAgorot: 1, active: true }));
    await assertFails(updateDoc(doc(alice, 'products/active1'), { priceAgorot: 1 }));
    await assertFails(deleteDoc(doc(alice, 'products/active1')));
  });

  await t.test('orders: owner reads own only; no client writes at all', async () => {
    await assertSucceeds(getDoc(doc(alice, 'orders/o1')));
    await assertFails(getDoc(doc(alice, 'orders/o2')));
    await assertFails(getDoc(doc(anon, 'orders/o1')));
    await assertSucceeds(getDocs(query(collection(alice, 'orders'), where('uid', '==', 'alice'))));
    await assertFails(getDocs(collection(alice, 'orders')));
    await assertFails(setDoc(doc(alice, 'orders/new'), { uid: 'alice', status: 'paid', totalAgorot: 1 }));
    await assertFails(updateDoc(doc(alice, 'orders/o1'), { status: 'refunded' }));
    await assertFails(updateDoc(doc(alice, 'orders/o1'), { totalAgorot: 1 }));
    await assertFails(deleteDoc(doc(alice, 'orders/o1')));
  });

  await t.test('members and entitlements: owner reads, nobody writes', async () => {
    await assertSucceeds(getDoc(doc(alice, 'members/alice')));
    await assertFails(getDoc(doc(bob, 'members/alice')));
    await assertFails(getDoc(doc(anon, 'members/alice')));
    await assertFails(updateDoc(doc(alice, 'members/alice'), { points: 999999 }));
    await assertFails(setDoc(doc(alice, 'members/alice'), { points: 1, tier: 'gold' }));
    await assertFails(deleteDoc(doc(alice, 'members/alice')));
    await assertSucceeds(getDoc(doc(alice, 'users/alice/entitlements/feat')));
    await assertSucceeds(getDocs(collection(alice, 'users/alice/entitlements')));
    await assertFails(getDoc(doc(bob, 'users/alice/entitlements/feat')));
    await assertFails(setDoc(doc(alice, 'users/alice/entitlements/premium'), { feature: 'premium', expiresAt: null }));
    await assertFails(updateDoc(doc(alice, 'users/alice/entitlements/feat'), { expiresAt: null }));
    await assertFails(deleteDoc(doc(alice, 'users/alice/entitlements/feat')));
  });

  await t.test('users: owner create/update with allowed fields; strangers and anon denied', async () => {
    await assertSucceeds(setDoc(doc(bob, 'users/bob'), goodUser({ email: 'b@x.co', phone: '+972501234567', termsAcceptedAt: now() })));
    await assertSucceeds(getDoc(doc(bob, 'users/bob')));
    await assertFails(getDoc(doc(alice, 'users/bob')));
    await assertFails(getDoc(doc(anon, 'users/bob')));
    await assertFails(setDoc(doc(alice, 'users/bob'), goodUser()));
    await assertFails(setDoc(doc(anon, 'users/zed'), goodUser()));
    await assertSucceeds(updateDoc(doc(alice, 'users/alice'), { displayName: 'Alice B', marketingConsent: true }));
    await assertSucceeds(updateDoc(doc(alice, 'users/alice'), { termsAcceptedAt: now() }));
  });

  await t.test('users: field allow-list, types and lengths are enforced', async () => {
    await assertFails(updateDoc(doc(alice, 'users/alice'), { isAdmin: true }));
    await assertFails(updateDoc(doc(alice, 'users/alice'), { tier: 'gold' }));
    await assertFails(updateDoc(doc(alice, 'users/alice'), { points: 100 }));
    await assertFails(updateDoc(doc(alice, 'users/alice'), { displayName: 5 }));
    await assertFails(updateDoc(doc(alice, 'users/alice'), { displayName: 'x'.repeat(101) }));
    await assertSucceeds(updateDoc(doc(alice, 'users/alice'), { displayName: 'x'.repeat(100) }));
    await assertFails(updateDoc(doc(alice, 'users/alice'), { marketingConsent: 'yes' }));
    await assertFails(updateDoc(doc(alice, 'users/alice'), { email: 'e'.repeat(255) }));
    await assertFails(updateDoc(doc(alice, 'users/alice'), { phone: '1'.repeat(21) }));
    await assertFails(updateDoc(doc(alice, 'users/alice'), { phone: 972501234567 }));
    await assertFails(updateDoc(doc(alice, 'users/alice'), { termsAcceptedAt: 'now' }));
    await assertFails(updateDoc(doc(alice, 'users/alice'), { createdAt: Timestamp.fromMillis(1) })); // immutable
    await assertFails(setDoc(doc(env.authenticatedContext('c1').firestore(), 'users/c1'), { displayName: 'no consent field', createdAt: now() }));
    await assertFails(setDoc(doc(env.authenticatedContext('c2').firestore(), 'users/c2'), goodUser({ extra: 1 })));
    await assertFails(deleteDoc(doc(alice, 'users/alice'))); // via deleteMyAccount only
  });

  await t.test('AGE GATE + WALLET: adult/ageDeclaredAt/coins are server-only; a profile that already has them stays editable', async () => {
    const carol = env.authenticatedContext('carol').firestore();
    const dave = env.authenticatedContext('dave').firestore();
    await assertFails(setDoc(doc(dave, 'users/dave'), goodUser({ adult: true }))); // cannot create a profile claiming adulthood
    await assertFails(setDoc(doc(dave, 'users/dave'), goodUser({ ageDeclaredAt: now() })));
    await assertSucceeds(setDoc(doc(dave, 'users/dave'), goodUser()));
    await assertFails(updateDoc(doc(dave, 'users/dave'), { adult: true }));
    await assertFails(updateDoc(doc(dave, 'users/dave'), { ageDeclaredAt: now() }));
    await assertFails(updateDoc(doc(dave, 'users/dave'), { ageGateMinAge: 1 }));
    await assertFails(updateDoc(doc(carol, 'users/carol'), { adult: false })); // cannot even downgrade/alter
    await assertFails(updateDoc(doc(carol, 'users/carol'), { ageDeclaredAt: now() }));
    await assertSucceeds(updateDoc(doc(carol, 'users/carol'), { displayName: 'Carol B', marketingConsent: true }));
    await assertFails(setDoc(doc(carol, 'users/carol'), { displayName: 'x', marketingConsent: false, createdAt: now() })); // replacing the doc would drop adult
    await assertSucceeds(getDoc(doc(carol, 'users/carol')));
    // wallet
    await assertSucceeds(getDoc(doc(carol, 'members/carol')));
    await assertFails(updateDoc(doc(carol, 'members/carol'), { coins: 999999 }));
    await assertSucceeds(getDoc(doc(carol, 'members/carol/coinLedger/o1')));
    await assertFails(getDoc(doc(dave, 'members/carol/coinLedger/o1')));
    await assertFails(setDoc(doc(carol, 'members/carol/coinLedger/fake'), { coins: 1000000 }));
    await assertFails(deleteDoc(doc(carol, 'members/carol/coinLedger/o1')));
  });

  await t.test('server-only collections are invisible to clients', async () => {
    const carol = env.authenticatedContext('carol').firestore();
    for (const path of ['paymentEvents/WH-1', 'paymentTxns/CAP-1', 'ageGates/carol', 'protectedContent/c1']) {
      await assertFails(getDoc(doc(carol, path)));
      await assertFails(getDoc(doc(anon, path)));
      await assertFails(setDoc(doc(carol, path), { x: 1 }));
    }
  });

  await t.test('everything else is denied (default deny)', async () => {
    await assertFails(getDoc(doc(alice, 'secret/x')));
    await assertFails(setDoc(doc(alice, 'secret/y'), { a: 1 }));
    await assertFails(getDoc(doc(anon, 'secret/x')));
    await assertFails(setDoc(doc(alice, '_ratelimits/alice'), { n: 0 }));
    await assertFails(setDoc(doc(alice, 'users/alice/private/x'), { a: 1 }));
  });
});
