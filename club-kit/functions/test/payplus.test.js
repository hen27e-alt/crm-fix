'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createPayPlusAdapter, ProviderError, _internals } = require('../src/providers/payplus');
const { getProvider } = require('../src/providers');

const CREDS = { apiKey: 'AK_test_123', secretKey: 'SK_test_456', pageUid: 'PAGE_UID_789' };
const URLS = { successUrl: 'https://shop.example.com/?checkout=success&order=ord1', cancelUrl: 'https://shop.example.com/?checkout=cancel&order=ord1', webhookUrl: 'https://hooks.example.com/paymentWebhook' };
const ORDER = { id: 'ord1', totalAgorot: 19990, discountAgorot: 0, currency: 'ILS', items: [{ productId: 'p1', name: 'מוצר א', priceAgorot: 9995, qty: 2 }] };

function mkFetch(responder) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return responder(url, init);
  };
  f.calls = calls;
  return f;
}
const okResponse = (data) => ({ ok: true, status: 200, json: async () => ({ results: { status: 'success', code: 0 }, data }) });
const adapterWith = (fetchImpl, env = 'sandbox') => createPayPlusAdapter({ getCredentials: () => CREDS, getEnvironment: () => env, fetchImpl });

test('createPaymentPage: request shape (url, auth headers, decimal amount, order id in more_info, callback url)', async () => {
  const f = mkFetch(() => okResponse({ payment_page_link: 'https://payments-dev.payplus.co.il/abc', page_request_uid: 'PR-1' }));
  const out = await adapterWith(f).createPaymentPage({ order: ORDER, customer: { name: 'דנה', email: 'a@b.co', phone: '+972501234567' }, ...URLS });
  assert.deepEqual(out, { paymentUrl: 'https://payments-dev.payplus.co.il/abc', providerRef: 'PR-1' });
  const c = f.calls[0];
  assert.equal(c.url, 'https://restapidev.payplus.co.il/api/v1.0/PaymentPages/generateLink');
  assert.equal(c.init.method, 'POST');
  assert.equal(c.init.headers['api-key'], CREDS.apiKey);
  assert.equal(c.init.headers['secret-key'], CREDS.secretKey);
  assert.equal(c.body.payment_page_uid, CREDS.pageUid);
  assert.equal(c.body.amount, 199.9);
  assert.equal(c.body.currency_code, 'ILS');
  assert.equal(c.body.more_info, 'ord1');
  assert.equal(c.body.refURL_callback, URLS.webhookUrl);
  assert.equal(c.body.refURL_success, URLS.successUrl);
  assert.equal(c.body.refURL_cancel, URLS.cancelUrl);
  assert.deepEqual(c.body.items, [{ name: 'מוצר א', quantity: 2, price: 99.95 }]);
  assert.equal(c.body.customer.customer_name, 'דנה');
  // secrets only travel in headers, never in the JSON body
  assert.ok(!c.init.body.includes(CREDS.apiKey) && !c.init.body.includes(CREDS.secretKey));
});

test('production environment uses the production base URL', async () => {
  const f = mkFetch(() => okResponse({ payment_page_link: 'https://payments.payplus.co.il/x', page_request_uid: 'PR' }));
  await adapterWith(f, 'production').createPaymentPage({ order: ORDER, customer: {}, ...URLS });
  assert.equal(f.calls[0].url, 'https://restapi.payplus.co.il/api/v1.0/PaymentPages/generateLink');
  assert.equal('customer' in f.calls[0].body, false);
});

test('with a club discount a single aggregated line equal to the total is sent (sum(items) === amount)', () => {
  const items = _internals.buildItems({ ...ORDER, discountAgorot: 1000, totalAgorot: 18990 });
  assert.deepEqual(items, [{ name: 'הזמנה ord1', quantity: 1, price: 189.9 }]);
});

test('createPaymentPage: provider rejection / non-JSON / network error / bad link -> ProviderError without secrets in the message', async () => {
  const cases = [
    () => ({ ok: false, status: 401, json: async () => ({ results: { status: 'error', code: 401, description: `bad key ${CREDS.apiKey}` } }) }),
    () => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); } }),
    () => okResponse({ payment_page_link: 'http://payments.payplus.co.il/x', page_request_uid: 'PR' }),
    () => okResponse({ payment_page_link: 'https://evil.example.com/x', page_request_uid: 'PR' }),
    () => okResponse({ payment_page_link: 'https://payments.payplus.co.il.evil.com/x', page_request_uid: 'PR' }),
    () => okResponse({ payment_page_link: 'https://payments.payplus.co.il/x' }),
    () => ({ ok: true, status: 200, json: async () => ({ results: { status: 'error' } }) }),
  ];
  for (const c of cases) {
    await assert.rejects(adapterWith(mkFetch(c)).createPaymentPage({ order: ORDER, customer: {}, ...URLS }), (e) => {
      assert.ok(e instanceof ProviderError);
      assert.ok(!e.message.includes(CREDS.apiKey) && !e.message.includes(CREDS.secretKey));
      return true;
    });
  }
  const netFail = createPayPlusAdapter({ getCredentials: () => CREDS, getEnvironment: () => 'sandbox', fetchImpl: async () => { throw new Error(`connect ECONNREFUSED ${CREDS.secretKey}`); } });
  await assert.rejects(netFail.createPaymentPage({ order: ORDER, customer: {}, ...URLS }), (e) => e.code === 'network' && !e.message.includes(CREDS.secretKey));
});

test('createPaymentPage: input guards (bad order, non-https urls, missing secrets)', async () => {
  const a = adapterWith(mkFetch(() => okResponse({})));
  await assert.rejects(a.createPaymentPage({ order: { ...ORDER, id: '../x' }, customer: {}, ...URLS }), ProviderError);
  await assert.rejects(a.createPaymentPage({ order: { ...ORDER, totalAgorot: 0 }, customer: {}, ...URLS }), ProviderError);
  await assert.rejects(a.createPaymentPage({ order: { ...ORDER, currency: 'USD' }, customer: {}, ...URLS }), ProviderError);
  await assert.rejects(a.createPaymentPage({ order: ORDER, customer: {}, ...URLS, webhookUrl: 'http://evil.example.com/x' }), ProviderError);
  const noSecrets = createPayPlusAdapter({ getCredentials: () => ({ apiKey: '', secretKey: '', pageUid: '' }), getEnvironment: () => 'sandbox', fetchImpl: mkFetch(() => okResponse({})) });
  await assert.rejects(noSecrets.createPaymentPage({ order: ORDER, customer: {}, ...URLS }), (e) => e.code === 'not_configured');
});

// ---------- webhook verification ----------
const bodyObj = (over = {}) => ({
  transaction_type: 'Payment',
  transaction: { uid: 'TX-1', payment_page_request_uid: 'PR-1', more_info: 'ord1', status_code: '000', amount: 199.9, currency: 'ILS', ...over },
  data: { invoice_link: 'https://invoices.payplus.co.il/i/1' },
});
function signedReq(obj, { enc = 'base64', secret = CREDS.secretKey, raw } = {}) {
  const rawBody = Buffer.from(raw !== undefined ? raw : JSON.stringify(obj));
  const hash = crypto.createHmac('sha256', secret).update(rawBody).digest(enc);
  return { method: 'POST', headers: { hash, 'user-agent': 'PayPlus' }, rawBody, body: obj };
}
const verifier = () => createPayPlusAdapter({ getCredentials: () => CREDS, getEnvironment: () => 'sandbox', fetchImpl: async () => { throw new Error('no net'); } });

test('verifyWebhook: valid signature (base64 and hex digests) -> ok + normalised event', () => {
  for (const enc of ['base64', 'hex']) {
    const v = verifier().verifyWebhook(signedReq(bodyObj(), { enc }));
    assert.equal(v.ok, true, enc);
    assert.deepEqual(v.event, { orderId: 'ord1', status: 'paid', amountAgorot: 19990, currency: 'ILS', txnUid: 'TX-1', receiptUrl: 'https://invoices.payplus.co.il/i/1', providerRef: 'PR-1', reason: '' });
  }
});

test('verifyWebhook: re-serialised body fallback is accepted when the raw bytes differ only by whitespace', () => {
  const obj = bodyObj();
  const req = signedReq(obj);
  req.rawBody = Buffer.from(JSON.stringify(obj, null, 2)); // transport re-formatted the raw bytes
  assert.equal(verifier().verifyWebhook(req).ok, true);
});

test('verifyWebhook: bad / missing / wrong-secret / tampered signatures are rejected', () => {
  const v = verifier();
  assert.deepEqual(v.verifyWebhook(signedReq(bodyObj(), { secret: 'other' })), { ok: false, reason: 'bad_signature' });
  const noHeader = signedReq(bodyObj());
  delete noHeader.headers.hash;
  assert.equal(v.verifyWebhook(noHeader).ok, false);
  const empty = signedReq(bodyObj());
  empty.headers.hash = '';
  assert.equal(v.verifyWebhook(empty).ok, false);
  const tampered = signedReq(bodyObj());
  const t = bodyObj({ amount: 1 });
  tampered.rawBody = Buffer.from(JSON.stringify(t));
  tampered.body = t;
  assert.equal(v.verifyWebhook(tampered).ok, false);
  const trunc = signedReq(bodyObj());
  trunc.headers.hash = trunc.headers.hash.slice(0, 10);
  assert.equal(v.verifyWebhook(trunc).ok, false);
  assert.equal(v.verifyWebhook({ method: 'POST', headers: {}, rawBody: undefined, body: undefined }).ok, false);
  // missing secret in the deployment must fail closed
  const noSecret = createPayPlusAdapter({ getCredentials: () => ({ secretKey: '' }), getEnvironment: () => 'sandbox' });
  assert.deepEqual(noSecret.verifyWebhook(signedReq(bodyObj())), { ok: false, reason: 'not_configured' });
});

test('verifyWebhook: failed, refund, malformed amounts and non-payment messages', () => {
  const v = verifier();
  let r = v.verifyWebhook(signedReq(bodyObj({ status_code: '051', status_description: 'insufficient funds', amount: 0 })));
  assert.equal(r.event.status, 'failed');
  assert.match(r.event.reason, /051/);
  r = v.verifyWebhook(signedReq({ ...bodyObj(), transaction_type: 'Refund' }));
  assert.equal(r.event.status, 'refunded');
  r = v.verifyWebhook(signedReq(bodyObj({ amount: '10.005' })));
  assert.equal(r.event.amountAgorot, null);
  r = v.verifyWebhook(signedReq(bodyObj({ more_info: 'bad id!' })));
  assert.deepEqual([r.ok, r.event], [true, null]);
  r = v.verifyWebhook(signedReq({ hello: 'world' }));
  assert.deepEqual([r.ok, r.event], [true, null]);
  r = v.verifyWebhook(signedReq({ ...bodyObj(), data: { invoice_link: 'javascript:alert(1)' } }));
  assert.equal(r.event.receiptUrl, '');
});

test('provider registry loads payplus with the interface + secrets', () => {
  const p = getProvider('payplus');
  assert.equal(typeof p.createPaymentPage, 'function');
  assert.equal(typeof p.verifyWebhook, 'function');
  assert.deepEqual(p.secrets.map((s) => s.name), ['PAYPLUS_API_KEY', 'PAYPLUS_SECRET_KEY', 'PAYPLUS_PAGE_UID']);
  assert.throws(() => getProvider('nope'), /Unknown payment provider/);
});
