'use strict';
/**
 * PayPlus provider adapter (Israeli payment provider) - hosted payment page ("generateLink") + IPN callback.
 *
 * Contract interface (CONTRACT.md):
 *   createPaymentPage({ order, customer, successUrl, cancelUrl, webhookUrl }) -> Promise<{ paymentUrl, providerRef }>
 *   verifyWebhook(req) -> { ok, event: { orderId, status, amountAgorot, currency, txnUid, receiptUrl } }
 *
 * Extensions (additive, internal to the backend; the frontend never sees them):
 *   - input  order.id (required), order.items, order.totalAgorot, order.discountAgorot, order.currency
 *   - output event.status may also be 'refunded'; event.providerRef (page_request_uid); event.reason (short code)
 *   - verifyWebhook returns { ok:true, event:null } for a correctly signed message that is not a payment event.
 *
 * NO CARD DATA touches this code: the customer pays on PayPlus' hosted page (PCI SAQ-A).
 *
 * ---------------------------------------------------------------------------------------------
 * HOW MUCH OF THIS WAS VERIFIED?  (honest status - read before going live)
 * The official docs host (docs.payplus.co.il) was NOT reachable from the build sandbox. The only
 * external evidence was a web-search summary (second-hand, not the docs pages themselves) saying:
 *   - generateLink is under "Payment Pages"; it takes `payment_page_uid` in the body and
 *     `api-key` + `secret-key` in the HEADERS;
 *   - `refURL_callback` is the server-to-server notification URL, `refURL_success` the user redirect;
 *   - `more_info` is echoed back in callbacks/redirects;
 *   - callbacks carry headers `hash` and `user-agent`; the docs' sample checks user-agent "PayPlus" and an
 *     HMAC-SHA256 of the JSON body keyed with the API secret key (digest encoding NOT confirmed).
 * EVERYTHING ELSE below comes from the author's memory and is UNVERIFIED. Each such fact is a named
 * constant (or a single small function) so it can be corrected in one place.
 *
 * VERIFY-WITH-DOCS checklist (also listed in SETUP.md section "בדיקת הנחות מול PayPlus"):
 *  [ ] V1  Base URLs: sandbox https://restapidev.payplus.co.il/api/v1.0 , production https://restapi.payplus.co.il/api/v1.0
 *  [ ] V2  Endpoint path POST /PaymentPages/generateLink
 *  [ ] V3  Auth header names `api-key` and `secret-key` (second-hand evidence only)
 *  [ ] V4  Request body field names: payment_page_uid, charge_method (1 = regular charge), amount (decimal SHEKELS,
 *          not agorot), currency_code, language_code, refURL_success / refURL_failure / refURL_cancel / refURL_callback,
 *          send_failure_callback, more_info, customer{customer_name,email,phone}, items[{name,quantity,price}],
 *          sendEmailApproval, create_token
 *  [ ] V5  Itemisation rule: line items must sum to `amount`; with a club discount we send ONE aggregated line
 *          (see buildItems). Confirm PayPlus does not reject/alter this and how receipts (invoices) look.
 *  [ ] V6  Response shape: results.status === "success"; data.payment_page_link; data.page_request_uid
 *  [ ] V7  Callback signature: header name `hash`; algorithm HMAC-SHA256; key = SECRET key; message = raw JSON body;
 *          digest encoding (base64 vs hex - both accepted below); whether PayPlus signs the raw bytes or a re-serialisation
 *  [ ] V8  Callback body paths: transaction.uid, transaction.payment_page_request_uid, transaction.more_info,
 *          transaction.status_code ("000" = approved), transaction.amount (decimal shekels), transaction.currency,
 *          and the path(s) of the receipt/invoice URL (RECEIPT_URL_PATHS is a guess)
 *  [ ] V9  Whether failed payments produce a callback (send_failure_callback) and with which status_code values
 *  [ ] V10 Whether refunds produce a callback at all, and how it is marked (REFUND_MARKERS is a guess).
 *          If PayPlus sends none, refunds must be recorded with scripts/refund-order.js
 *  [ ] V11 Hosted page domain (PAYMENT_URL_HOST_SUFFIX guard)
 *  [ ] V12 `more_info` max length / charset (we send the 20-char Firestore order id)
 * ---------------------------------------------------------------------------------------------
 */
const crypto = require('node:crypto');
const { defineSecret } = require('firebase-functions/params');
const { safeEqual, cleanText, agorotToShekel, shekelToAgorot } = require('../util');

// ---- Secrets (set with `firebase functions:secrets:set NAME`) -----------------------------------
const PAYPLUS_API_KEY = defineSecret('PAYPLUS_API_KEY');
const PAYPLUS_SECRET_KEY = defineSecret('PAYPLUS_SECRET_KEY');
const PAYPLUS_PAGE_UID = defineSecret('PAYPLUS_PAGE_UID');

// ---- UNVERIFIED / PARTLY VERIFIED PROVIDER FACTS (see checklist above) --------------------------
const API_BASE = Object.freeze({
  sandbox: 'https://restapidev.payplus.co.il/api/v1.0', // V1
  production: 'https://restapi.payplus.co.il/api/v1.0', // V1
});
const GENERATE_LINK_PATH = '/PaymentPages/generateLink'; // V2
const HEADER_API_KEY = 'api-key'; // V3 (second-hand evidence)
const HEADER_SECRET_KEY = 'secret-key'; // V3 (second-hand evidence)
const CHARGE_METHOD_CHARGE = 1; // V4
const LANGUAGE_CODE = 'he'; // V4
const CALLBACK_HASH_HEADER = 'hash'; // V7 (second-hand evidence)
const CALLBACK_HASH_ALGO = 'sha256'; // V7 (second-hand evidence)
const CALLBACK_HASH_ENCODINGS = Object.freeze(['base64', 'hex']); // V7: digest encoding unconfirmed -> accept both
const SUCCESS_STATUS_CODE = '000'; // V8
const REFUND_MARKERS = Object.freeze(['refund']); // V10 guess: substring match, case-insensitive, on transaction_type / transaction.type / transaction.status
const RECEIPT_URL_PATHS = Object.freeze([
  ['data', 'invoice_link'],
  ['transaction', 'invoice_link'],
  ['transaction', 'receipt_link'],
  ['invoice', 'link'],
  ['data', 'invoice', 'link'],
]); // V8 guess; first https URL found wins
const PAYMENT_URL_HOST_SUFFIX = 'payplus.co.il'; // V11
const REQUEST_TIMEOUT_MS = 15000;
const ORDER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

class ProviderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProviderError';
    this.code = code; // short machine code, safe to log
  }
}

function dig(obj, pathArr) {
  let cur = obj;
  for (const k of pathArr) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

function isHttpsUrl(s) {
  if (typeof s !== 'string' || s.length > 2048) return false;
  try {
    return new URL(s).protocol === 'https:';
  } catch (_) {
    return false;
  }
}

/**
 * V5: itemised lines when there is no discount; otherwise a single aggregated line so that
 * sum(items) === amount always holds. Prices are decimal shekels.
 */
function buildItems(order) {
  if (!order.discountAgorot && Array.isArray(order.items) && order.items.length) {
    return order.items.map((it) => ({
      name: cleanText(it.name, 120) || 'מוצר דיגיטלי',
      quantity: it.qty,
      price: agorotToShekel(it.priceAgorot),
    }));
  }
  return [{ name: `הזמנה ${order.id}`, quantity: 1, price: agorotToShekel(order.totalAgorot) }];
}

function createPayPlusAdapter(opts = {}) {
  const getCredentials =
    opts.getCredentials ||
    (() => ({
      apiKey: PAYPLUS_API_KEY.value(),
      secretKey: PAYPLUS_SECRET_KEY.value(),
      pageUid: PAYPLUS_PAGE_UID.value(),
    }));
  const getEnvironment = opts.getEnvironment || (() => require('../config').loadConfig().payplus.environment);
  const fetchImpl = opts.fetchImpl || ((...a) => fetch(...a));

  async function createPaymentPage({ order, customer, successUrl, cancelUrl, webhookUrl }) {
    if (!order || !ORDER_ID_RE.test(String(order.id || ''))) throw new ProviderError('bad_order', 'order.id missing');
    if (!Number.isInteger(order.totalAgorot) || order.totalAgorot <= 0) throw new ProviderError('bad_order', 'bad total');
    if (order.currency !== 'ILS') throw new ProviderError('bad_order', 'currency');
    for (const u of [successUrl, cancelUrl, webhookUrl]) if (!isHttpsUrl(u) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(String(u))) throw new ProviderError('bad_url', 'url must be https');

    const creds = getCredentials();
    if (!creds.apiKey || !creds.secretKey || !creds.pageUid) throw new ProviderError('not_configured', 'missing PayPlus secrets');
    const env = getEnvironment();
    const base = API_BASE[env];
    if (!base) throw new ProviderError('not_configured', 'unknown environment');

    const cust = {};
    if (customer && customer.name) cust.customer_name = cleanText(customer.name, 100);
    if (customer && customer.email) cust.email = cleanText(customer.email, 254);
    if (customer && customer.phone) cust.phone = cleanText(customer.phone, 20);

    const body = {
      payment_page_uid: creds.pageUid,
      charge_method: CHARGE_METHOD_CHARGE,
      amount: agorotToShekel(order.totalAgorot),
      currency_code: 'ILS',
      language_code: LANGUAGE_CODE,
      refURL_success: successUrl,
      refURL_failure: cancelUrl,
      refURL_cancel: cancelUrl,
      refURL_callback: webhookUrl,
      send_failure_callback: true,
      more_info: order.id,
      sendEmailApproval: true,
      create_token: false,
      items: buildItems(order),
    };
    if (Object.keys(cust).length) body.customer = cust;

    let res;
    try {
      res = await fetchImpl(base + GENERATE_LINK_PATH, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [HEADER_API_KEY]: creds.apiKey,
          [HEADER_SECRET_KEY]: creds.secretKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      throw new ProviderError('network', e && e.name === 'TimeoutError' ? 'timeout' : 'network error');
    }
    let json = null;
    try {
      json = await res.json();
    } catch (_) {
      throw new ProviderError('bad_response', `http ${res.status}, non-JSON body`);
    }
    // V6
    const ok = res.ok && json && json.results && json.results.status === 'success' && json.data;
    if (!ok) {
      const code = json && json.results && json.results.code !== undefined ? String(json.results.code).slice(0, 20) : 'n/a';
      throw new ProviderError('rejected', `http ${res.status}, provider code ${code}`);
    }
    const paymentUrl = json.data.payment_page_link;
    const providerRef = json.data.page_request_uid;
    if (!isHttpsUrl(paymentUrl)) throw new ProviderError('bad_response', 'payment link missing/not https');
    const host = new URL(paymentUrl).hostname.toLowerCase();
    if (host !== PAYMENT_URL_HOST_SUFFIX && !host.endsWith('.' + PAYMENT_URL_HOST_SUFFIX)) throw new ProviderError('bad_response', 'unexpected payment host');
    if (typeof providerRef !== 'string' || !providerRef || providerRef.length > 128) throw new ProviderError('bad_response', 'page_request_uid missing');
    return { paymentUrl, providerRef };
  }

  /** V7: HMAC over raw body, compared in constant time against the `hash` header. */
  function signatureMatches(req, secretKey) {
    const provided = req.headers && req.headers[CALLBACK_HASH_HEADER];
    if (typeof provided !== 'string' || !provided) return false;
    const candidates = [];
    if (req.rawBody) candidates.push(Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(String(req.rawBody)));
    // fallback: some doc samples hash JSON.stringify(parsedBody) rather than the raw bytes
    if (req.body && typeof req.body === 'object') candidates.push(Buffer.from(JSON.stringify(req.body)));
    let matched = false; // no early exit: keep timing independent of which candidate matched
    for (const msg of candidates) {
      const mac = crypto.createHmac(CALLBACK_HASH_ALGO, secretKey).update(msg);
      const raw = mac.digest();
      for (const enc of CALLBACK_HASH_ENCODINGS) {
        if (safeEqual(raw.toString(enc), provided.trim())) matched = true;
      }
    }
    return matched;
  }

  function parseEvent(body) {
    const tx = body && typeof body === 'object' ? body.transaction : null;
    if (!tx || typeof tx !== 'object') return null;
    const orderId = typeof tx.more_info === 'string' ? tx.more_info : null;
    if (!orderId || !ORDER_ID_RE.test(orderId)) return null;
    const amountAgorot = shekelToAgorot(tx.amount);
    const currency = typeof tx.currency === 'string' ? tx.currency.toUpperCase() : typeof tx.currency_code === 'string' ? tx.currency_code.toUpperCase() : '';
    const txnUid = typeof tx.uid === 'string' ? tx.uid.slice(0, 128) : '';
    const typeText = [body.transaction_type, tx.type, tx.status].filter((x) => typeof x === 'string').join(' ').toLowerCase();
    const isRefund = REFUND_MARKERS.some((m) => typeText.includes(m));
    const approved = String(tx.status_code) === SUCCESS_STATUS_CODE;
    let receiptUrl = '';
    for (const p of RECEIPT_URL_PATHS) {
      const v = dig(body, p);
      if (isHttpsUrl(v)) {
        receiptUrl = v;
        break;
      }
    }
    return {
      orderId,
      status: isRefund ? 'refunded' : approved ? 'paid' : 'failed',
      amountAgorot, // null when unparseable -> the core rejects paid/refund events with a mismatching amount
      currency,
      txnUid,
      receiptUrl,
      providerRef: typeof tx.payment_page_request_uid === 'string' ? tx.payment_page_request_uid.slice(0, 128) : '',
      reason: approved || isRefund ? '' : cleanText(`${tx.status_code || ''} ${tx.status_description || ''}`, 120),
    };
  }

  function verifyWebhook(req) {
    let secretKey;
    try {
      secretKey = getCredentials().secretKey;
    } catch (_) {
      return { ok: false, reason: 'not_configured' };
    }
    if (!secretKey) return { ok: false, reason: 'not_configured' };
    if (!signatureMatches(req, secretKey)) return { ok: false, reason: 'bad_signature' };
    return { ok: true, event: parseEvent(req.body) };
  }

  return { createPaymentPage, verifyWebhook };
}

const adapter = createPayPlusAdapter();

module.exports = {
  name: 'payplus',
  createPaymentPage: adapter.createPaymentPage,
  verifyWebhook: adapter.verifyWebhook,
  secrets: [PAYPLUS_API_KEY, PAYPLUS_SECRET_KEY, PAYPLUS_PAGE_UID],
  createPayPlusAdapter,
  ProviderError,
  _internals: { buildItems, API_BASE, GENERATE_LINK_PATH, SUCCESS_STATUS_CODE },
};
