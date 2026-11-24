'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPayPalAdapter, ProviderError, _internals } = require('../src/providers/paypal');
const { getProvider } = require('../src/providers');

const CREDS = { clientId: 'CID_test', clientSecret: 'SECRET_test', webhookId: 'WHID_test', env: 'sandbox' };
const URLS = { successUrl: 'https://shop.example.com/?checkout=success&order=ord1', cancelUrl: 'https://shop.example.com/?checkout=cancel&order=ord1' };
const ORDER = { id: 'ord1', totalAgorot: 21375, subtotalAgorot: 22500, discountAgorot: 1125, currency: 'ILS', items: [{ productId: 'p1', name: 'מוצר א', priceAgorot: 10000, qty: 2 }, { productId: 'p2', name: 'מוצר ב', priceAgorot: 2500, qty: 1 }] };

/** Scripted fetch: routes by "METHOD path". */
function mkFetch(routes) {
  const calls = [];
  const f = async (url, init) => {
    const u = new URL(url);
    const key = `${init.method} ${u.pathname}`;
    calls.push({ url, key, init, body: init.body && !String(init.body).startsWith('grant_type') ? JSON.parse(init.body) : init.body });
    const h = routes[key];
    if (!h) return { ok: false, status: 404, json: async () => ({ name: 'NOT_FOUND' }) };
    const out = typeof h === 'function' ? h(init, calls.length) : h;
    return { ok: out.status >= 200 && out.status < 300, status: out.status, json: async () => out.json };
  };
  f.calls = calls;
  return f;
}
const tokenRoute = { 'POST /v1/oauth2/token': { status: 200, json: { access_token: 'TOKEN123', expires_in: 3600 } } };
const mk = (routes, over = {}) => createPayPalAdapter({ getCredentials: () => CREDS, getBrand: () => ({ brandName: 'חנות', locale: 'he_IL' }), fetchImpl: mkFetch({ ...tokenRoute, ...routes }), ...over });
const adapterAndFetch = (routes, creds = CREDS) => {
  const f = mkFetch({ ...tokenRoute, ...routes });
  return { a: createPayPalAdapter({ getCredentials: () => creds, getBrand: () => ({ brandName: 'חנות', locale: 'he_IL' }), fetchImpl: f }), f };
};

const created = { status: 201, json: { id: 'PP-ORDER-1', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'self', href: 'https://api-m.sandbox.paypal.com/v2/checkout/orders/PP-ORDER-1' }, { rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=PP-ORDER-1' }] } };

test('createPaymentPage: OAuth + order body from the stored order (string amounts, discount breakdown, custom_id, return urls)', async () => {
  const { a, f } = adapterAndFetch({ 'POST /v2/checkout/orders': created });
  const out = await a.createPaymentPage({ order: ORDER, customer: { name: 'דנה', email: 'a@b.co' }, ...URLS, webhookUrl: 'https://hook' });
  assert.deepEqual(out, { paymentUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=PP-ORDER-1', providerRef: 'PP-ORDER-1' });
  const oauth = f.calls[0];
  assert.equal(oauth.url, 'https://api-m.sandbox.paypal.com/v1/oauth2/token');
  assert.equal(oauth.init.headers.Authorization, 'Basic ' + Buffer.from('CID_test:SECRET_test').toString('base64'));
  assert.equal(oauth.body, 'grant_type=client_credentials');
  const c = f.calls[1];
  assert.equal(c.init.headers.Authorization, 'Bearer TOKEN123');
  assert.equal(c.init.headers['PayPal-Request-Id'], 'create-ord1');
  const pu = c.body.purchase_units[0];
  assert.equal(c.body.intent, 'CAPTURE');
  assert.deepEqual([pu.custom_id, pu.reference_id], ['ord1', 'ord1']);
  assert.deepEqual(pu.amount, { currency_code: 'ILS', value: '213.75', breakdown: { item_total: { currency_code: 'ILS', value: '225.00' }, discount: { currency_code: 'ILS', value: '11.25' } } });
  assert.deepEqual(pu.items[0], { name: 'מוצר א', quantity: '2', unit_amount: { currency_code: 'ILS', value: '100.00' }, category: 'DIGITAL_GOODS' });
  const ctx = c.body.payment_source.paypal.experience_context;
  assert.deepEqual([ctx.return_url, ctx.cancel_url, ctx.shipping_preference, ctx.locale, ctx.brand_name], [URLS.successUrl, URLS.cancelUrl, 'NO_SHIPPING', 'he_IL', 'חנות']);
  // no personal data is sent and secrets never travel in the body
  const raw = JSON.stringify(c.body);
  assert.ok(!raw.includes('a@b.co') && !raw.includes('SECRET_test') && !raw.includes('CID_test'));
});

test('createPaymentPage: without a discount no discount key; amounts formatted with 2 decimals; token is cached', async () => {
  const { a, f } = adapterAndFetch({ 'POST /v2/checkout/orders': created });
  const o = { id: 'ord2', totalAgorot: 390, discountAgorot: 0, currency: 'ILS', items: [{ name: '250 מטבעות', priceAgorot: 390, qty: 1 }] };
  await a.createPaymentPage({ order: o, customer: {}, ...URLS });
  await a.createPaymentPage({ order: o, customer: {}, ...URLS });
  const body = f.calls.find((c) => c.key === 'POST /v2/checkout/orders').body;
  assert.deepEqual(body.purchase_units[0].amount, { currency_code: 'ILS', value: '3.90', breakdown: { item_total: { currency_code: 'ILS', value: '3.90' } } });
  assert.equal(f.calls.filter((c) => c.key === 'POST /v1/oauth2/token').length, 1);
});

test('createPaymentPage: live env uses the live base URL; unknown env / missing secrets fail closed', async () => {
  const { a, f } = adapterAndFetch({ 'POST /v2/checkout/orders': { ...created, json: { ...created.json, links: [{ rel: 'approve', href: 'https://www.paypal.com/checkoutnow?token=x' }] } } }, { ...CREDS, env: 'live' });
  await a.createPaymentPage({ order: { ...ORDER, discountAgorot: 0, totalAgorot: 22500 }, customer: {}, ...URLS });
  assert.ok(f.calls[0].url.startsWith('https://api-m.paypal.com/'));
  for (const bad of [{ ...CREDS, env: 'prod' }, { ...CREDS, env: '' }, { ...CREDS, clientSecret: '' }]) {
    const x = adapterAndFetch({}, bad).a;
    await assert.rejects(x.createPaymentPage({ order: ORDER, customer: {}, ...URLS }), (e) => e.code === 'not_configured');
  }
});

test('createPaymentPage: input guards and hostile/odd responses', async () => {
  const { a } = adapterAndFetch({ 'POST /v2/checkout/orders': created });
  await assert.rejects(a.createPaymentPage({ order: { ...ORDER, id: '../x' }, customer: {}, ...URLS }), ProviderError);
  await assert.rejects(a.createPaymentPage({ order: { ...ORDER, currency: 'USD' }, customer: {}, ...URLS }), ProviderError);
  await assert.rejects(a.createPaymentPage({ order: { ...ORDER, totalAgorot: 1 }, customer: {}, ...URLS }), (e) => e.code === 'bad_order'); // does not add up
  await assert.rejects(a.createPaymentPage({ order: ORDER, customer: {}, ...URLS, successUrl: 'http://evil.example.com/' }), (e) => e.code === 'bad_url');
  const bads = [
    { status: 422, json: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'CURRENCY_NOT_SUPPORTED' }] } },
    { status: 201, json: { id: 'X1', links: [{ rel: 'payer-action', href: 'https://evil.example.com/steal' }] } },
    { status: 201, json: { id: 'X1', links: [{ rel: 'payer-action', href: 'https://www.paypal.com.evil.com/x' }] } },
    { status: 201, json: { id: 'X1', links: [{ rel: 'payer-action', href: 'http://www.paypal.com/x' }] } },
    { status: 201, json: { id: 'X1', links: [] } },
    { status: 201, json: { links: created.json.links } },
  ];
  for (const b of bads) {
    const x = adapterAndFetch({ 'POST /v2/checkout/orders': b }).a;
    await assert.rejects(x.createPaymentPage({ order: ORDER, customer: {}, ...URLS }), (e) => e instanceof ProviderError && !e.message.includes('SECRET_test'));
  }
});

test('oauth failure and network failure surface as ProviderError without secrets', async () => {
  const f1 = mkFetch({ 'POST /v1/oauth2/token': { status: 401, json: { error: 'invalid_client' } } });
  const a1 = createPayPalAdapter({ getCredentials: () => CREDS, getBrand: () => ({}), fetchImpl: f1 });
  await assert.rejects(a1.createPaymentPage({ order: ORDER, customer: {}, ...URLS }), (e) => e.code === 'auth' && !e.message.includes('SECRET_test'));
  const a2 = createPayPalAdapter({ getCredentials: () => CREDS, getBrand: () => ({}), fetchImpl: async () => { throw new Error('ECONNREFUSED SECRET_test'); } });
  await assert.rejects(a2.createPaymentPage({ order: ORDER, customer: {}, ...URLS }), (e) => e.code === 'network' && !e.message.includes('SECRET_test'));
});

// ---------------- capture ----------------
const captureOk = (over = {}) => ({
  status: 201,
  json: { id: 'PP-ORDER-1', status: 'COMPLETED', purchase_units: [{ reference_id: 'ord1', custom_id: 'ord1', payments: { captures: [{ id: 'CAP-1', status: 'COMPLETED', amount: { currency_code: 'ILS', value: '213.75' } }] } }], ...over },
});
const STORED = { id: 'ord1', totalAgorot: 21375, currency: 'ILS' };

test('capture: COMPLETED -> normalised paid event with integer agorot, capture id as txnUid; request is idempotent-keyed', async () => {
  const { a, f } = adapterAndFetch({ 'POST /v2/checkout/orders/PP-ORDER-1/capture': captureOk() });
  const r = await a.capture({ order: STORED, providerRef: 'PP-ORDER-1' });
  assert.equal(r.state, 'event');
  assert.deepEqual(r.event, { orderId: 'ord1', providerRef: 'PP-ORDER-1', txnUid: 'CAP-1', receiptUrl: '', status: 'paid', amountAgorot: 21375, currency: 'ILS', reason: '' });
  const c = f.calls.find((x) => x.key.endsWith('/capture'));
  assert.equal(c.init.headers['PayPal-Request-Id'], 'capture-ord1');
});

test('capture: PENDING capture (e.g. PayPal review) grants nothing; DECLINED -> failed; not approved yet', async () => {
  let x = adapterAndFetch({ 'POST /v2/checkout/orders/PP-ORDER-1/capture': captureOk({ purchase_units: [{ custom_id: 'ord1', payments: { captures: [{ id: 'C', status: 'PENDING', amount: { currency_code: 'ILS', value: '213.75' } }] } }] }) });
  assert.deepEqual(await x.a.capture({ order: STORED, providerRef: 'PP-ORDER-1' }), { state: 'pending' });
  x = adapterAndFetch({ 'POST /v2/checkout/orders/PP-ORDER-1/capture': captureOk({ purchase_units: [{ custom_id: 'ord1', payments: { captures: [{ id: 'C', status: 'DECLINED', amount: { currency_code: 'ILS', value: '213.75' } }] } }] }) });
  assert.equal((await x.a.capture({ order: STORED, providerRef: 'PP-ORDER-1' })).event.status, 'failed');
  x = adapterAndFetch({ 'POST /v2/checkout/orders/PP-ORDER-1/capture': { status: 422, json: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_NOT_APPROVED' }] } } });
  assert.deepEqual(await x.a.capture({ order: STORED, providerRef: 'PP-ORDER-1' }), { state: 'not_approved' });
});

test('capture: ORDER_ALREADY_CAPTURED -> fetches the order and returns the same event (idempotent)', async () => {
  const { a, f } = adapterAndFetch({
    'POST /v2/checkout/orders/PP-ORDER-1/capture': { status: 422, json: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] } },
    'GET /v2/checkout/orders/PP-ORDER-1': captureOk({}),
  });
  const r = await a.capture({ order: STORED, providerRef: 'PP-ORDER-1' });
  assert.equal(r.event.txnUid, 'CAP-1');
  assert.ok(f.calls.some((c) => c.key === 'GET /v2/checkout/orders/PP-ORDER-1'));
});

test('capture: a PayPal order that is NOT ours (other custom_id / other id) is refused', async () => {
  let x = adapterAndFetch({ 'POST /v2/checkout/orders/PP-ORDER-1/capture': captureOk({ purchase_units: [{ custom_id: 'SOMEONE-ELSE', reference_id: 'x', payments: { captures: [{ id: 'C', status: 'COMPLETED', amount: { currency_code: 'ILS', value: '1.00' } }] } }] }) });
  await assert.rejects(x.a.capture({ order: STORED, providerRef: 'PP-ORDER-1' }), (e) => e.code === 'mismatch');
  x = adapterAndFetch({ 'POST /v2/checkout/orders/PP-ORDER-1/capture': captureOk({ id: 'DIFFERENT' }) });
  await assert.rejects(x.a.capture({ order: STORED, providerRef: 'PP-ORDER-1' }), (e) => e.code === 'mismatch');
  await assert.rejects(adapterAndFetch({}).a.capture({ order: STORED, providerRef: '../evil' }), ProviderError);
  const y = adapterAndFetch({ 'POST /v2/checkout/orders/PP-ORDER-1/capture': { status: 500, json: { name: 'INTERNAL_SERVER_ERROR' } } });
  await assert.rejects(y.a.capture({ order: STORED, providerRef: 'PP-ORDER-1' }), (e) => e.code === 'rejected');
});

// ---------------- webhook ----------------
const HEADERS = { 'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1', 'paypal-transmission-id': 'TID-1', 'paypal-transmission-sig': 'SIG==', 'paypal-transmission-time': '2026-11-24T10:00:00Z' };
const wh = (event_type, resource, id = 'WH-EVT-1') => ({ id, event_type, resource });
const reqOf = (body, headers = HEADERS) => ({ method: 'POST', headers, body });
const verifyOk = { 'POST /v1/notifications/verify-webhook-signature': { status: 200, json: { verification_status: 'SUCCESS' } } };
const capRes = (over = {}) => ({ id: 'CAP-1', status: 'COMPLETED', amount: { currency_code: 'ILS', value: '213.75' }, custom_id: 'ord1', supplementary_data: { related_ids: { order_id: 'PP-ORDER-1' } }, ...over });

test('verifyWebhook: asks PayPal to verify (all 5 headers + webhook id + event) and maps CAPTURE.COMPLETED', async () => {
  const { a, f } = adapterAndFetch(verifyOk);
  const body = wh('PAYMENT.CAPTURE.COMPLETED', capRes());
  const v = await a.verifyWebhook(reqOf(body));
  assert.equal(v.ok, true);
  assert.deepEqual(v.event, { eventId: 'WH-EVT-1', amountAgorot: 21375, currency: 'ILS', receiptUrl: '', status: 'paid', orderId: 'ord1', txnUid: 'CAP-1', providerRef: 'PP-ORDER-1', reason: '' });
  const call = f.calls.find((c) => c.key === 'POST /v1/notifications/verify-webhook-signature');
  assert.deepEqual(call.body, { auth_algo: 'SHA256withRSA', cert_url: HEADERS['paypal-cert-url'], transmission_id: 'TID-1', transmission_sig: 'SIG==', transmission_time: '2026-11-24T10:00:00Z', webhook_id: 'WHID_test', webhook_event: body });
});

test('verifyWebhook: FAILURE / missing headers / foreign cert url -> bad_signature (no API call for the latter two); outage -> retryable', async () => {
  const body = wh('PAYMENT.CAPTURE.COMPLETED', capRes());
  let x = adapterAndFetch({ 'POST /v1/notifications/verify-webhook-signature': { status: 200, json: { verification_status: 'FAILURE' } } });
  assert.deepEqual(await x.a.verifyWebhook(reqOf(body)), { ok: false, reason: 'bad_signature' });
  x = adapterAndFetch(verifyOk);
  for (const k of Object.keys(HEADERS)) {
    const h = { ...HEADERS };
    delete h[k];
    assert.equal((await x.a.verifyWebhook(reqOf(body, h))).reason, 'bad_signature', k);
  }
  assert.equal((await x.a.verifyWebhook(reqOf(body, { ...HEADERS, 'paypal-cert-url': 'https://evil.example.com/cert' }))).reason, 'bad_signature');
  assert.equal((await x.a.verifyWebhook(reqOf(body, { ...HEADERS, 'paypal-cert-url': 'http://api.paypal.com/cert' }))).reason, 'bad_signature');
  assert.equal((await x.a.verifyWebhook(reqOf(undefined))).reason, 'bad_signature');
  assert.equal(x.f.calls.filter((c) => c.key.includes('verify-webhook')).length, 0);
  x = adapterAndFetch({ 'POST /v1/notifications/verify-webhook-signature': { status: 503, json: {} } });
  assert.equal((await x.a.verifyWebhook(reqOf(body))).reason, 'verify_unavailable');
  x = adapterAndFetch({ 'POST /v1/notifications/verify-webhook-signature': { status: 401, json: {} } });
  assert.equal((await x.a.verifyWebhook(reqOf(body))).reason, 'not_configured');
  assert.equal((await adapterAndFetch(verifyOk, { ...CREDS, webhookId: '' }).a.verifyWebhook(reqOf(body))).reason, 'not_configured');
});

test('verifyWebhook: event mapping for DENIED, REFUNDED (capture id from the up-link), REVERSED, APPROVED, unknown types', async () => {
  const { a } = adapterAndFetch(verifyOk);
  let v = await a.verifyWebhook(reqOf(wh('PAYMENT.CAPTURE.DENIED', capRes({ status: 'DENIED' }))));
  assert.deepEqual([v.event.status, v.event.orderId], ['failed', 'ord1']);
  v = await a.verifyWebhook(reqOf(wh('PAYMENT.CAPTURE.REFUNDED', { id: 'REF-1', status: 'COMPLETED', amount: { currency_code: 'ILS', value: '213.75' }, links: [{ rel: 'self', href: 'https://api.paypal.com/v2/payments/refunds/REF-1' }, { rel: 'up', href: 'https://api.paypal.com/v2/payments/captures/CAP-1' }] }, 'WH-2')));
  assert.deepEqual([v.event.status, v.event.captureId, v.event.txnUid, v.event.orderId, v.event.amountAgorot, v.event.eventId], ['refunded', 'CAP-1', 'REF-1', undefined, 21375, 'WH-2']);
  v = await a.verifyWebhook(reqOf(wh('PAYMENT.CAPTURE.REFUNDED', { id: 'REF-2', status: 'PENDING', amount: { currency_code: 'ILS', value: '1.00' } })));
  assert.equal(v.event, null);
  v = await a.verifyWebhook(reqOf(wh('PAYMENT.CAPTURE.REVERSED', capRes({ status: 'REVERSED' }))));
  assert.deepEqual([v.event.status, v.event.captureId, v.event.reason], ['refunded', 'CAP-1', 'reversed']);
  v = await a.verifyWebhook(reqOf(wh('CHECKOUT.ORDER.APPROVED', { id: 'PP-ORDER-1', status: 'APPROVED', purchase_units: [{ custom_id: 'ord1' }] })));
  assert.deepEqual([v.event.status, v.event.orderId, v.event.providerRef], ['approved', 'ord1', 'PP-ORDER-1']);
  v = await a.verifyWebhook(reqOf(wh('PAYMENT.CAPTURE.COMPLETED', capRes({ status: 'PENDING' }))));
  assert.equal(v.event, null);
  v = await a.verifyWebhook(reqOf(wh('BILLING.SUBSCRIPTION.CREATED', {})));
  assert.deepEqual([v.ok, v.event], [true, null]);
  v = await a.verifyWebhook(reqOf(wh('PAYMENT.CAPTURE.COMPLETED', capRes({ custom_id: '../bad id', amount: { currency_code: 'ILS', value: '1.005' } }))));
  assert.deepEqual([v.event.orderId, v.event.amountAgorot], [undefined, null]);
});

test('registry: paypal exposes the interface, capture, and the 4 secrets', () => {
  const p = getProvider('paypal');
  assert.equal(typeof p.capture, 'function');
  assert.deepEqual(p.secrets.map((s) => s.name), ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_WEBHOOK_ID', 'PAYPAL_ENV']);
  assert.equal(_internals.API_BASE.live, 'https://api-m.paypal.com');
});
