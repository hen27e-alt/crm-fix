'use strict';
const { validateCartInput, buildOrder } = require('./cart');
const { resolveTier } = require('./club');
const { httpsError, MSG, HttpsError } = require('./errors');
const { cleanText, normalizePhone, logId } = require('./util');
const log = require('./log');

const HOUR_MS = 60 * 60 * 1000;

function buildReturnUrls(config, orderId) {
  const mk = (state) => {
    const u = new URL(config.returnPath, config.siteUrl);
    u.searchParams.set('checkout', state);
    u.searchParams.set('order', orderId);
    return u.toString();
  };
  return { successUrl: mk('success'), cancelUrl: mk('cancel') };
}

/**
 * Core of the `createCheckout` callable. Pure w.r.t. framework: everything is injected so it can be unit-tested.
 * @param {object} p
 * @param {object} p.db        Firestore (admin) instance
 * @param {object} p.provider  payment provider adapter
 * @param {object} p.config    validated club config
 * @param {string} p.uid       authenticated user id (from request.auth, never from the payload)
 * @param {object} p.token     decoded auth token (email, phone_number, name) - used only for the provider customer record
 * @param {*}      p.data      raw client payload
 * @param {Date}   p.now
 * @param {string} p.webhookUrl
 */
async function createCheckoutCore({ db, provider, config, uid, token, data, now = new Date(), webhookUrl }) {
  if (typeof uid !== 'string' || !uid) throw httpsError('unauthenticated', MSG.unauthenticated);
  const { lines } = validateCartInput(data, config.limits);
  if (!config.siteUrl || !webhookUrl) {
    log.error('checkout: siteUrl/webhookUrl not configured', {});
    throw httpsError('failed-precondition', MSG.notConfigured);
  }

  // --- server-side pricing: only productId+qty came from the client ---
  const productRefs = lines.map((l) => db.collection('products').doc(l.productId));
  const [productSnaps, memberSnap, userSnap] = await Promise.all([
    db.getAll(...productRefs),
    db.collection('members').doc(uid).get(),
    db.collection('users').doc(uid).get(),
  ]);
  const productsById = new Map();
  productSnaps.forEach((s, i) => productsById.set(lines[i].productId, s.exists ? s.data() : null));

  const lifetime = memberSnap.exists && Number.isFinite(memberSnap.data().lifetimeSpendAgorot) ? memberSnap.data().lifetimeSpendAgorot : 0;
  const tier = resolveTier(config.tiers, lifetime);

  const built = buildOrder(lines, productsById, {
    discountPct: tier.discountPct,
    currency: config.currency,
    maxOrderTotalAgorot: config.limits.maxOrderTotalAgorot,
  });

  const orderRef = db.collection('orders').doc();
  const orderId = orderRef.id;
  const order = {
    uid,
    appId: config.appId,
    status: 'pending',
    items: built.items,
    subtotalAgorot: built.subtotalAgorot,
    discountAgorot: built.discountAgorot,
    totalAgorot: built.totalAgorot,
    currency: config.currency,
    memberTier: tier.id,
    discountPct: tier.discountPct,
    provider: config.provider,
    consent: true,
    termsAcceptedAt: now,
    createdAt: now,
  };

  // --- rate limit + create in ONE transaction (concurrent requests cannot both slip under the limit) ---
  const since = new Date(now.getTime() - HOUR_MS);
  await db.runTransaction(async (tx) => {
    const q = db
      .collection('orders')
      .where('uid', '==', uid)
      .where('status', '==', 'pending')
      .where('createdAt', '>=', since)
      .limit(config.limits.maxPendingOrdersPerHour);
    const snap = await tx.get(q);
    if (snap.size >= config.limits.maxPendingOrdersPerHour) throw httpsError('resource-exhausted', MSG.rate);
    tx.set(orderRef, order);
  });

  // --- customer record for the provider (not stored on the order; not logged) ---
  const u = userSnap.exists ? userSnap.data() : {};
  const customer = {
    name: cleanText(u.displayName || (token && token.name) || '', 100),
    email: cleanText((token && token.email) || u.email || '', 254),
    phone: normalizePhone((token && token.phone_number) || u.phone || ''),
  };
  const { successUrl, cancelUrl } = buildReturnUrls(config, orderId);

  let page;
  try {
    page = await provider.createPaymentPage({
      order: { id: orderId, items: built.items, subtotalAgorot: built.subtotalAgorot, discountAgorot: built.discountAgorot, totalAgorot: built.totalAgorot, currency: config.currency },
      customer,
      successUrl,
      cancelUrl,
      webhookUrl,
    });
  } catch (e) {
    log.error('checkout: provider createPaymentPage failed', { orderId, uid: logId(uid), code: e && e.code ? String(e.code) : 'unknown', detail: e && e.name === 'ProviderError' ? String(e.message).slice(0, 120) : '' });
    try {
      await orderRef.update({ status: 'failed', failedReason: 'provider_error' });
    } catch (e2) {
      log.error('checkout: could not mark order failed', { orderId });
    }
    if (e && e.code === 'not_configured') throw httpsError('failed-precondition', MSG.notConfigured);
    throw httpsError('unavailable', MSG.provider);
  }

  await orderRef.update({ providerRef: page.providerRef });
  if (userSnap.exists && !u.termsAcceptedAt) {
    // best effort: record the FIRST terms acceptance on the profile (each order also keeps its own termsAcceptedAt)
    try {
      await db.collection('users').doc(uid).update({ termsAcceptedAt: now });
    } catch (_) {
      /* non-fatal */
    }
  }
  log.info('checkout: order created', { orderId, uid: logId(uid), totalAgorot: built.totalAgorot, lines: built.items.length, tier: tier.id });
  return { orderId, paymentUrl: page.paymentUrl };
}

/** Wraps the core so only HttpsErrors reach the client. */
async function createCheckoutSafe(params) {
  try {
    return await createCheckoutCore(params);
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    log.error('checkout: unexpected error', { errType: e && e.name ? String(e.name) : 'Error', errCode: e && e.code !== undefined ? String(e.code).slice(0, 40) : '' });
    throw httpsError('internal', MSG.internal);
  }
}

module.exports = { createCheckoutCore, createCheckoutSafe, buildReturnUrls };
