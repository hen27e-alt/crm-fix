'use strict';
/**
 * Payment event core (shared by the webhook and the capture callable).
 * Provider events are NEVER trusted for price/entitlements: the verified event only identifies the order and
 * reports status/amount; everything granted (features, points, coins, spend) is derived from the STORED order.
 *
 * Normalised event (from provider adapters):
 *   { status:'paid'|'failed'|'refunded', orderId?, amountAgorot, currency, txnUid, receiptUrl,
 *     providerRef?, reason?, eventId? (provider's unique webhook id), captureId? (refund: the original charge id) }
 *
 * State machine (order.status), all inside ONE Firestore transaction:
 *   pending|failed|cancelled --paid--> paid          (money was taken: honour it even after a failure/cancel)
 *   pending                  --failed--> failed
 *   paid                     --failed--> paid        (out-of-order/replayed failure is ignored: never downgrade)
 *   paid                     --refund(full)--> refunded   (that order's contributions are removed from each entitlement,
 *                                                          points/spend/coins reversed)
 *   paid                     --refund(partial)--> paid + needsManualReview
 *   refunded                 --anything--> refunded  (terminal)
 *
 * Replay / duplicate detection:
 *   - paymentEvents/{eventId}: a provider event id is processed at most once.
 *   - paymentTxns/{txnUid}:    a charge id is bound to ONE order (reuse for another order is rejected); it also lets a
 *                              refund event that only names the charge find its order.
 *   - a second, DIFFERENT charge for an order that is already paid/refunded is a DUPLICATE CHARGE: the order stays as is,
 *     but is flagged (webhookAnomaly, needsManualReview, duplicateTxnUids) and an alert-grade log is written.
 */
const { resolveTier, pointsForTotal } = require('./club');
const { addContribution, removeContribution } = require('./entitlements');
const log = require('./log');

const DELETED_UID = 'deleted';
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function hasRealUser(order) {
  return typeof order.uid === 'string' && order.uid && order.uid !== DELETED_UID;
}

/** Features an order entitles to, from the STORED snapshot: Map feature -> {lifetime, days, productId}. */
function featuresFromOrder(order) {
  const map = new Map();
  for (const it of Array.isArray(order.items) ? order.items : []) {
    const grants = Array.isArray(it.grants) ? it.grants : [];
    for (const f of grants) {
      if (typeof f !== 'string' || !f) continue;
      const cur = map.get(f) || { lifetime: false, days: 0, productId: it.productId };
      if (Number.isInteger(it.accessDays) && it.accessDays > 0) cur.days += it.accessDays * (Number.isInteger(it.qty) ? it.qty : 1);
      else cur.lifetime = true;
      map.set(f, cur);
    }
  }
  return map;
}

/** Total coins an order credits (sum of per-unit coins * qty), from the stored snapshot. */
function coinsFromOrder(order) {
  let n = 0;
  for (const it of Array.isArray(order.items) ? order.items : []) {
    if (Number.isInteger(it.coins) && it.coins > 0 && Number.isInteger(it.qty) && it.qty > 0) n += it.coins * it.qty;
  }
  return Number.isSafeInteger(n) ? n : 0;
}

const num = (v) => (Number.isFinite(v) ? v : 0);

async function processPaymentEvent({ db, config, event, now = new Date() }) {
  if (!event || !['paid', 'failed', 'refunded'].includes(event.status) || (!event.orderId && !event.captureId && !event.providerRef)) {
    return { result: 'ignored', reason: 'bad_event' };
  }
  if (event.orderId !== undefined && event.orderId !== null && (typeof event.orderId !== 'string' || !ID_RE.test(event.orderId))) {
    return { result: 'ignored', reason: 'bad_event' };
  }

  return db.runTransaction(async (tx) => {
    // ---- replay of the very same provider event ----
    let eventRef = null;
    if (typeof event.eventId === 'string' && ID_RE.test(event.eventId)) {
      eventRef = db.collection('paymentEvents').doc(event.eventId);
      if ((await tx.get(eventRef)).exists) return { result: 'noop', reason: 'replayed_event' };
    }

    // ---- find our order: explicit id, else via the charge id, else via the provider's order/page reference ----
    let orderId = event.orderId || null;
    if (!orderId && typeof event.captureId === 'string' && ID_RE.test(event.captureId)) {
      const t = await tx.get(db.collection('paymentTxns').doc(event.captureId));
      if (t.exists) orderId = t.data().orderId;
    }
    if (!orderId && typeof event.providerRef === 'string' && event.providerRef) {
      const q = await tx.get(db.collection('orders').where('providerRef', '==', event.providerRef).limit(2));
      if (q.size === 1) orderId = q.docs[0].id;
    }
    if (!orderId) return { result: 'ignored', reason: 'unknown_order' };

    const orderRef = db.collection('orders').doc(orderId);
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) return { result: 'ignored', reason: 'unknown_order' };
    const order = orderSnap.data();
    const current = order.status;
    const finish = (res) => {
      if (eventRef) tx.set(eventRef, { orderId, status: event.status, result: res.result, at: now });
      return res;
    };

    if (event.providerRef && order.providerRef && event.providerRef !== order.providerRef) {
      return { result: 'ignored', reason: 'provider_ref_mismatch' };
    }

    // ================= FAILED =================
    if (event.status === 'failed') {
      if (current !== 'pending') return finish({ result: 'noop', reason: `already_${current}` }); // never downgrade
      tx.update(orderRef, {
        status: 'failed',
        failedReason: String(event.reason || 'payment_failed').slice(0, 160),
        ...(event.txnUid ? { providerTxnUid: event.txnUid } : {}),
        updatedAt: now,
      });
      return finish({ result: 'failed' });
    }

    const amountOk = Number.isInteger(event.amountAgorot) && event.currency === order.currency;
    const txnId = typeof event.txnUid === 'string' && ID_RE.test(event.txnUid) ? event.txnUid : null;

    // ================= PAID =================
    if (event.status === 'paid') {
      if (current === 'paid' || current === 'refunded') {
        const known = new Set([order.providerTxnUid, ...(Array.isArray(order.duplicateTxnUids) ? order.duplicateTxnUids : [])].filter(Boolean));
        if (event.txnUid && order.providerTxnUid && !known.has(event.txnUid)) {
          // a DIFFERENT charge for an order that is already settled: the customer was charged twice
          const dups = [...(order.duplicateTxnUids || []), event.txnUid];
          tx.update(orderRef, {
            webhookAnomaly: current === 'paid' ? 'duplicate_charge' : 'paid_after_refund',
            needsManualReview: true,
            duplicateTxnUids: dups,
            duplicateChargeAgorot: Number.isInteger(event.amountAgorot) ? event.amountAgorot : null,
            anomalyAt: now,
            updatedAt: now,
          });
          if (txnId) tx.set(db.collection('paymentTxns').doc(txnId), { orderId, kind: 'duplicate', at: now });
          log.alertReview('payment: duplicate charge detected - refund the extra charge', { orderId, anomaly: current === 'paid' ? 'duplicate_charge' : 'paid_after_refund' });
          return finish({ result: 'duplicate_charge' });
        }
        return finish({ result: 'noop', reason: `already_${current}` });
      }

      if (!amountOk || event.amountAgorot !== order.totalAgorot) {
        tx.update(orderRef, { webhookAnomaly: 'amount_or_currency_mismatch', needsManualReview: true, anomalyAt: now });
        log.alertReview('payment: amount/currency mismatch - order NOT marked paid', { orderId });
        return finish({ result: 'rejected', reason: 'amount_or_currency_mismatch' });
      }

      if (txnId) {
        const t = await tx.get(db.collection('paymentTxns').doc(txnId));
        if (t.exists && t.data().orderId !== orderId) {
          tx.update(orderRef, { webhookAnomaly: 'txn_reused_for_other_order', needsManualReview: true, anomalyAt: now });
          log.alertReview('payment: charge id already bound to another order', { orderId });
          return finish({ result: 'rejected', reason: 'txn_reused_for_other_order' });
        }
      }

      const features = featuresFromOrder(order);
      const coins = coinsFromOrder(order);
      const real = hasRealUser(order);

      // all reads first (Firestore transactions require reads before writes)
      const memberRef = real ? db.collection('members').doc(order.uid) : null;
      const memberSnap = real ? await tx.get(memberRef) : null;
      const entRefs = real ? [...features.keys()].map((f) => db.collection('users').doc(order.uid).collection('entitlements').doc(f)) : [];
      const entSnaps = [];
      for (const r of entRefs) entSnaps.push(await tx.get(r));

      const points = pointsForTotal(order.totalAgorot, config.points.perShekel);
      const granted = [];
      if (real) {
        [...features.entries()].forEach(([feature, grant], i) => {
          const existing = entSnaps[i].exists ? entSnaps[i].data() : null;
          const doc = addContribution(feature, existing, { orderId, productId: grant.productId, lifetime: grant.lifetime, days: grant.days }, now);
          tx.set(entRefs[i], doc);
          granted.push(feature);
        });
        const cur = memberSnap.exists ? memberSnap.data() : {};
        const lifetime = num(cur.lifetimeSpendAgorot) + order.totalAgorot;
        tx.set(memberRef, {
          ...(memberSnap.exists ? cur : {}),
          points: num(cur.points) + points,
          lifetimeSpendAgorot: lifetime,
          ordersCount: num(cur.ordersCount) + 1,
          coins: num(cur.coins) + coins,
          tier: resolveTier(config.tiers, lifetime).id,
          updatedAt: now,
        });
        if (coins > 0) tx.set(memberRef.collection('coinLedger').doc(orderId), { orderId, type: 'purchase', coins, at: now });
      }
      if (txnId) tx.set(db.collection('paymentTxns').doc(txnId), { orderId, kind: 'capture', at: now });

      const orphan = !real; // paid, but the account is gone: nobody received the goods
      tx.update(orderRef, {
        status: 'paid',
        paidAt: now,
        updatedAt: now,
        failedReason: null,
        webhookAnomaly: orphan ? 'paid_for_deleted_account' : null,
        ...(orphan ? { needsManualReview: true } : {}),
        providerTxnUid: event.txnUid || null,
        ...(event.receiptUrl ? { receiptUrl: event.receiptUrl } : {}),
        pointsAwarded: real ? points : 0,
        spendAddedAgorot: real ? order.totalAgorot : 0,
        coinsAwarded: real ? coins : 0,
        grantedFeatures: real ? [...features.keys()] : [],
      });
      if (orphan) log.alertReview('payment: PAID order of a deleted account - refund or restore manually', { orderId });
      return finish({ result: 'paid', granted });
    }

    // ================= REFUNDED =================
    if (current === 'refunded') return finish({ result: 'noop', reason: 'already_refunded' });
    if (current !== 'paid') return finish({ result: 'ignored', reason: `refund_for_${current}` });

    // refund of the DUPLICATE charge (not the one that settled the order): record it, keep the order paid
    if (event.captureId && order.providerTxnUid && event.captureId !== order.providerTxnUid) {
      const dups = Array.isArray(order.duplicateTxnUids) ? order.duplicateTxnUids : [];
      if (dups.includes(event.captureId)) {
        const done = Array.isArray(order.duplicateRefundedTxnUids) ? order.duplicateRefundedTxnUids : [];
        tx.update(orderRef, { duplicateRefundedTxnUids: done.includes(event.captureId) ? done : [...done, event.captureId], updatedAt: now });
        return finish({ result: 'duplicate_refunded' });
      }
      return finish({ result: 'ignored', reason: 'refund_for_unknown_charge' });
    }

    if (!amountOk || event.amountAgorot <= 0 || event.amountAgorot > order.totalAgorot) {
      tx.update(orderRef, { webhookAnomaly: 'refund_amount_or_currency_mismatch', needsManualReview: true, anomalyAt: now });
      log.alertReview('payment: refund amount/currency mismatch', { orderId });
      return finish({ result: 'rejected', reason: 'refund_amount_or_currency_mismatch' });
    }
    if (event.amountAgorot < order.totalAgorot) {
      // partial refund: idempotent overwrite, no automatic revoke - the owner decides
      tx.update(orderRef, { lastPartialRefundAgorot: event.amountAgorot, needsManualReview: true, updatedAt: now });
      log.alertReview('payment: PARTIAL refund - decide manually what to revoke', { orderId });
      return finish({ result: 'partial_refund_flagged' });
    }

    const real = hasRealUser(order);
    const featureNames = Array.isArray(order.grantedFeatures) ? order.grantedFeatures : [...featuresFromOrder(order).keys()];
    const memberRef = real ? db.collection('members').doc(order.uid) : null;
    const memberSnap = real ? await tx.get(memberRef) : null;
    const entRefs = real ? featureNames.map((f) => db.collection('users').doc(order.uid).collection('entitlements').doc(f)) : [];
    const entSnaps = [];
    for (const r of entRefs) entSnaps.push(await tx.get(r));

    const revoked = [];
    const kept = [];
    let coinShortfall = 0;
    if (real) {
      entRefs.forEach((r, i) => {
        if (!entSnaps[i].exists) return;
        // remove only THIS order's contribution; other paid orders keep what they paid for
        const next = removeContribution(featureNames[i], entSnaps[i].data(), orderId);
        if (next === null) {
          tx.delete(r);
          revoked.push(featureNames[i]);
        } else {
          tx.set(r, next);
          kept.push(featureNames[i]);
        }
      });
      if (memberSnap.exists) {
        const cur = memberSnap.data();
        const lifetime = Math.max(0, num(cur.lifetimeSpendAgorot) - (order.spendAddedAgorot || 0));
        const coinsOwed = Number.isInteger(order.coinsAwarded) ? order.coinsAwarded : 0;
        const deducted = Math.min(Math.max(0, num(cur.coins)), coinsOwed);
        coinShortfall = coinsOwed - deducted;
        tx.set(memberRef, {
          ...cur,
          points: Math.max(0, num(cur.points) - (order.pointsAwarded || 0)),
          lifetimeSpendAgorot: lifetime,
          ordersCount: Math.max(0, num(cur.ordersCount) - 1),
          coins: Math.max(0, num(cur.coins)) - deducted,
          tier: resolveTier(config.tiers, lifetime).id,
          updatedAt: now,
        });
        if (coinsOwed > 0) tx.set(memberRef.collection('coinLedger').doc(`refund-${orderId}`), { orderId, type: 'refund', coins: -deducted, shortfall: coinShortfall, at: now });
      }
    }
    tx.update(orderRef, {
      status: 'refunded',
      refundedAt: now,
      refundedAgorot: order.totalAgorot,
      ...(event.reason ? { refundReason: String(event.reason).slice(0, 80) } : {}),
      ...(coinShortfall > 0 ? { coinShortfall, needsManualReview: true } : {}),
      updatedAt: now,
    });
    if (coinShortfall > 0) log.alertReview('payment: refund but customer already spent the coins - review', { orderId, coinShortfall });
    return finish({ result: 'refunded', revoked, kept });
  });
}

module.exports = { processPaymentEvent, featuresFromOrder, coinsFromOrder, ID_RE };
