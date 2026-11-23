'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveTier, nextTier, computeDiscountAgorot, pointsForTotal, tierProgress } = require('../src/club');
const { config } = require('./helpers/fixtures');

const tiers = config.tiers;

test('tier boundaries (defaults: member 0, silver 20000, gold 60000)', () => {
  assert.equal(resolveTier(tiers, 0).id, 'member');
  assert.equal(resolveTier(tiers, 19999).id, 'member');
  assert.equal(resolveTier(tiers, 20000).id, 'silver');
  assert.equal(resolveTier(tiers, 59999).id, 'silver');
  assert.equal(resolveTier(tiers, 60000).id, 'gold');
  assert.equal(resolveTier(tiers, 10 ** 9).id, 'gold');
});

test('tier: invalid / negative spend falls back to base tier', () => {
  for (const v of [-1, -50000, NaN, undefined, null, Infinity * 0]) assert.equal(resolveTier(tiers, v).id, 'member');
});

test('nextTier / tierProgress', () => {
  assert.equal(nextTier(tiers, 'member').id, 'silver');
  assert.equal(nextTier(tiers, 'silver').id, 'gold');
  assert.equal(nextTier(tiers, 'gold'), null);
  assert.equal(nextTier(tiers, 'nope'), null);
  assert.deepEqual(tierProgress(tiers, 5000), { tier: 'member', discountPct: 0, next: 'silver', remainingAgorot: 15000 });
  assert.deepEqual(tierProgress(tiers, 60000), { tier: 'gold', discountPct: 10, next: null, remainingAgorot: 0 });
});

test('discount per tier: 0 / 5 / 10 percent', () => {
  assert.equal(computeDiscountAgorot(10000, 0), 0);
  assert.equal(computeDiscountAgorot(10000, 5), 500);
  assert.equal(computeDiscountAgorot(10000, 10), 1000);
});

test('discount rounding: half up to nearest agora, never exceeds subtotal', () => {
  assert.equal(computeDiscountAgorot(990, 5), 50); // 49.5 -> 50
  assert.equal(computeDiscountAgorot(989, 5), 49); // 49.45 -> 49
  assert.equal(computeDiscountAgorot(1, 5), 0);
  assert.equal(computeDiscountAgorot(10, 50), 5);
  assert.equal(computeDiscountAgorot(1001, 2.5), 25); // 25.025 -> 25 (bp arithmetic, no float drift)
  assert.equal(computeDiscountAgorot(500, 100), 500);
  assert.equal(computeDiscountAgorot(500, 250), 500); // clamped
});

test('discount: invalid inputs give 0', () => {
  for (const [s, p] of [[0, 10], [-5, 10], [1.5, 10], [1000, -1], [1000, NaN], ['1000', 10]]) assert.equal(computeDiscountAgorot(s, p), 0);
});

test('points: 1 per shekel paid, floored', () => {
  assert.equal(pointsForTotal(0, 1), 0);
  assert.equal(pointsForTotal(99, 1), 0);
  assert.equal(pointsForTotal(100, 1), 1);
  assert.equal(pointsForTotal(19999, 1), 199);
  assert.equal(pointsForTotal(20000, 1), 200);
  assert.equal(pointsForTotal(20000, 2), 400);
  assert.equal(pointsForTotal(20000, 0.5), 100);
  assert.equal(pointsForTotal(20000, 0), 0);
  assert.equal(pointsForTotal(-100, 1), 0);
  assert.equal(pointsForTotal(1.5, 1), 0);
});
