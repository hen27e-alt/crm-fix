'use strict';
/**
 * Server-side capture for providers that need it (PayPal Orders v2: the buyer approves, the MERCHANT captures).
 * Used by the `capturePayPalOrder` callable (buyer returned) and by the webhook (CHECKOUT.ORDER.APPROVED backup).
 * Never takes a provider order id from the client: it uses the one stored on OUR order when it was created.
 */
const { httpsError, MSG } = require('./errors');
const { processPaymentEvent } = require('./payments');
const { logId } = require('./util');
const log = require('./log');

const CAPTURABLE = new Set(['pending', 'failed']);

/**
 * @param {string|null} p.uid  caller uid (callable) - must own the order; null for the system (webhook)
 * @returns {{status:'paid'|'pending'|'failed'|'not_approved'|'refunded', orderId}}
 */
async function captureOrderCore({ db, provider, config, orderId, uid = null, expectedProviderRef = null, now = new Date() }) {
  if (typeof provider.capture !== 'function') throw httpsError('failed-precondition', MSG.noCapture);
  if (typeof orderId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(orderId)) throw httpsError('invalid-argument', MSG.badRequest);

  const ref = db.collection('orders').doc(orderId);
  const snap = await ref.get();
  // same answer for "missing" and "not yours": no probing of other users' orders
  if (!snap.exists || (uid !== null && snap.data().uid !== uid)) throw httpsError('not-found', MSG.notFound);
  const order = snap.data();

  if (order.status === 'paid' || order.status === 'refunded') return { status: order.status, orderId }; // idempotent
  if (!CAPTURABLE.has(order.status) || !order.providerRef || order.uid === 'deleted') {
    throw httpsError('failed-precondition', MSG.notFound);
  }
  if (expectedProviderRef && expectedProviderRef !== order.providerRef) {
    log.warn('capture: provider order id does not match stored order', { orderId });
    throw httpsError('failed-precondition', MSG.notFound);
  }

  let result;
  try {
    result = await provider.capture({ order: { id: orderId, totalAgorot: order.totalAgorot, currency: order.currency }, providerRef: order.providerRef });
  } catch (e) {
    log.error('capture: provider capture failed', { orderId, uid: uid ? logId(uid) : '-', code: e && e.code ? String(e.code) : 'unknown', detail: e && e.name === 'ProviderError' ? String(e.message).slice(0, 120) : '' });
    throw httpsError('unavailable', MSG.provider);
  }
  if (result.state !== 'event') return { status: result.state, orderId }; // 'not_approved' | 'pending'

  const out = await processPaymentEvent({ db, config, event: { ...result.event, orderId }, now });
  log.info('capture: processed', { orderId, result: out.result, reason: out.reason || '' });
  const after = (await ref.get()).data();
  return { status: after.status === 'paid' ? 'paid' : after.status === 'failed' ? 'failed' : after.status, orderId };
}

module.exports = { captureOrderCore };
