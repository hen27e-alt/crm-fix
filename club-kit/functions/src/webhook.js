'use strict';
/**
 * Payment webhook core. The webhook body is NEVER trusted for price/entitlements:
 * the signed event only identifies the order and reports status/amount; everything that is
 * granted (features, points, spend) is derived from the STORED order.
 *
 * State machine (order.status):
 *   pending|failed|cancelled --paid--> paid          (money was taken: honour it even after a failure/cancel)
 *   pending                  --failed--> failed
 *   paid                     --failed--> paid        (out-of-order/replayed failure is ignored: never downgrade)
 *   paid                     --refund(full)--> refunded   (revokes entitlements + reverses points/spend)
 *   paid                     --refund(partial)--> paid + needsManualReview flag
 *   refunded                 --anything--> refunded  (terminal)
 * All of it runs inside one Firestore transaction, so a replay / concurrent duplicate is a no-op.
 */
const { resolveTier, pointsForTotal } = require('./club');
const log = require('./log');

const DAY_MS = 24 * 60 * 60 * 1000;
const DELETED_UID = 'deleted';

function toDate(v) {
  if (v instanceof Date) return v;
  if (v && typeof v.toDate === 'function') return v.toDate();
  return null;
}

function hasRealUser(order) {
  return typeof order.uid === 'string' && order.uid && order.uid !== DELETED_UID;
}

/** Features an order entitles to, derived from the STORED order snapshot: Map feature -> {lifetime, days, productId}. */
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

/** Combine an existing entitlement with a new grant. Returns null when the existing one already covers it. */
function mergeEntitlement(existing, grant, now) {
  const exp = existing ? toDate(existing.expiresAt) : undefined;
  const existingLifetime = existing && (existing.expiresAt === null || existing.expiresAt === undefined);
  if (existing && existingLifetime) return null; // already lifetime: nothing to extend
  if (grant.lifetime) return { expiresAt: null };
  const base = exp && exp.getTime() > now.getTime() ? exp.getTime() : now.getTime(); // stack on remaining time
  return { expiresAt: new Date(base + grant.days * DAY_MS) };
}

async function processPaymentEvent({ db, config, event, now = new Date() }) {
  if (!event || typeof event.orderId !== 'string' || !['paid', 'failed', 'refunded'].includes(event.status)) {
    return { result: 'ignored', reason: 'bad_event' };
  }
  const orderRef = db.collection('orders').doc(event.orderId);

  return db.runTransaction(async (tx) => {
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) return { result: 'ignored', reason: 'unknown_order' };
    const order = orderSnap.data();
    const current = order.status;

    if (event.providerRef && order.providerRef && event.providerRef !== order.providerRef) {
      return { result: 'ignored', reason: 'provider_ref_mismatch' };
    }

    // ---------------- FAILED ----------------
    if (event.status === 'failed') {
      if (current !== 'pending') return { result: 'noop', reason: `already_${current}` }; // paid/refunded/failed/cancelled: never downgrade
      tx.update(orderRef, {
        status: 'failed',
        failedReason: String(event.reason || 'payment_failed').slice(0, 160),
        ...(event.txnUid ? { providerTxnUid: event.txnUid } : {}),
        updatedAt: now,
      });
      return { result: 'failed' };
    }

    // amount + currency must equal what we stored, for money-moving events
    const amountOk = Number.isInteger(event.amountAgorot) && event.currency === order.currency;

    // ---------------- PAID ----------------
    if (event.status === 'paid') {
      if (current === 'paid' || current === 'refunded') return { result: 'noop', reason: `already_${current}` };
      if (!amountOk || event.amountAgorot !== order.totalAgorot) {
        tx.update(orderRef, { webhookAnomaly: 'amount_or_currency_mismatch', anomalyAt: now });
        return { result: 'rejected', reason: 'amount_or_currency_mismatch' };
      }
      const features = featuresFromOrder(order);
      const real = hasRealUser(order);

      // reads first (Firestore transactions require all reads before writes)
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
          const merged = mergeEntitlement(existing, grant, now);
          if (merged === null) return; // existing lifetime access stays as is
          tx.set(entRefs[i], { feature, productId: grant.productId, orderId: event.orderId, grantedAt: now, expiresAt: merged.expiresAt });
          granted.push(feature);
        });
        const cur = memberSnap.exists ? memberSnap.data() : {};
        const lifetime = (Number.isFinite(cur.lifetimeSpendAgorot) ? cur.lifetimeSpendAgorot : 0) + order.totalAgorot;
        tx.set(memberRef, {
          points: (Number.isFinite(cur.points) ? cur.points : 0) + points,
          lifetimeSpendAgorot: lifetime,
          ordersCount: (Number.isFinite(cur.ordersCount) ? cur.ordersCount : 0) + 1,
          tier: resolveTier(config.tiers, lifetime).id,
          updatedAt: now,
        });
      }
      tx.update(orderRef, {
        status: 'paid',
        paidAt: now,
        updatedAt: now,
        failedReason: null,
        webhookAnomaly: null,
        providerTxnUid: event.txnUid || null,
        ...(event.receiptUrl ? { receiptUrl: event.receiptUrl } : {}),
        pointsAwarded: real ? points : 0,
        spendAddedAgorot: real ? order.totalAgorot : 0,
        grantedFeatures: real ? [...features.keys()] : [],
      });
      return { result: 'paid', granted };
    }

    // ---------------- REFUNDED ----------------
    if (current === 'refunded') return { result: 'noop', reason: 'already_refunded' };
    if (current !== 'paid') return { result: 'ignored', reason: `refund_for_${current}` };
    if (!amountOk || event.amountAgorot <= 0 || event.amountAgorot > order.totalAgorot) {
      tx.update(orderRef, { webhookAnomaly: 'refund_amount_or_currency_mismatch', anomalyAt: now });
      return { result: 'rejected', reason: 'refund_amount_or_currency_mismatch' };
    }
    if (event.amountAgorot < order.totalAgorot) {
      // partial refund: idempotent overwrite, no automatic revoke - the owner decides
      tx.update(orderRef, { lastPartialRefundAgorot: event.amountAgorot, needsManualReview: true, updatedAt: now });
      return { result: 'partial_refund_flagged' };
    }

    const real = hasRealUser(order);
    const featureNames = Array.isArray(order.grantedFeatures) ? order.grantedFeatures : [...featuresFromOrder(order).keys()];
    const memberRef = real ? db.collection('members').doc(order.uid) : null;
    const memberSnap = real ? await tx.get(memberRef) : null;
    const entRefs = real ? featureNames.map((f) => db.collection('users').doc(order.uid).collection('entitlements').doc(f)) : [];
    const entSnaps = [];
    for (const r of entRefs) entSnaps.push(await tx.get(r));

    const revoked = [];
    if (real) {
      entRefs.forEach((r, i) => {
        // only revoke what THIS order controls (a later purchase may own the entitlement now)
        if (entSnaps[i].exists && entSnaps[i].data().orderId === event.orderId) {
          tx.delete(r);
          revoked.push(featureNames[i]);
        }
      });
      if (memberSnap.exists) {
        const cur = memberSnap.data();
        const lifetime = Math.max(0, (Number.isFinite(cur.lifetimeSpendAgorot) ? cur.lifetimeSpendAgorot : 0) - (order.spendAddedAgorot || 0));
        tx.set(memberRef, {
          points: Math.max(0, (Number.isFinite(cur.points) ? cur.points : 0) - (order.pointsAwarded || 0)),
          lifetimeSpendAgorot: lifetime,
          ordersCount: Math.max(0, (Number.isFinite(cur.ordersCount) ? cur.ordersCount : 0) - 1),
          tier: resolveTier(config.tiers, lifetime).id,
          updatedAt: now,
        });
      }
    }
    tx.update(orderRef, { status: 'refunded', refundedAt: now, refundedAgorot: order.totalAgorot, updatedAt: now });
    return { result: 'refunded', revoked };
  });
}

/**
 * HTTP layer. Returns via res: 405 (not POST), 401 (bad/missing signature), 200 (any correctly signed
 * request that we handled or deliberately ignored), 500 (our own transient failure: lets the provider retry
 * so a paid order is never lost; the transaction makes retries safe).
 */
async function handleWebhook({ req, res, provider, db, config, now = new Date() }) {
  if (req.method !== 'POST') {
    res.set && res.set('Allow', 'POST');
    res.status(405).json({ ok: false });
    return;
  }
  let verdict;
  try {
    verdict = provider.verifyWebhook(req);
  } catch (e) {
    log.error('webhook: verifyWebhook threw', { errType: e && e.name ? String(e.name) : 'Error' });
    res.status(500).json({ ok: false });
    return;
  }
  if (!verdict || verdict.ok !== true) {
    log.warn('webhook: rejected', { reason: verdict && verdict.reason ? String(verdict.reason) : 'bad_signature' });
    res.status(verdict && verdict.reason === 'not_configured' ? 500 : 401).json({ ok: false });
    return;
  }
  if (!verdict.event) {
    log.info('webhook: signed message without a payment event, ignored', {});
    res.status(200).json({ ok: true, ignored: true });
    return;
  }
  try {
    const out = await processPaymentEvent({ db, config, event: verdict.event, now });
    const level = out.result === 'rejected' ? 'error' : 'info';
    log[level]('webhook: processed', { orderId: verdict.event.orderId, event: verdict.event.status, result: out.result, reason: out.reason || '', uid: '-' });
    res.status(200).json({ ok: true });
  } catch (e) {
    log.error('webhook: processing error', { orderId: verdict.event && verdict.event.orderId, errType: e && e.name ? String(e.name) : 'Error', errCode: e && e.code !== undefined ? String(e.code).slice(0, 40) : '' });
    res.status(500).json({ ok: false });
  }
}

module.exports = { processPaymentEvent, handleWebhook, featuresFromOrder, mergeEntitlement };
