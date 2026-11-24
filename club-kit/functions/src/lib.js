'use strict';
/**
 * Reusable building blocks for OTHER Firebase functions packages (e.g. Game Night's coin shop).
 * Everything here is dependency-injected (db, provider, config are arguments) and has no knowledge of the
 * club-kit order schema beyond what is documented in payments.js, so a second package can either
 *   - copy these files (src/providers/paypal.js, src/util.js, src/log.js, src/errors.js, src/age.js [, src/payments.js, src/capture.js]), or
 *   - require this module from a checkout of the kit.
 *
 * Typical use for a "buy a coin pack" shop that keeps its own order documents:
 *
 *   const { createPayPalAdapter } = require('.../src/lib');
 *   const paypal = require('.../src/providers/paypal');          // ready adapter bound to the 4 PAYPAL_* secrets
 *   // createCoinOrder:  const { paymentUrl, providerRef } = await paypal.createPaymentPage({ order, customer: {}, successUrl, cancelUrl });
 *   //                   order = { id: <your orderId>, items:[{name, priceAgorot, qty}], discountAgorot:0, totalAgorot, currency:'ILS' }
 *   //                   successUrl/cancelUrl are YOURS (e.g. https://site/?paypal=success&order=<orderId>)
 *   // captureCoinOrder: const r = await paypal.capture({ order: { id: orderId, totalAgorot, currency:'ILS' }, providerRef });
 *   //                   r = { state:'event', event:{status:'paid'|'failed', amountAgorot, currency, txnUid, ...} }
 *   //                       | { state:'pending' } | { state:'not_approved' }
 *   //                   -> compare event.amountAgorot/currency with YOUR stored order, then credit coins in ONE transaction,
 *   //                      keyed on event.txnUid (idempotent) - or reuse processPaymentEvent with the kit's order schema.
 *   // webhook:          onRequest(handler) with handleWebhook({ req, res, provider: paypal, db, config })
 */
const { createPayPalAdapter, ProviderError } = require('./providers/paypal');
const { processPaymentEvent, featuresFromOrder, coinsFromOrder } = require('./payments');
const { captureOrderCore } = require('./capture');
const { handleWebhook } = require('./webhook');
const { declareAgeCore, assertAdult, parseBirthDate, ageOn, israelToday } = require('./age');
const { addContribution, removeContribution, computeExpiry, isActive } = require('./entitlements');
const { computeDiscountAgorot, pointsForTotal, resolveTier, nextTier, tierProgress } = require('./club');
const { safeEqual, cleanText, normalizePhone, shekelToAgorot, agorotToShekel, logId } = require('./util');
const { MSG, httpsError, HttpsError } = require('./errors');
const log = require('./log');

module.exports = {
  // PayPal
  createPayPalAdapter, ProviderError,
  // payment state machine / capture / webhook
  processPaymentEvent, captureOrderCore, handleWebhook, featuresFromOrder, coinsFromOrder,
  // age gate
  declareAgeCore, assertAdult, parseBirthDate, ageOn, israelToday,
  // entitlements
  addContribution, removeContribution, computeExpiry, isActive,
  // club math
  computeDiscountAgorot, pointsForTotal, resolveTier, nextTier, tierProgress,
  // utils
  safeEqual, cleanText, normalizePhone, shekelToAgorot, agorotToShekel, logId, MSG, httpsError, HttpsError, log,
};
