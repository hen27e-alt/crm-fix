'use strict';
/**
 * Entitlement model with per-order CONTRIBUTIONS (pure functions, no I/O).
 *
 * users/{uid}/entitlements/{feature} =
 *   { feature, productId, orderId, grantedAt, expiresAt|null,            // contract fields (orderId/productId = latest purchase)
 *     contributions: [{ orderId, productId, days|null, at }] }          // days:null = lifetime
 *
 * expiresAt is DERIVED from the contributions, so a refund recomputes exactly what the remaining paid
 * orders still entitle to (instead of deleting everything or keeping everything):
 *   - any lifetime contribution => lifetime (expiresAt null)
 *   - otherwise time-limited contributions stack in order of purchase: each one starts at the later of
 *     its own purchase time and the end of the previous one.
 * Legacy docs without `contributions` are converted to one contribution that keeps their old expiry.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

function toMs(v) {
  if (v instanceof Date) return v.getTime();
  if (v && typeof v.toDate === 'function') return v.toDate().getTime();
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}

/** Contributions of an existing entitlement doc (null/undefined -> []). */
function contributionsOf(doc) {
  if (!doc) return [];
  if (Array.isArray(doc.contributions)) return doc.contributions.map((c) => ({ ...c }));
  // legacy doc
  const exp = doc.expiresAt === null || doc.expiresAt === undefined ? null : toMs(doc.expiresAt);
  return [{ orderId: doc.orderId || 'legacy', productId: doc.productId || '', days: null, untilMs: exp, legacy: true, at: doc.grantedAt || new Date(0) }];
}

/** Expiry (Date, or null = lifetime) derived from contributions. Returns undefined when there are none. */
function computeExpiry(contribs) {
  if (!contribs.length) return undefined;
  const sorted = contribs.map((c, i) => ({ c, i })).sort((a, b) => (toMs(a.c.at) - toMs(b.c.at)) || a.i - b.i).map((x) => x.c);
  let cur = null; // ms
  for (const c of sorted) {
    if (c.legacy) {
      if (c.untilMs === null) return null; // legacy lifetime
      cur = cur === null ? c.untilMs : Math.max(cur, c.untilMs);
      continue;
    }
    if (c.days === null || c.days === undefined) return null; // lifetime
    const at = toMs(c.at);
    const start = cur !== null && cur > at ? cur : at;
    cur = start + c.days * DAY_MS;
  }
  return new Date(cur);
}

function buildDoc(feature, contribs) {
  if (!contribs.length) return null;
  const sorted = contribs.map((c, i) => ({ c, i })).sort((a, b) => (toMs(a.c.at) - toMs(b.c.at)) || a.i - b.i).map((x) => x.c);
  const last = sorted[sorted.length - 1];
  return {
    feature,
    productId: last.productId || '',
    orderId: last.orderId,
    grantedAt: last.at,
    expiresAt: computeExpiry(contribs),
    contributions: contribs.map((c) => {
      const o = { orderId: c.orderId, productId: c.productId || '', days: c.days === undefined ? null : c.days, at: c.at };
      if (c.legacy) {
        o.legacy = true;
        o.untilMs = c.untilMs;
      }
      return o;
    }),
  };
}

/** Add (or replace the same order's) contribution. `grant` = {lifetime, days, productId}. Returns the new doc. */
function addContribution(feature, existingDoc, { orderId, productId, lifetime, days }, at) {
  const rest = contributionsOf(existingDoc).filter((c) => c.orderId !== orderId);
  rest.push({ orderId, productId, days: lifetime ? null : days, at });
  return buildDoc(feature, rest);
}

/** Remove an order's contribution. Returns the new doc, or null when nothing remains (=> delete the doc). */
function removeContribution(feature, existingDoc, orderId) {
  const rest = contributionsOf(existingDoc).filter((c) => c.orderId !== orderId);
  return buildDoc(feature, rest);
}

/** Server-side check: does this entitlement doc currently grant access? */
function isActive(doc, now = new Date()) {
  if (!doc) return false;
  if (doc.expiresAt === null || doc.expiresAt === undefined) return true;
  const ms = toMs(doc.expiresAt);
  return ms !== null && ms > now.getTime();
}

module.exports = { computeExpiry, addContribution, removeContribution, contributionsOf, isActive, DAY_MS };
