'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseConfig, loadConfig, resetConfigCache } = require('../src/config');

test('the shipped club.config.json is valid and matches contract defaults', () => {
  resetConfigCache();
  const c = loadConfig();
  assert.equal(c.region, 'europe-west1');
  assert.equal(c.currency, 'ILS');
  assert.deepEqual(c.tiers.map((t) => [t.id, t.minSpendAgorot, t.discountPct]), [['member', 0, 0], ['silver', 20000, 5], ['gold', 60000, 10]]);
  assert.equal(c.points.perShekel, 1);
  assert.equal(c.limits.maxPendingOrdersPerHour, 5);
  assert.equal(c.limits.maxLines, 20);
  assert.equal(c.limits.maxQtyPerLine, 10);
});

test('missing keys fall back to defaults', () => {
  const c = parseConfig({});
  assert.equal(c.tiers.length, 3);
  assert.equal(c.payplus.environment, 'sandbox');
});

test('invalid configs are rejected', () => {
  const bad = [
    { appId: '!!' },
    { currency: 'USD' },
    { siteUrl: 'http://example.com' },
    { siteUrl: 'not a url' },
    { returnPath: '//evil.com' },
    { returnPath: 'x' },
    { payplus: { environment: 'prod' } },
    { tiers: [{ id: 'member', minSpendAgorot: 100, discountPct: 0 }] },
    { tiers: [{ id: 'member', minSpendAgorot: 0, discountPct: 0 }, { id: 'silver', minSpendAgorot: 0, discountPct: 5 }] },
    { tiers: [{ id: 'member', minSpendAgorot: 0, discountPct: 95 }] },
    { tiers: [{ id: 'silver', minSpendAgorot: 0, discountPct: 0 }] },
    { limits: { maxQtyPerLine: 11 } },
    { limits: { maxLines: 21 } },
    { points: { perShekel: -1 } },
    { enforceAppCheck: 'yes' },
  ];
  for (const b of bad) assert.throws(() => parseConfig(b), /Invalid club.config.json/, JSON.stringify(b));
});

test('http://localhost is accepted for local development', () => {
  assert.doesNotThrow(() => parseConfig({ siteUrl: 'http://localhost:5000' }));
});
