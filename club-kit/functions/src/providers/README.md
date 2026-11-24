# Payment provider adapters

The rest of the backend only talks to the interface below. Swapping Cardcom / Tranzila / Meshulam (or anyone else)
means adding ONE file here plus one line in `index.js`. Nothing in `checkout.js`, `webhook.js`, rules or the frontend changes.

## Interface (from CONTRACT.md)

```js
module.exports = {
  name: 'cardcom',
  secrets: [CARDCOM_TERMINAL, CARDCOM_API_NAME],          // defineSecret(...) objects; deployed with the functions
  // Server-side only. Creates a hosted payment page and returns where to send the customer.
  async createPaymentPage({ order, customer, successUrl, cancelUrl, webhookUrl }) {
    // order    = { id, items:[{productId,name,priceAgorot,qty}], subtotalAgorot, discountAgorot, totalAgorot, currency:'ILS' }
    // customer = { name, email, phone }   (any may be '')
    // return   { paymentUrl, providerRef }   providerRef = the provider's id of the payment page/session
    // throw    an Error with a short `.code` string on failure (message must contain no secrets)
  },
  // OPTIONAL (providers with a separate capture step, e.g. PayPal): called by capturePayPalOrder / the webhook backup.
  //   async capture({ order:{id,totalAgorot,currency}, providerRef }) -> { state:'event', event } | { state:'pending' } | { state:'not_approved' }
  //   Must verify the provider order belongs to `order.id` and use the provider order id passed in (the stored one).
  // May be sync or async (the handler awaits it). MUST authenticate the request (signature/HMAC/secret) in constant time. Never trust an unsigned body.
  verifyWebhook(req) {
    // req.rawBody (Buffer), req.body (parsed), req.headers
    // return { ok:false, reason:'bad_signature' }                        -> HTTP 401
    // return { ok:true, event:null }                                      -> signed but not a payment event: HTTP 200, ignored
    // return { ok:true, event:{ orderId, status, amountAgorot, currency, txnUid, receiptUrl, providerRef, reason } }
    //   status: 'paid' | 'failed' | 'refunded'    (refunded only if the provider sends such callbacks)
    //   amountAgorot: INTEGER agorot (convert provider decimals with util.shekelToAgorot; null if unparseable)
    //   orderId must come from a field YOU set when creating the page (e.g. a custom/reference field)
  },
};
```

## Steps to add a provider

0. `paypal.js` is the reference implementation (async verification, capture, idempotency keys). 
1. Copy `paypal.js` or `payplus.js` to `cardcom.js` and keep its structure: constants for every unverified fact at the top,
   a `VERIFY-WITH-DOCS` checklist, an injectable factory (`createXAdapter({ getCredentials, fetchImpl })`) so it can be unit-tested.
2. Register it in `index.js`: `cardcom: () => require('./cardcom')`.
3. Set `"provider": "cardcom"` in `club.config.json` (the order stores `provider`).
4. Copy `test/payplus.test.js` and adapt: request shape, signature accept/reject (wrong secret, tampered body, missing header),
   amount parsing, failed/refund mapping.
5. Document the provider's secrets and webhook URL in SETUP.md.

## Rules every adapter must follow

- Card data never touches our code: use the provider's **hosted** page (redirect), not their direct-charge API.
- Prices come from the server-stored order (`order.totalAgorot`), never from the client.
- Compare signatures with `util.safeEqual` (constant time). No early returns that depend on secret bytes.
- Errors: short `.code`, no secrets/URLs with tokens in messages (they end up in logs).
- Check the returned payment URL is https and on the provider's domain.
- If the provider does not echo your order id back in the callback, store a lookup (providerRef -> orderId) before returning from `createPaymentPage`.
- Amount in the callback must be convertible to integer agorot; the core compares it with the stored order total and currency.

## Provider hints (UNVERIFIED, from memory - check each provider's docs)

- **Cardcom**: "Low Profile" hosted page (create deal -> `LowProfileCode`; the indicator/notify URL is called server-to-server; confirm the deal by querying their API with your terminal credentials instead of trusting the callback body).
- **Tranzila**: hosted iframe/redirect "payment page" with notify URL; verify the response by a signature/token or a server-side lookup.
- **Meshulam (Grow)**: `createPaymentProcess` returns a hosted URL; success callback must be confirmed via their `approveTransaction` call.

For providers whose callback has no signature, the safe pattern is: treat the callback as a *hint* and re-fetch the transaction from the provider API with your secret credentials inside `verifyWebhook`/`processPaymentEvent` before marking the order paid.
