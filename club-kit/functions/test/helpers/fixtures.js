'use strict';
const { parseConfig } = require('../../src/config');

const config = parseConfig({ appId: 'test-site', siteUrl: 'https://shop.example.com', returnPath: '/' });

function product(over = {}) {
  return { name: 'מוצר בדיקה', description: 'x', priceAgorot: 10000, currency: 'ILS', grants: ['feat_a'], accessDays: null, active: true, sort: 1, ...over };
}

function seedProducts(db) {
  db.seed('products/p1', product({ name: 'מוצר א', priceAgorot: 10000, grants: ['feat_a'] }));
  db.seed('products/p2', product({ name: 'מוצר ב', priceAgorot: 2500, grants: ['feat_b'], accessDays: 30 }));
  db.seed('products/off', product({ name: 'כבוי', active: false }));
}

/** A fake provider adapter for checkout tests. */
function fakeProvider(over = {}) {
  const calls = [];
  return {
    calls,
    secrets: [],
    async createPaymentPage(args) {
      calls.push(args);
      if (over.fail) {
        const e = new Error('boom secret=XYZ');
        e.code = over.fail;
        throw e;
      }
      return { paymentUrl: 'https://payments.payplus.co.il/pay/abc', providerRef: 'page-req-1' };
    },
    verifyWebhook() {
      throw new Error('not used');
    },
  };
}

function paidOrder(over = {}) {
  return {
    uid: 'u1',
    appId: 'test-site',
    status: 'pending',
    items: [{ productId: 'p1', name: 'מוצר א', priceAgorot: 10000, qty: 2, grants: ['feat_a'], accessDays: null }],
    subtotalAgorot: 20000,
    discountAgorot: 0,
    totalAgorot: 20000,
    currency: 'ILS',
    memberTier: 'member',
    discountPct: 0,
    provider: 'payplus',
    providerRef: 'page-req-1',
    createdAt: new Date('2026-01-01T10:00:00Z'),
    ...over,
  };
}

const ev = (over = {}) => ({ orderId: 'ord1', status: 'paid', amountAgorot: 20000, currency: 'ILS', txnUid: 'txn-1', receiptUrl: 'https://receipts.example/r1', providerRef: 'page-req-1', reason: '', ...over });

module.exports = { config, product, seedProducts, fakeProvider, paidOrder, ev };
