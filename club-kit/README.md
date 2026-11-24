# Club Kit

Customer club + digital store + orders + payments (PayPal by default) for small static sites hosted on Firebase/Vercel.
Hebrew / RTL. One Firebase project **per site**. This folder is the source; each new site gets a copy.

- Contract (binding, owned by the contract author): [`CONTRACT.md`](CONTRACT.md). **This README lists the additions the backend made to it** (section "Changes vs CONTRACT.md").
- Owner setup guide (Hebrew): [`SETUP.md`](SETUP.md)
- Legal templates (Hebrew, **not legal advice**): [`LEGAL-TEMPLATES.md`](LEGAL-TEMPLATES.md)

## Structure

```
club-kit/
  CONTRACT.md  README.md  SETUP.md  LEGAL-TEMPLATES.md
  club.config.json         ONE config per site (provider, tiers, points, limits, siteUrl, age gate, terms version)
  firebase.json            functions (nodejs22) + firestore + storage rules (+ emulators). Site hosting headers: see hosting-examples/
  .firebaserc.example      copy to .firebaserc and set the project id
  firestore.rules          default deny; field allow-lists; server-only fields; owner-only reads
  firestore.indexes.json   orders(uid, createdAt desc), orders(uid, status, createdAt), products(active, sort)
  storage.rules            deny all (paid files are served as signed URLs by getEntitledContent)
  catalog.sample.json      3 DRAFT placeholder products, active:false
  catalog.coin-packs.json  coin packs 250/3.90, 850/9.90, 5500/19.90 NIS (VAT incl.), active:false
  hosting-examples/        CSP + security headers for the SITE's firebase.json / vercel.json
  functions/               Node 22, CommonJS, firebase-functions v2 + firebase-admin, region europe-west1
    index.js               createCheckout, capturePayPalOrder, paymentWebhook, declareAge, getEntitledContent, deleteMyAccount, onUserCreate
    src/config.js          config loader + validation
    src/club.js            PURE: tier / discount / points math
    src/cart.js            PURE: validation, server-side pricing, order item snapshot (grants, accessDays, coins)
    src/entitlements.js    PURE: per-order contributions -> expiry (refund-safe), isActive
    src/age.js             age gate (declareAge core, assertAdult)
    src/checkout.js        createCheckout core
    src/payments.js        THE money logic: transactional state machine, duplicate/replay detection, coins, refunds
    src/capture.js         server-side capture (PayPal) - used by the callable and by the webhook backup
    src/webhook.js         HTTP layer of the webhook
    src/content.js         getEntitledContent core (server-side entitlement enforcement)
    src/account.js         onUserCreate bootstrap + deleteMyAccount core
    src/lib.js             reusable exports for other functions packages (Game Night)
    src/providers/         paypal.js (default), payplus.js (optional), index.js (registry), README.md (add Cardcom/Tranzila/Meshulam)
    test/                  node:test unit tests + fake Firestore; test/rules + test/emulator need the emulator
  scripts/                 sync-config, set-admin, seed-products, refund-order, check-legal
  web/                     frontend (club/club.js) - owned by the frontend work
```

## Using the kit for a new site
1. Copy `club-kit/` into the new site's repo (or keep it as a sibling folder).
2. New Firebase project (Blaze) -> follow `SETUP.md` (Auth, Firestore, PayPal app + secrets, deploy, webhook, sandbox checklist).
3. Edit `club.config.json`: `appId`, `siteUrl`, `termsVersion`, tiers/limits.
4. `cd functions && npm install && npm test`, then `firebase deploy --only functions,firestore:rules,firestore:indexes` from `club-kit/`.
5. Seed/activate real products, publish the legal texts, wire the frontend (`web/club/club.js`), add the headers from `hosting-examples/`.

### Why the config is copied into `functions/`
Cloud Functions uploads only `functions/`, so `../club.config.json` would not exist at runtime. `firebase.json` has `"predeploy": ["node scripts/sync-config.js"]`, which copies it to `functions/club.config.json` (git-ignored, regenerated at every deploy). `src/config.js` reads that copy first and falls back to `../club.config.json` locally. The frontend has its own `web/club/club.config.json` (tiers shown in the UI): **keep the tiers identical to the root file** (the server's values are the ones that are charged).

## Config reference (`club.config.json`)

| key | default | meaning |
|---|---|---|
| `appId` | `"site"` | stored on every order; `[a-z0-9_-]{1,40}` |
| `region` | `europe-west1` | functions region (the frontend must use the same) |
| `siteUrl` | `""` | https origin of the site (http only for localhost). **Required** for checkout |
| `returnPath` | `"/"` | page the customer returns to: `?checkout=success\|cancel&order=ID` is appended (PayPal adds `token`, `PayerID`) |
| `webhookUrl` | `""` | override for the webhook URL; empty = `https://<region>-<project>.cloudfunctions.net/paymentWebhook` |
| `currency` | `ILS` | only `ILS` |
| `provider` | `paypal` | `paypal` or `payplus` |
| `paypal.brandName` / `paypal.locale` | `""` / `he_IL` | shown on the PayPal approval page |
| `payplus.environment` | `sandbox` | only for `provider: payplus` |
| `termsVersion` | `"1"` | stored in every order; bump when the terms change |
| `ageGate.required` / `ageGate.minAge` | `true` / `18` | checkout requires a server-recorded adult declaration |
| `enforceAppCheck` | `false` | passed to all callables |
| `points.perShekel` | `1` | points per 1 NIS paid (floor) |
| `tiers[]` | member 0 / silver 20000 / gold 60000 agorot | `{id, minSpendAgorot, discountPct}`; sorted; first = 0; must include `member`; discount 0..90 |
| `limits.*` | 20 lines / 10 qty / 5 pending per hour / 10,000 NIS cap | cart limits and rate limit |

Secrets (never in config/code): `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, `PAYPAL_ENV` (`sandbox`|`live`); PayPlus: `PAYPLUS_API_KEY`, `PAYPLUS_SECRET_KEY`, `PAYPLUS_PAGE_UID`.

## How a purchase works (PayPal)

1. **declareAge** `{birthDate:'YYYY-MM-DD'}` -> `{adult}` (or `{adult, already:true}`). Server-only write of `users/{uid}.adult`; the birth date lives in `ageGates/{uid}` (no client access). A different date after a declaration returns the existing result, so a minor cannot retry. Age is evaluated on the Israeli calendar day.
2. **createCheckout** `{items:[{productId,qty}], consent:true}` -> `{orderId, paymentUrl}`. Requires an adult declaration (`FAILED_PRECONDITION`, `details.reason` = `age-required` | `not-adult`), validates every field, prices from `products`, tier discount from the server-side `members` doc (not for `noDiscount` products such as coin packs), rate-limits (5 pending/hour) and creates the order in one transaction, then creates the PayPal order (custom_id = our orderId). `paymentUrl` is the PayPal approval link.
3. Buyer approves at PayPal and returns to `siteUrl + returnPath ?checkout=success&order=ID&token=...`.
4. **capturePayPalOrder** `{orderId}` -> `{status:'paid'|'pending'|'failed'|'not_approved'|'refunded', orderId}`. Captures the PayPal order stored on OUR order (never a client-supplied id), verifies the PayPal order belongs to our order, status COMPLETED, amount and currency, then runs the same transaction as the webhook. Idempotent. `pending` means PayPal is holding the payment: nothing is granted yet.
5. **paymentWebhook** (backup): verifies with PayPal's verify-webhook-signature API. `CHECKOUT.ORDER.APPROVED` triggers the server-side capture; `PAYMENT.CAPTURE.COMPLETED/DENIED/REFUNDED/REVERSED` update the order.

### Money rules (payments.js, one Firestore transaction per event)
- Price, grants, coins always come from the STORED order, never from the event or the client. Amount and currency must equal the stored total, else the order is NOT paid and is flagged `needsManualReview` + an alert-grade log.
- `pending|failed|cancelled -> paid`, `pending -> failed`, `paid -x-> failed`, `paid -> refunded` (terminal). Partial refund -> flagged only.
- **Replay detection:** `paymentEvents/{eventId}` (a provider event is processed once); `paymentTxns/{chargeId}` (a charge belongs to ONE order; also resolves refund events that only name the charge).
- **Duplicate charge:** a second, different charge on an order that is already `paid` (or `refunded`) is flagged (`webhookAnomaly: duplicate_charge | paid_after_refund`, `needsManualReview`, `duplicateTxnUids`) and logged with `alert: 'manual_review'`. A refund of the duplicate charge is recorded without touching the order's entitlements.
- **Paid for a deleted account** is recorded and flagged (nobody received the goods).
- **Entitlements** (`users/{uid}/entitlements/{feature}`) store per-order `contributions`; `expiresAt` is derived (lifetime wins; time-limited purchases stack). A refund removes only that order's contribution and recomputes; the document is deleted only when nothing remains.
- **Coins:** `members/{uid}.coins` (wallet; functions-only writes) is credited `coins * qty` per item in the paid transaction, once; ledger rows in `members/{uid}/coinLedger/{orderId}` and `refund-{orderId}`. A refund claws coins back, floor 0; if already spent, `coinShortfall` + `needsManualReview`.

## Server-side entitlement enforcement (what is and is not enforced)
- **Enforced on the server:** purchases (price/age/limits), entitlement grant/revoke/expiry, the coin wallet, and **paid content served through `getEntitledContent({contentId})`** (checks the live entitlement incl. expiry; returns text/json or a 10-minute signed URL for files under `protected/`).
- **Only a UI convenience:** `club.has(feature)` / `club.on('entitlements')` in the browser. Anything already inside the page's HTML/JS/images is public. A static site that ships its "premium" content in its own files is not protected; move that content to `protectedContent/` (Firestore) or `protected/` (Storage). See `SETUP.md` 12.3.

## Changes vs CONTRACT.md (frontend owner: please read)
New / changed backend surface, all additive except where stated:
1. **New callable `declareAge({birthDate})`**; the frontend must collect a birth date (once) before checkout. `createCheckout` now fails with `details.reason` `age-required` or `not-adult` (Hebrew `message`) otherwise.
2. **New callable `capturePayPalOrder({orderId})`**: call it when the page loads with `?checkout=success&order=ID` (before/while waiting for `paid`). The webhook is only a backup. Payment is no longer "paid by webhook only".
3. `createCheckout` returns the same `{orderId, paymentUrl}`; with PayPal the URL is on `paypal.com`.
4. **New callable `getEntitledContent({contentId})`** for server-enforced paid content.
5. **`deleteMyAccount({force?})`**: with a payment possibly in flight (pending order < 30 min) it fails with `details.reason: 'pending_order'` unless `force:true`; the frontend should warn and retry with `force:true`.
6. Order `items[]` may carry `grants`, `accessDays`, `coins`, `noDiscount`; orders carry `termsVersion`, `ageGateOk`, `needsManualReview`, `webhookAnomaly`, `refunded*`, `coinsAwarded`, etc. Order `status` values are unchanged.
7. `users/{uid}` gains server-only `adult`, `ageDeclaredAt`, `ageGateMinAge` (readable by the owner; clients cannot write them: rules). Update rule no longer lets a client change `createdAt`.
8. `members/{uid}` gains `coins` (wallet) and the subcollection `coinLedger` (owner read-only). Products may have `coins` (int) and `noDiscount` (bool).
9. Entitlement docs gain `contributions[]` (extra; `feature, productId, orderId, grantedAt, expiresAt` unchanged).
10. Provider adapter interface gains optional `capture({order, providerRef})`; `verifyWebhook` may be async; events may have `status: 'refunded'|'approved'`, `eventId`, `captureId`, `providerRef`.
11. Config gains `provider:'paypal'` (default), `paypal`, `termsVersion`, `ageGate`. The frontend copy `web/club/club.config.json` must mirror `tiers`.
12. Runtime moved from Node 20 to **Node 22**.

## Reuse in another functions package (e.g. Game Night)
`functions/src/lib.js` re-exports the reusable parts (PayPal adapter factory, `captureOrderCore`, `processPaymentEvent`, `handleWebhook`, `declareAgeCore`, entitlement math, club math, utils). The PayPal adapter only needs `{order:{id,items,totalAgorot,discountAgorot,currency}, successUrl, cancelUrl}` and returns `{paymentUrl, providerRef}`; `capture({order, providerRef})` returns `{state:'event'|'pending'|'not_approved', event?}`. A coin shop that keeps its own order documents (`createCoinOrder` / `captureCoinOrder` / its own `paymentWebhook`) can call the adapter directly and credit coins in its own transaction keyed on `event.txnUid`; `declareAgeCore` accepts `userCollection` and `userFields` (e.g. `birthYear`) hooks and returns `{adult}` / `{adult, already:true}` with `details.reason: 'invalid'` for bad dates. Reason codes use the same names as Game Night's `docs/ECONOMY.md` (`age-required`, `not-adult`, `invalid`). The Game Night callables `claimReward`, `spendCoins`, `claimDailyGift` are NOT part of this kit (they are game logic).

## Testing
```bash
cd functions && npm install
npm test            # node:test, offline (fake Firestore, mocked fetch)
npm run test:rules  # needs Java + firebase-tools: Firestore rules tests + admin-SDK flow on the emulator
```
The emulator does not enforce composite indexes: after deploying, exercise the real queries once. Unit tests prove the code matches its stated PayPal assumptions (mocked `fetch`); they do **not** prove those assumptions (SETUP.md 11).

## Known limitations / follow-ups
- **PayPal (and PayPlus) API facts are unverified**; see SETUP.md 11.
- Pending orders are never garbage-collected (a stale pending order can still be captured while PayPal keeps the PayPal order approvable); add a scheduled cleanup if volume grows.
- `termsAcceptedAt` / `marketingConsent` on the profile are client-written (weak evidence); the order stores the server-side `termsAcceptedAt` and `termsVersion`. A server-stamped `marketingConsentAt` is not implemented.
- `deleteMyAccount` does not require a recent sign-in.
- `refund-order.js` does not verify with the provider that the money was refunded.
- The admin claim is not used by any rule/function yet.
- `npm audit`: remaining findings are in devDependencies (`firebase`, for rules tests); do not run `audit fix --force`.
- Age is a self-declaration, not identity verification.
