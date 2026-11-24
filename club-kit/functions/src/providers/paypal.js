'use strict';
/**
 * PayPal provider adapter - REST Orders API v2, redirect (approve) flow + server-side capture + webhook backup.
 *
 * Flow
 *   1. createPaymentPage()  POST /v2/checkout/orders  (intent CAPTURE, ILS, amounts from OUR stored order, custom_id = our orderId)
 *                           -> paymentUrl = the buyer-approval link.  providerRef = PayPal order id.
 *   2. buyer approves at PayPal and is redirected to return_url (?checkout=success&order=OURID&token=PAYPALID&PayerID=..).
 *   3. capture()            POST /v2/checkout/orders/{id}/capture - called by the `capturePayPalOrder` callable after the
 *                           buyer returns (and by the webhook on CHECKOUT.ORDER.APPROVED as a backup).
 *                           The provider order id is ALWAYS the one stored on our order, never a client-supplied one.
 *   4. verifyWebhook()      PayPal "verify-webhook-signature" API call; events PAYMENT.CAPTURE.COMPLETED / DENIED /
 *                           REFUNDED / REVERSED and CHECKOUT.ORDER.APPROVED.
 *
 * NO CARD DATA touches this code: the buyer pays on PayPal's own pages.
 *
 * ---------------------------------------------------------------------------------------------
 * HOW MUCH OF THIS WAS VERIFIED?  NOTHING against live documentation or a real sandbox.
 * The build environment could not reach developer.paypal.com and no PayPal account/sandbox was available.
 * Every path, header, field and enum below is the author's recollection of the public PayPal REST API and is
 * therefore UNVERIFIED. Each one is a named constant at the top (or one small function) so it can be fixed in one place.
 * The unit tests only prove that this code does what these assumptions say, against a mocked fetch.
 *
 * VERIFY-WITH-DOCS checklist (also in SETUP.md, section "בדיקת הנחות מול PayPal"):
 *  [ ] P1  Base URLs: sandbox https://api-m.sandbox.paypal.com , live https://api-m.paypal.com
 *  [ ] P2  OAuth: POST /v1/oauth2/token, HTTP Basic (client_id:secret), form body grant_type=client_credentials,
 *          response {access_token, expires_in}
 *  [ ] P3  Create order: POST /v2/checkout/orders, JSON {intent:'CAPTURE', purchase_units:[{reference_id, custom_id,
 *          amount:{currency_code,value,breakdown:{item_total,discount}}, items:[{name,quantity,unit_amount,category}]}],
 *          payment_source:{paypal:{experience_context:{return_url,cancel_url,brand_name,locale,shipping_preference,user_action}}}}
 *          (alternative older shape: top-level application_context - flip USE_EXPERIENCE_CONTEXT)
 *  [ ] P4  Amounts are STRINGS with 2 decimals; currency ILS is enabled for the receiving (Israeli business) account;
 *          items[].category "DIGITAL_GOODS"; breakdown.discount is accepted; value must equal item_total - discount
 *  [ ] P5  Approval link: response.links[] entry with rel "payer-action" (new shape) or "approve" (old); host *.paypal.com
 *  [ ] P6  Idempotency header `PayPal-Request-Id` on create and capture
 *  [ ] P7  Capture: POST /v2/checkout/orders/{id}/capture, empty JSON body, `Prefer: return=representation`;
 *          response.status "COMPLETED", purchase_units[0].payments.captures[0]{id,status,amount{currency_code,value}};
 *          purchase_units[0].custom_id echoes ours
 *  [ ] P8  Already captured -> HTTP 422 with details[].issue "ORDER_ALREADY_CAPTURED" (we then GET the order);
 *          not approved yet -> 422 "ORDER_NOT_APPROVED"
 *  [ ] P9  Capture statuses: COMPLETED (paid), PENDING (e.g. under review: do NOT grant), DECLINED/FAILED (failed)
 *  [ ] P10 Webhook headers: paypal-auth-algo, paypal-cert-url, paypal-transmission-id, paypal-transmission-sig, paypal-transmission-time
 *  [ ] P11 POST /v1/notifications/verify-webhook-signature body {auth_algo, cert_url, transmission_id, transmission_sig,
 *          transmission_time, webhook_id, webhook_event}; response {verification_status:'SUCCESS'}; the parsed (not raw)
 *          body is accepted as webhook_event
 *  [ ] P12 Event shapes: PAYMENT.CAPTURE.COMPLETED/DENIED/REVERSED resource = capture {id,status,amount,custom_id,
 *          supplementary_data.related_ids.order_id}; PAYMENT.CAPTURE.REFUNDED resource = refund {id,status,amount,
 *          links[rel=up -> .../captures/{captureId}]} (custom_id may be absent: we then resolve the order by the capture id);
 *          CHECKOUT.ORDER.APPROVED resource = order {id, purchase_units[0].custom_id}
 *  [ ] P13 Webhook event id (`id`, "WH-...") is unique per event - used for replay detection
 *  [ ] P14 PayPal fees/minimums for micro-payments (e.g. 3.90 ILS) on the owner's account (business, not API)
 * ---------------------------------------------------------------------------------------------
 */
const { defineSecret } = require('firebase-functions/params');
const { cleanText, agorotToShekel, shekelToAgorot } = require('../util');

// ---- Secrets (set with `firebase functions:secrets:set NAME`) -----------------------------------
const PAYPAL_CLIENT_ID = defineSecret('PAYPAL_CLIENT_ID');
const PAYPAL_CLIENT_SECRET = defineSecret('PAYPAL_CLIENT_SECRET');
const PAYPAL_WEBHOOK_ID = defineSecret('PAYPAL_WEBHOOK_ID');
const PAYPAL_ENV = defineSecret('PAYPAL_ENV'); // "sandbox" | "live"

// ---- UNVERIFIED PROVIDER FACTS (see checklist above) --------------------------------------------
const API_BASE = Object.freeze({ sandbox: 'https://api-m.sandbox.paypal.com', live: 'https://api-m.paypal.com' }); // P1
const OAUTH_PATH = '/v1/oauth2/token'; // P2
const ORDERS_PATH = '/v2/checkout/orders'; // P3
const CAPTURE_SUFFIX = '/capture'; // P7
const VERIFY_WEBHOOK_PATH = '/v1/notifications/verify-webhook-signature'; // P11
const USE_EXPERIENCE_CONTEXT = true; // P3: true = payment_source.paypal.experience_context, false = legacy application_context
const ITEM_CATEGORY = 'DIGITAL_GOODS'; // P4
const APPROVE_LINK_RELS = Object.freeze(['payer-action', 'approve']); // P5
const APPROVAL_HOST_SUFFIX = 'paypal.com'; // P5
const HEADER_REQUEST_ID = 'PayPal-Request-Id'; // P6
const WEBHOOK_HEADERS = Object.freeze({ authAlgo: 'paypal-auth-algo', certUrl: 'paypal-cert-url', transmissionId: 'paypal-transmission-id', transmissionSig: 'paypal-transmission-sig', transmissionTime: 'paypal-transmission-time' }); // P10
const VERIFY_SUCCESS = 'SUCCESS'; // P11
const EVT = Object.freeze({ completed: 'PAYMENT.CAPTURE.COMPLETED', denied: 'PAYMENT.CAPTURE.DENIED', refunded: 'PAYMENT.CAPTURE.REFUNDED', reversed: 'PAYMENT.CAPTURE.REVERSED', approved: 'CHECKOUT.ORDER.APPROVED' }); // P12
const CAPTURE_PAID = 'COMPLETED'; // P9
const CAPTURE_PENDING = 'PENDING'; // P9
const CAPTURE_FAILED = Object.freeze(['DECLINED', 'FAILED']); // P9
const REFUND_DONE = 'COMPLETED'; // P12
const ISSUE_ALREADY_CAPTURED = 'ORDER_ALREADY_CAPTURED'; // P8
const ISSUE_NOT_APPROVED = 'ORDER_NOT_APPROVED'; // P8
const REQUEST_TIMEOUT_MS = 20000;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

class ProviderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProviderError';
    this.code = code; // short machine code, safe to log
  }
}

const isHttpsUrl = (s) => {
  if (typeof s !== 'string' || s.length > 2048) return false;
  try {
    return new URL(s).protocol === 'https:';
  } catch (_) {
    return false;
  }
};
const hostOk = (url, suffix) => {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === suffix || h.endsWith('.' + suffix);
  } catch (_) {
    return false;
  }
};
const money = (agorot) => agorotToShekel(agorot).toFixed(2); // P4: string with 2 decimals

function issuesOf(json) {
  const d = json && Array.isArray(json.details) ? json.details : [];
  return d.map((x) => (x && typeof x.issue === 'string' ? x.issue : '')).filter(Boolean);
}

function createPayPalAdapter(opts = {}) {
  const getCredentials =
    opts.getCredentials ||
    (() => ({ clientId: PAYPAL_CLIENT_ID.value(), clientSecret: PAYPAL_CLIENT_SECRET.value(), webhookId: PAYPAL_WEBHOOK_ID.value(), env: PAYPAL_ENV.value() }));
  const getBrand = opts.getBrand || (() => require('../config').loadConfig().paypal);
  const fetchImpl = opts.fetchImpl || ((...a) => fetch(...a));
  const nowMs = opts.nowMs || (() => Date.now());
  let tokenCache = null; // {token, exp, key}

  function creds() {
    const c = getCredentials();
    const base = API_BASE[c.env];
    if (!c.clientId || !c.clientSecret || !base) throw new ProviderError('not_configured', 'missing PayPal secrets or PAYPAL_ENV not sandbox|live');
    return { ...c, base };
  }

  async function http(method, url, { headers = {}, body } = {}) {
    let res;
    try {
      res = await fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (e) {
      throw new ProviderError('network', e && e.name === 'TimeoutError' ? 'timeout' : 'network error');
    }
    let json = null;
    try {
      json = await res.json();
    } catch (_) {
      /* some responses have no body */
    }
    return { status: res.status, ok: res.ok, json };
  }

  async function accessToken(c) {
    const key = c.clientId + '|' + c.env;
    if (tokenCache && tokenCache.key === key && tokenCache.exp - 60000 > nowMs()) return tokenCache.token;
    const basic = Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64');
    const r = await http('POST', c.base + OAUTH_PATH, {
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: 'grant_type=client_credentials',
    });
    if (!r.ok || !r.json || typeof r.json.access_token !== 'string') throw new ProviderError('auth', `oauth failed, http ${r.status}`);
    tokenCache = { key, token: r.json.access_token, exp: nowMs() + (Number(r.json.expires_in) || 300) * 1000 };
    return tokenCache.token;
  }

  async function api(method, path, { json, extraHeaders } = {}) {
    const c = creds();
    const token = await accessToken(c);
    const r = await http(method, c.base + path, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(extraHeaders || {}) },
      body: json !== undefined ? JSON.stringify(json) : undefined,
    });
    if (r.status === 401) tokenCache = null; // expired/revoked: next call re-authenticates
    return r;
  }

  // ---------------------------------------------------------------- create
  async function createPaymentPage({ order, customer, successUrl, cancelUrl }) {
    if (!order || !ID_RE.test(String(order.id || ''))) throw new ProviderError('bad_order', 'order.id missing');
    if (!Number.isInteger(order.totalAgorot) || order.totalAgorot <= 0) throw new ProviderError('bad_order', 'bad total');
    if (order.currency !== 'ILS') throw new ProviderError('bad_order', 'currency');
    for (const u of [successUrl, cancelUrl]) if (!isHttpsUrl(u) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(String(u))) throw new ProviderError('bad_url', 'url must be https');

    const lines = Array.isArray(order.items) ? order.items : [];
    if (!lines.length) throw new ProviderError('bad_order', 'no items');
    const discount = Number.isInteger(order.discountAgorot) ? order.discountAgorot : 0;
    const itemTotal = lines.reduce((s, it) => s + it.priceAgorot * it.qty, 0);
    if (itemTotal - discount !== order.totalAgorot) throw new ProviderError('bad_order', 'items/discount do not add up to total'); // P4

    const brand = getBrand();
    const unit = {
      reference_id: order.id,
      custom_id: order.id,
      amount: {
        currency_code: 'ILS',
        value: money(order.totalAgorot),
        breakdown: { item_total: { currency_code: 'ILS', value: money(itemTotal) }, ...(discount > 0 ? { discount: { currency_code: 'ILS', value: money(discount) } } : {}) },
      },
      items: lines.map((it) => ({
        name: cleanText(it.name, 127) || 'מוצר דיגיטלי',
        quantity: String(it.qty),
        unit_amount: { currency_code: 'ILS', value: money(it.priceAgorot) },
        category: ITEM_CATEGORY,
      })),
    };
    const ctx = { return_url: successUrl, cancel_url: cancelUrl, shipping_preference: 'NO_SHIPPING', user_action: 'PAY_NOW', locale: brand.locale || 'he_IL', ...(brand.brandName ? { brand_name: brand.brandName } : {}) };
    const body = { intent: 'CAPTURE', purchase_units: [unit], ...(USE_EXPERIENCE_CONTEXT ? { payment_source: { paypal: { experience_context: ctx } } } : { application_context: ctx }) };
    void customer; // PayPal collects the buyer's identity itself; we send no personal data (data minimisation)

    const r = await api('POST', ORDERS_PATH, { json: body, extraHeaders: { [HEADER_REQUEST_ID]: `create-${order.id}`, Prefer: 'return=representation' } });
    if (!r.ok || !r.json || typeof r.json.id !== 'string') {
      const issue = issuesOf(r.json)[0] || (r.json && typeof r.json.name === 'string' ? r.json.name : 'n/a');
      throw new ProviderError('rejected', `http ${r.status}, issue ${String(issue).slice(0, 60)}`);
    }
    const link = (Array.isArray(r.json.links) ? r.json.links : []).find((l) => l && APPROVE_LINK_RELS.includes(l.rel));
    if (!link || !isHttpsUrl(link.href) || !hostOk(link.href, APPROVAL_HOST_SUFFIX)) throw new ProviderError('bad_response', 'approval link missing or unexpected host');
    if (!ID_RE.test(r.json.id)) throw new ProviderError('bad_response', 'unexpected order id format');
    return { paymentUrl: link.href, providerRef: r.json.id };
  }

  // ---------------------------------------------------------------- capture
  /** Turn a PayPal order object (capture response or GET order) into {state, event?}. Enforces that it is OUR order. */
  function interpretOrder(json, order, providerRef) {
    if (!json || json.id !== providerRef) throw new ProviderError('mismatch', 'provider order id differs from the stored one');
    const pu = Array.isArray(json.purchase_units) ? json.purchase_units[0] : null;
    if (!pu || (pu.custom_id !== order.id && pu.reference_id !== order.id)) throw new ProviderError('mismatch', 'PayPal order does not belong to this order');
    const caps = pu.payments && Array.isArray(pu.payments.captures) ? pu.payments.captures : [];
    const cap = caps.find((c) => c && c.status === CAPTURE_PAID) || caps[0];
    if (!cap) return { state: json.status === 'COMPLETED' ? 'pending' : 'not_approved' };
    if (cap.status === CAPTURE_PENDING) return { state: 'pending' };
    const base = { orderId: order.id, providerRef: json.id, txnUid: typeof cap.id === 'string' ? cap.id.slice(0, 128) : '', receiptUrl: '' };
    const amt = cap.amount || {};
    const amountAgorot = shekelToAgorot(amt.value);
    const currency = typeof amt.currency_code === 'string' ? amt.currency_code.toUpperCase() : '';
    if (cap.status === CAPTURE_PAID) return { state: 'event', event: { ...base, status: 'paid', amountAgorot, currency, reason: '' } };
    if (CAPTURE_FAILED.includes(cap.status)) return { state: 'event', event: { ...base, status: 'failed', amountAgorot, currency, reason: `paypal ${cap.status}` } };
    return { state: 'pending' }; // REFUNDED / PARTIALLY_REFUNDED / other: never act on it from the capture path
  }

  async function capture({ order, providerRef }) {
    if (!order || !ID_RE.test(String(order.id || '')) || !ID_RE.test(String(providerRef || ''))) throw new ProviderError('bad_order', 'ids');
    const path = `${ORDERS_PATH}/${encodeURIComponent(providerRef)}`;
    const r = await api('POST', path + CAPTURE_SUFFIX, { json: {}, extraHeaders: { [HEADER_REQUEST_ID]: `capture-${order.id}`, Prefer: 'return=representation' } });
    if (r.ok) return interpretOrder(r.json, order, providerRef);
    const issues = issuesOf(r.json);
    if (r.status === 422 && issues.includes(ISSUE_ALREADY_CAPTURED)) {
      const g = await api('GET', path);
      if (!g.ok) throw new ProviderError('rejected', `get order http ${g.status}`);
      return interpretOrder(g.json, order, providerRef);
    }
    if (r.status === 422 && issues.includes(ISSUE_NOT_APPROVED)) return { state: 'not_approved' };
    throw new ProviderError('rejected', `capture http ${r.status}, issue ${String(issues[0] || 'n/a').slice(0, 60)}`);
  }

  // ---------------------------------------------------------------- webhook
  function captureIdFromLinks(links) {
    const up = (Array.isArray(links) ? links : []).find((l) => l && l.rel === 'up' && typeof l.href === 'string');
    if (!up) return '';
    const seg = up.href.split('?')[0].split('/').filter(Boolean).pop() || '';
    return ID_RE.test(seg) ? seg : '';
  }

  function parseEvent(body) {
    if (!body || typeof body !== 'object' || typeof body.event_type !== 'string' || !body.resource || typeof body.resource !== 'object') return null;
    const r = body.resource;
    const eventId = typeof body.id === 'string' && ID_RE.test(body.id) ? body.id : undefined;
    const customId = typeof r.custom_id === 'string' && ID_RE.test(r.custom_id) ? r.custom_id : undefined;
    const amt = r.amount || {};
    const common = { eventId, amountAgorot: shekelToAgorot(amt.value), currency: typeof amt.currency_code === 'string' ? amt.currency_code.toUpperCase() : '', receiptUrl: '' };
    const relatedOrder = r.supplementary_data && r.supplementary_data.related_ids && typeof r.supplementary_data.related_ids.order_id === 'string' ? r.supplementary_data.related_ids.order_id : '';

    switch (body.event_type) {
      case EVT.completed:
        if (r.status !== CAPTURE_PAID) return null;
        return { ...common, status: 'paid', orderId: customId, txnUid: String(r.id || '').slice(0, 128), providerRef: relatedOrder || undefined, reason: '' };
      case EVT.denied:
        return { ...common, status: 'failed', orderId: customId, txnUid: String(r.id || '').slice(0, 128), providerRef: relatedOrder || undefined, reason: 'paypal DENIED' };
      case EVT.refunded:
        if (r.status !== REFUND_DONE) return null;
        return { ...common, status: 'refunded', orderId: customId, captureId: captureIdFromLinks(r.links) || undefined, txnUid: String(r.id || '').slice(0, 128), reason: 'refund' };
      case EVT.reversed:
        return { ...common, status: 'refunded', orderId: customId, captureId: typeof r.id === 'string' && ID_RE.test(r.id) ? r.id : undefined, txnUid: String(r.id || '').slice(0, 128), reason: 'reversed' };
      case EVT.approved: {
        const pu = Array.isArray(r.purchase_units) ? r.purchase_units[0] : null;
        const oid = pu && typeof pu.custom_id === 'string' && ID_RE.test(pu.custom_id) ? pu.custom_id : undefined;
        return { eventId, status: 'approved', orderId: oid, providerRef: typeof r.id === 'string' ? r.id : undefined, amountAgorot: null, currency: '', txnUid: '', receiptUrl: '', reason: '' };
      }
      default:
        return null;
    }
  }

  async function verifyWebhook(req) {
    let c;
    try {
      c = creds();
    } catch (_) {
      return { ok: false, reason: 'not_configured' };
    }
    if (!c.webhookId) return { ok: false, reason: 'not_configured' };
    const h = (req && req.headers) || {};
    const get = (k) => (typeof h[k] === 'string' ? h[k] : '');
    const t = { authAlgo: get(WEBHOOK_HEADERS.authAlgo), certUrl: get(WEBHOOK_HEADERS.certUrl), id: get(WEBHOOK_HEADERS.transmissionId), sig: get(WEBHOOK_HEADERS.transmissionSig), time: get(WEBHOOK_HEADERS.transmissionTime) };
    const body = req && req.body;
    if (!t.authAlgo || !t.certUrl || !t.id || !t.sig || !t.time || !body || typeof body !== 'object') return { ok: false, reason: 'bad_signature' };
    if (!isHttpsUrl(t.certUrl) || !hostOk(t.certUrl, APPROVAL_HOST_SUFFIX)) return { ok: false, reason: 'bad_signature' }; // never make PayPal fetch an attacker's cert URL

    let r;
    try {
      r = await api('POST', VERIFY_WEBHOOK_PATH, {
        json: { auth_algo: t.authAlgo, cert_url: t.certUrl, transmission_id: t.id, transmission_sig: t.sig, transmission_time: t.time, webhook_id: c.webhookId, webhook_event: body },
      });
    } catch (e) {
      return { ok: false, reason: e && e.code === 'not_configured' ? 'not_configured' : 'verify_unavailable' }; // 5xx: PayPal retries later
    }
    if (r.status >= 500) return { ok: false, reason: 'verify_unavailable' };
    if (r.status === 401 || r.status === 403) return { ok: false, reason: 'not_configured' }; // our credentials are wrong: not the sender's fault
    if (!r.ok || !r.json || r.json.verification_status !== VERIFY_SUCCESS) return { ok: false, reason: 'bad_signature' };
    return { ok: true, event: parseEvent(body) };
  }

  return { createPaymentPage, capture, verifyWebhook };
}

const adapter = createPayPalAdapter();

module.exports = {
  name: 'paypal',
  createPaymentPage: adapter.createPaymentPage,
  capture: adapter.capture,
  verifyWebhook: adapter.verifyWebhook,
  secrets: [PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_WEBHOOK_ID, PAYPAL_ENV],
  createPayPalAdapter,
  ProviderError,
  _internals: { API_BASE, EVT },
};
