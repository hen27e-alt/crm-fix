'use strict';
/**
 * Cart validation and server-side pricing. Pure (no I/O).
 * The client supplies ONLY productId + qty; every price/name/grant comes from the product docs.
 */
const { httpsError, MSG } = require('./errors');
const { computeDiscountAgorot } = require('./club');

const MAX_COINS_PER_UNIT = 10000000;
const PRODUCT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Validates the raw callable payload. Returns { lines: [{productId, qty}] (merged, unique), consent: true }.
 * Throws HttpsError('invalid-argument', Hebrew message) otherwise.
 */
function validateCartInput(data, limits) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw httpsError('invalid-argument', MSG.badRequest);
  if (data.consent !== true) throw httpsError('invalid-argument', MSG.consent);
  const items = data.items;
  if (!Array.isArray(items)) throw httpsError('invalid-argument', MSG.badRequest);
  if (items.length === 0) throw httpsError('invalid-argument', MSG.emptyCart);
  if (items.length > limits.maxLines) throw httpsError('invalid-argument', MSG.tooManyLines);

  const merged = new Map();
  for (const it of items) {
    if (it === null || typeof it !== 'object' || Array.isArray(it)) throw httpsError('invalid-argument', MSG.badRequest);
    const { productId, qty } = it;
    if (typeof productId !== 'string' || !PRODUCT_ID_RE.test(productId)) throw httpsError('invalid-argument', MSG.badRequest);
    if (!Number.isInteger(qty) || qty < 1 || qty > limits.maxQtyPerLine) throw httpsError('invalid-argument', MSG.badQty);
    const total = (merged.get(productId) || 0) + qty;
    // duplicates are merged, but the merged quantity obeys the same cap (no bypass by splitting lines)
    if (total > limits.maxQtyPerLine) throw httpsError('invalid-argument', MSG.badQty);
    merged.set(productId, total);
  }
  return { lines: [...merged].map(([productId, qty]) => ({ productId, qty })), consent: true };
}

/** A product doc is purchasable only when it is well-formed AND active. */
function isPurchasable(p, currency) {
  return (
    p !== null &&
    typeof p === 'object' &&
    p.active === true &&
    typeof p.name === 'string' &&
    p.name.length > 0 &&
    Number.isInteger(p.priceAgorot) &&
    p.priceAgorot > 0 &&
    p.priceAgorot <= 100000000 &&
    p.currency === currency &&
    // optional coin pack field: when present it must be a sane positive integer
    (p.coins === undefined || (Number.isInteger(p.coins) && p.coins > 0 && p.coins <= MAX_COINS_PER_UNIT)) &&
    (p.noDiscount === undefined || typeof p.noDiscount === 'boolean')
  );
}

/**
 * Builds order items + totals from validated lines and a Map productId -> product data.
 * Throws failed-precondition when any product is missing/inactive/malformed.
 */
function buildOrder(lines, productsById, { discountPct, currency, maxOrderTotalAgorot }) {
  const items = [];
  let subtotal = 0;
  let discountableSubtotal = 0;
  for (const { productId, qty } of lines) {
    const p = productsById.get(productId);
    if (!isPurchasable(p, currency)) throw httpsError('failed-precondition', MSG.unavailable);
    const grants = Array.isArray(p.grants) ? p.grants.filter((g) => typeof g === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(g)) : [];
    const accessDays = Number.isInteger(p.accessDays) && p.accessDays > 0 ? p.accessDays : null;
    items.push({
      productId,
      name: p.name.slice(0, 200),
      priceAgorot: p.priceAgorot,
      qty,
      // snapshot of what this purchase entitles to, so a later product edit cannot change a paid order
      grants,
      accessDays,
      coins: p.coins === undefined ? 0 : p.coins, // coins credited PER UNIT (coin packs); 0 for ordinary products
      noDiscount: p.noDiscount === true, // coin packs etc. can opt out of the club tier discount
    });
    subtotal += p.priceAgorot * qty;
    if (p.noDiscount !== true) discountableSubtotal += p.priceAgorot * qty;
  }
  const discountAgorot = computeDiscountAgorot(discountableSubtotal, discountPct);
  const totalAgorot = subtotal - discountAgorot;
  if (!Number.isSafeInteger(subtotal) || totalAgorot <= 0 || totalAgorot > maxOrderTotalAgorot) {
    throw httpsError('failed-precondition', totalAgorot > maxOrderTotalAgorot ? MSG.tooLarge : MSG.unavailable);
  }
  return { items, subtotalAgorot: subtotal, discountAgorot, totalAgorot };
}

module.exports = { MAX_COINS_PER_UNIT, validateCartInput, isPurchasable, buildOrder, PRODUCT_ID_RE };
