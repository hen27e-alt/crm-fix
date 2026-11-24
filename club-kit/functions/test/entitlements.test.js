'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeExpiry, addContribution, removeContribution, isActive, DAY_MS } = require('../src/entitlements');

const T0 = new Date('2026-06-01T00:00:00Z');
const at = (days) => new Date(T0.getTime() + days * DAY_MS);
const g = (orderId, days, extra = {}) => ({ orderId, productId: 'p', lifetime: days === null, days, ...extra });

test('single time-limited contribution expires days after purchase', () => {
  const d = addContribution('f', null, g('A', 30), T0);
  assert.equal(d.expiresAt.getTime(), at(30).getTime());
  assert.deepEqual([d.orderId, d.feature, d.contributions.length], ['A', 'f', 1]);
});

test('purchases stack on the remaining time (A 30d at day 0, B 30d at day 5 -> day 60)', () => {
  let d = addContribution('f', null, g('A', 30), at(0));
  d = addContribution('f', d, g('B', 30), at(5));
  assert.equal(d.expiresAt.getTime(), at(60).getTime());
  assert.equal(d.orderId, 'B');
});

test('an expired entitlement restarts from the new purchase', () => {
  let d = addContribution('f', null, g('A', 30), at(0));
  d = addContribution('f', d, g('B', 30), at(100));
  assert.equal(d.expiresAt.getTime(), at(130).getTime());
});

test('REFUND of the first order keeps what the second order paid for (CK3 scenario 1)', () => {
  let d = addContribution('f', null, g('A', 30), at(0));
  d = addContribution('f', d, g('B', 30), at(5));
  const after = removeContribution('f', d, 'A');
  assert.equal(after.expiresAt.getTime(), at(35).getTime()); // B alone: day 5 + 30
  assert.equal(after.orderId, 'B');
});

test('REFUND of the last order keeps what the first order paid for (CK3 scenario 2) - not deleted', () => {
  let d = addContribution('f', null, g('A', 30), at(0));
  d = addContribution('f', d, g('B', 30), at(5));
  const after = removeContribution('f', d, 'B');
  assert.equal(after.expiresAt.getTime(), at(30).getTime());
  assert.equal(after.orderId, 'A');
});

test('refund of the only contribution -> null (document must be deleted)', () => {
  const d = addContribution('f', null, g('A', 30), at(0));
  assert.equal(removeContribution('f', d, 'A'), null);
  assert.equal(removeContribution('f', null, 'A'), null);
});

test('lifetime wins; refunding the lifetime order falls back to the time-limited one', () => {
  let d = addContribution('f', null, g('A', 30), at(0));
  d = addContribution('f', d, g('L', null), at(1));
  assert.equal(d.expiresAt, null);
  assert.equal(removeContribution('f', d, 'L').expiresAt.getTime(), at(30).getTime());
});

test('re-adding the same order replaces its contribution (idempotent)', () => {
  let d = addContribution('f', null, g('A', 30), at(0));
  d = addContribution('f', d, g('A', 30), at(0));
  assert.equal(d.contributions.length, 1);
});

test('legacy doc (no contributions) keeps its expiry and can be refunded away', () => {
  const legacy = { feature: 'f', productId: 'p', orderId: 'OLD', grantedAt: at(0), expiresAt: at(20) };
  const d = addContribution('f', legacy, g('B', 30), at(5));
  assert.equal(d.expiresAt.getTime(), at(50).getTime()); // stacks on the 20 remaining legacy days
  assert.equal(removeContribution('f', d, 'B').expiresAt.getTime(), at(20).getTime());
  assert.equal(removeContribution('f', legacy, 'OLD'), null);
  assert.equal(computeExpiry([{ orderId: 'x', legacy: true, untilMs: null, at: at(0) }]), null);
});

test('isActive: lifetime, future, past, missing', () => {
  assert.equal(isActive({ expiresAt: null }, T0), true);
  assert.equal(isActive({ expiresAt: at(1) }, T0), true);
  assert.equal(isActive({ expiresAt: at(-1) }, T0), false);
  assert.equal(isActive({ expiresAt: T0 }, T0), false);
  assert.equal(isActive(null, T0), false);
  assert.equal(isActive({ expiresAt: { toDate: () => at(1) } }, T0), true);
});
