'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCartInput, buildOrder, isPurchasable } = require('../src/cart');
const { config, product } = require('./helpers/fixtures');

const L = config.limits;
const ok = (items, extra = {}) => ({ items, consent: true, ...extra });
const code = (fn) => {
  try {
    fn();
  } catch (e) {
    return e.code;
  }
  return null;
};

test('valid cart is accepted and duplicates are merged', () => {
  const r = validateCartInput(ok([{ productId: 'p1', qty: 2 }, { productId: 'p2', qty: 1 }, { productId: 'p1', qty: 3 }]), L);
  assert.deepEqual(r.lines, [{ productId: 'p1', qty: 5 }, { productId: 'p2', qty: 1 }]);
});

test('consent must be exactly true', () => {
  for (const c of [false, undefined, 'true', 1, null]) assert.equal(code(() => validateCartInput({ items: [{ productId: 'p1', qty: 1 }], consent: c }, L)), 'invalid-argument');
});

test('quantity must be an integer 1..10 (boundaries)', () => {
  assert.equal(code(() => validateCartInput(ok([{ productId: 'p1', qty: 1 }]), L)), null);
  assert.equal(code(() => validateCartInput(ok([{ productId: 'p1', qty: 10 }]), L)), null);
  for (const q of [0, 11, -1, 1.5, '2', null, undefined, NaN, Infinity]) assert.equal(code(() => validateCartInput(ok([{ productId: 'p1', qty: q }]), L)), 'invalid-argument', String(q));
});

test('merged duplicate quantity cannot exceed the cap (no bypass by splitting lines)', () => {
  assert.equal(code(() => validateCartInput(ok([{ productId: 'p1', qty: 6 }, { productId: 'p1', qty: 5 }]), L)), 'invalid-argument');
});

test('line count: 20 ok, 21 rejected, 0 rejected', () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ productId: 'p' + i, qty: 1 }));
  assert.equal(code(() => validateCartInput(ok(mk(20)), L)), null);
  assert.equal(code(() => validateCartInput(ok(mk(21)), L)), 'invalid-argument');
  assert.equal(code(() => validateCartInput(ok([]), L)), 'invalid-argument');
});

test('malformed payloads are rejected', () => {
  for (const d of [null, undefined, 'x', 5, [], {}, { consent: true }, { consent: true, items: 'p1' }, { consent: true, items: [null] }, { consent: true, items: [['p1', 1]] }]) {
    assert.equal(code(() => validateCartInput(d, L)), 'invalid-argument', JSON.stringify(d));
  }
  for (const id of ['', ' ', 'a/b', '../x', 'x'.repeat(65), 5, null, 'a b', 'ש']) assert.equal(code(() => validateCartInput(ok([{ productId: id, qty: 1 }]), L)), 'invalid-argument', String(id));
});

test('client-sent price/name fields are ignored (only productId+qty are read)', () => {
  const r = validateCartInput(ok([{ productId: 'p1', qty: 1, priceAgorot: 1, name: 'x', total: 0 }], { totalAgorot: 1 }), L);
  assert.deepEqual(r.lines, [{ productId: 'p1', qty: 1 }]);
});

const opts = (pct = 0) => ({ discountPct: pct, currency: 'ILS', maxOrderTotalAgorot: L.maxOrderTotalAgorot });

test('order totals: subtotal, discount per tier, total', () => {
  const products = new Map([['p1', product({ priceAgorot: 10000 })], ['p2', product({ priceAgorot: 2500, grants: ['b'], accessDays: 30 })]]);
  const lines = [{ productId: 'p1', qty: 2 }, { productId: 'p2', qty: 1 }];
  let o = buildOrder(lines, products, opts(0));
  assert.deepEqual([o.subtotalAgorot, o.discountAgorot, o.totalAgorot], [22500, 0, 22500]);
  o = buildOrder(lines, products, opts(5));
  assert.deepEqual([o.subtotalAgorot, o.discountAgorot, o.totalAgorot], [22500, 1125, 21375]);
  o = buildOrder(lines, products, opts(10));
  assert.deepEqual([o.subtotalAgorot, o.discountAgorot, o.totalAgorot], [22500, 2250, 20250]);
  assert.equal(o.items[1].accessDays, 30);
  assert.deepEqual(o.items[0].grants, ['feat_a']);
});

test('missing, inactive, malformed or wrong-currency products are rejected', () => {
  const bad = [null, product({ active: false }), product({ priceAgorot: 0 }), product({ priceAgorot: -5 }), product({ priceAgorot: 10.5 }), product({ priceAgorot: '100' }), product({ currency: 'USD' }), product({ name: '' }), product({ active: 'true' })];
  for (const p of bad) {
    const products = new Map([['p1', p]]);
    assert.equal(code(() => buildOrder([{ productId: 'p1', qty: 1 }], products, opts())), 'failed-precondition');
    assert.equal(isPurchasable(p, 'ILS'), false);
  }
  assert.equal(code(() => buildOrder([{ productId: 'ghost', qty: 1 }], new Map(), opts())), 'failed-precondition');
});

test('order above the configured maximum is rejected', () => {
  const products = new Map([['p1', product({ priceAgorot: 600000 })]]);
  assert.equal(code(() => buildOrder([{ productId: 'p1', qty: 2 }], products, opts())), 'failed-precondition');
  assert.equal(code(() => buildOrder([{ productId: 'p1', qty: 1 }], products, opts())), null);
});

test('junk grants are dropped from the snapshot', () => {
  const products = new Map([['p1', product({ grants: ['ok_feature', 5, '', 'bad feature!', null] })]]);
  assert.deepEqual(buildOrder([{ productId: 'p1', qty: 1 }], products, opts()).items[0].grants, ['ok_feature']);
});
