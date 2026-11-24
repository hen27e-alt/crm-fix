'use strict';
/**
 * HTTP layer of the payment webhook. The money logic lives in payments.js (shared with capture.js).
 *
 * Returns: 405 (not POST), 401 (bad/missing signature), 200 (any correctly signed request that we handled or
 * deliberately ignored), 500 (our own transient failure: lets the provider retry so a paid order is never lost;
 * the transaction makes retries safe).
 * Event status 'approved' (PayPal CHECKOUT.ORDER.APPROVED) triggers a server-side capture - a backup for the
 * case where the buyer closed the tab before the frontend could call capturePayPalOrder.
 */
const { processPaymentEvent, featuresFromOrder, coinsFromOrder } = require('./payments');
const { captureOrderCore } = require('./capture');
const log = require('./log');

async function handleWebhook({ req, res, provider, db, config, now = new Date() }) {
  if (req.method !== 'POST') {
    res.set && res.set('Allow', 'POST');
    res.status(405).json({ ok: false });
    return;
  }
  let verdict;
  try {
    verdict = await provider.verifyWebhook(req); // may be sync or async (PayPal verifies via an API call)
  } catch (e) {
    log.error('webhook: verifyWebhook threw', { errType: e && e.name ? String(e.name) : 'Error', errCode: e && e.code ? String(e.code).slice(0, 40) : '' });
    res.status(500).json({ ok: false });
    return;
  }
  if (!verdict || verdict.ok !== true) {
    const reason = verdict && verdict.reason ? String(verdict.reason) : 'bad_signature';
    log.warn('webhook: rejected', { reason });
    res.status(reason === 'not_configured' || reason === 'verify_unavailable' ? 500 : 401).json({ ok: false });
    return;
  }
  const ev = verdict.event;
  if (!ev) {
    log.info('webhook: signed message without a payment event, ignored', {});
    res.status(200).json({ ok: true, ignored: true });
    return;
  }
  try {
    if (ev.status === 'approved') {
      if (typeof provider.capture !== 'function' || !ev.orderId) {
        res.status(200).json({ ok: true, ignored: true });
        return;
      }
      let status = 'error';
      try {
        const out = await captureOrderCore({ db, provider, config, orderId: ev.orderId, uid: null, expectedProviderRef: ev.providerRef || null, now });
        status = out.status;
      } catch (e) {
        // client-style errors (order not capturable/unknown) are final; provider outages must be retried
        if (e && e.code === 'unavailable') throw e;
        log.warn('webhook: approved event not captured', { orderId: ev.orderId, code: e && e.code ? String(e.code) : '' });
      }
      log.info('webhook: approved handled', { orderId: ev.orderId, result: status });
      res.status(200).json({ ok: true });
      return;
    }
    const out = await processPaymentEvent({ db, config, event: ev, now });
    const level = out.result === 'rejected' ? 'error' : 'info';
    log[level]('webhook: processed', { orderId: ev.orderId || '-', event: ev.status, result: out.result, reason: out.reason || '' });
    res.status(200).json({ ok: true });
  } catch (e) {
    log.error('webhook: processing error', { orderId: ev && ev.orderId ? ev.orderId : '-', errType: e && e.name ? String(e.name) : 'Error', errCode: e && e.code !== undefined ? String(e.code).slice(0, 40) : '' });
    res.status(500).json({ ok: false });
  }
}

module.exports = { handleWebhook, processPaymentEvent, featuresFromOrder, coinsFromOrder };
