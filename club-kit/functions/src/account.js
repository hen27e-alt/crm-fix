'use strict';
const { cleanText, logId } = require('./util');
const log = require('./log');

const DELETED_UID = 'deleted';
const BATCH = 400;

/**
 * Creates users/{uid} and members/{uid} if (and only if) they do not exist yet.
 * Safe to call repeatedly / concurrently with the client creating its own user doc.
 */
async function ensureUserAndMember({ db, user, now = new Date() }) {
  const userRef = db.collection('users').doc(user.uid);
  const memberRef = db.collection('members').doc(user.uid);
  await db.runTransaction(async (tx) => {
    const [u, m] = [await tx.get(userRef), await tx.get(memberRef)];
    if (!u.exists) {
      const doc = { displayName: cleanText(user.displayName || '', 100), marketingConsent: false, createdAt: now };
      const email = cleanText(user.email || '', 254);
      const phone = cleanText(user.phoneNumber || '', 20);
      if (email) doc.email = email;
      if (phone) doc.phone = phone;
      tx.set(userRef, doc);
    }
    if (!m.exists) {
      tx.set(memberRef, { points: 0, lifetimeSpendAgorot: 0, ordersCount: 0, tier: 'member', updatedAt: now });
    }
  });
  log.info('user bootstrap done', { uid: logId(user.uid) });
}

/**
 * Deletes a user's data. Order matters: Auth is deleted LAST, so if anything fails the user
 * can still sign in and retry. Orders are kept for tax-retention but anonymised (uid -> "deleted").
 * Pending orders are cancelled; if a late "paid" webhook still arrives the order is marked paid
 * without touching any (deleted) user data.
 */
async function deleteAccountCore({ db, auth, uid, now = new Date() }) {
  let anonymised = 0;
  for (let i = 0; i < 1000; i++) {
    const snap = await db.collection('orders').where('uid', '==', uid).limit(BATCH).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach((d) => {
      const patch = { uid: DELETED_UID, anonymizedAt: now };
      if (d.data().status === 'pending') {
        patch.status = 'cancelled';
        patch.failedReason = 'account_deleted';
      }
      batch.update(d.ref, patch);
    });
    await batch.commit();
    anonymised += snap.size;
  }

  await db.recursiveDelete(db.collection('users').doc(uid)); // user doc + entitlements (+ any other subcollection)
  await db.collection('members').doc(uid).delete();

  try {
    await auth.deleteUser(uid);
  } catch (e) {
    if (!(e && e.code === 'auth/user-not-found')) throw e;
  }
  log.info('account deleted', { uid: logId(uid), ordersAnonymised: anonymised });
  return { ok: true };
}

module.exports = { ensureUserAndMember, deleteAccountCore };
