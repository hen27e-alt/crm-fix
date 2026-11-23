'use strict';
/**
 * Pure club math: tiers, discount, points. No I/O. All money in integer agorot.
 * Tiers come from club.config.json: [{id, minSpendAgorot, discountPct}] sorted ascending.
 */

/** Highest tier whose minSpendAgorot <= lifetimeSpendAgorot. Negative/invalid spend -> base tier. */
function resolveTier(tiers, lifetimeSpendAgorot) {
  const spend = Number.isFinite(lifetimeSpendAgorot) ? Math.max(0, Math.floor(lifetimeSpendAgorot)) : 0;
  let current = tiers[0];
  for (const t of tiers) {
    if (spend >= t.minSpendAgorot) current = t;
    else break;
  }
  return current;
}

/** Next tier above the given one, or null. */
function nextTier(tiers, tierId) {
  const i = tiers.findIndex((t) => t.id === tierId);
  return i >= 0 && i < tiers.length - 1 ? tiers[i + 1] : null;
}

/**
 * Discount in agorot for a subtotal. Rounded to the nearest agora (half up), never
 * more than the subtotal, never negative. pct is a number 0..100 (can be fractional).
 */
function computeDiscountAgorot(subtotalAgorot, discountPct) {
  if (!Number.isInteger(subtotalAgorot) || subtotalAgorot <= 0) return 0;
  if (!Number.isFinite(discountPct) || discountPct <= 0) return 0;
  const pct = Math.min(discountPct, 100);
  // Use integer arithmetic on pct * 100 (basis points) to avoid float drift: 2.5% -> 250 bp.
  const bp = Math.round(pct * 100);
  const d = Math.floor((subtotalAgorot * bp + 5000) / 10000);
  return Math.min(Math.max(d, 0), subtotalAgorot);
}

/** Points earned for a paid total: floor(total in shekels * perShekel). */
function pointsForTotal(totalAgorot, perShekel) {
  if (!Number.isInteger(totalAgorot) || totalAgorot <= 0) return 0;
  if (!Number.isFinite(perShekel) || perShekel <= 0) return 0;
  // perShekel may be fractional (e.g. 0.5): use basis points again.
  const ppsBp = Math.round(perShekel * 100);
  return Math.floor((totalAgorot * ppsBp) / 10000);
}

/** Progress toward the next tier for display / tests. */
function tierProgress(tiers, lifetimeSpendAgorot) {
  const tier = resolveTier(tiers, lifetimeSpendAgorot);
  const next = nextTier(tiers, tier.id);
  return {
    tier: tier.id,
    discountPct: tier.discountPct,
    next: next ? next.id : null,
    remainingAgorot: next ? Math.max(0, next.minSpendAgorot - Math.max(0, lifetimeSpendAgorot || 0)) : 0,
  };
}

module.exports = { resolveTier, nextTier, computeDiscountAgorot, pointsForTotal, tierProgress };
