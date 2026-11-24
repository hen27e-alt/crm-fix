'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { safeEqual, cleanText, normalizePhone, shekelToAgorot, agorotToShekel, logId } = require('../src/util');

test('normalizePhone: Israeli formats -> +972', () => {
  assert.equal(normalizePhone('050-123 4567'), '+972501234567');
  assert.equal(normalizePhone('0501234567'), '+972501234567');
  assert.equal(normalizePhone('972501234567'), '+972501234567');
  assert.equal(normalizePhone('+972501234567'), '+972501234567');
  assert.equal(normalizePhone('00972501234567'), '+972501234567');
  assert.equal(normalizePhone('(03) 123-4567'), '+97231234567');
  assert.equal(normalizePhone('+14155550123'), '+14155550123');
});

test('normalizePhone: rejects garbage', () => {
  for (const v of ['', 'abc', '12', null, undefined, 5, '+', '050123456789012345', '5-0']) assert.equal(normalizePhone(v), '');
});

test('cleanText: strips control chars, collapses space, caps length, non-strings -> empty', () => {
  assert.equal(cleanText('  a\u0000b \n\t c  ', 50), 'a b c');
  assert.equal(cleanText('x'.repeat(300), 10), 'x'.repeat(10));
  assert.equal(cleanText(null, 5), '');
  assert.equal(cleanText({}, 5), '');
});

test('safeEqual: equal / different / different length / non-string', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('', ''), true);
  assert.equal(safeEqual('a', undefined), false);
  assert.equal(safeEqual(1, 1), false);
});

test('shekelToAgorot: exact decimal parsing', () => {
  assert.equal(shekelToAgorot(200), 20000);
  assert.equal(shekelToAgorot('200.00'), 20000);
  assert.equal(shekelToAgorot(19.99), 1999);
  assert.equal(shekelToAgorot('0.1'), 10);
  assert.equal(shekelToAgorot(0.29), 29); // float trap: 0.29*100 = 28.999999999999996
  assert.equal(shekelToAgorot('10.50'), 1050);
  assert.equal(shekelToAgorot('10.500'), 1050);
  assert.equal(shekelToAgorot('10.005'), null);
  for (const v of [-1, NaN, 'abc', '', null, undefined, '1e3', {}, Infinity]) assert.equal(shekelToAgorot(v), null);
});

test('agorotToShekel', () => {
  assert.equal(agorotToShekel(1999), 19.99);
  assert.equal(agorotToShekel(20000), 200);
  assert.equal(agorotToShekel(29), 0.29);
});

test('logId is a short stable pseudonym that does not contain the id', () => {
  assert.equal(logId('uid-123'), logId('uid-123'));
  assert.equal(logId('uid-123').length, 10);
  assert.ok(!logId('uid-123').includes('uid'));
  assert.equal(logId(''), '-');
});

test('lib.js exposes the reusable building blocks (Game Night can import them)', () => {
  const lib = require('../src/lib');
  for (const k of ['createPayPalAdapter', 'processPaymentEvent', 'captureOrderCore', 'handleWebhook', 'declareAgeCore', 'assertAdult', 'addContribution', 'removeContribution', 'computeDiscountAgorot', 'pointsForTotal', 'safeEqual', 'shekelToAgorot', 'httpsError']) {
    assert.equal(typeof lib[k], 'function', k);
  }
});

test('scripts/check-legal.js fails on template leftovers and passes on a clean page', () => {
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legal-'));
  const bad = path.join(dir, 'bad.html');
  const good = path.join(dir, 'good.html');
  fs.writeFileSync(bad, '<p>תנאי שימוש של [שם העסק]</p>');
  fs.writeFileSync(good, '<p>תנאי השימוש של חברת דוגמה בע"מ.</p><script>var a=[1,2]</script>');
  const script = path.join(__dirname, '..', '..', 'scripts', 'check-legal.js');
  assert.equal(spawnSync(process.execPath, [script, bad]).status, 1);
  assert.equal(spawnSync(process.execPath, [script, good]).status, 0);
  assert.equal(spawnSync(process.execPath, [script]).status, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});
