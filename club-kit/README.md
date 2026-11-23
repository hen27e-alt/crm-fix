# Club Kit

Customer club + digital store + orders + payments for small static sites hosted on Firebase/Vercel.
Hebrew / RTL. One Firebase project **per site**. This repo folder is the source; each new site gets a copy.

- Contract (binding): [`CONTRACT.md`](CONTRACT.md)
- Owner setup guide (Hebrew): [`SETUP.md`](SETUP.md)
- Legal templates (Hebrew, **not legal advice**): [`LEGAL-TEMPLATES.md`](LEGAL-TEMPLATES.md)

## Structure

```
club-kit/
  CONTRACT.md              technical contract (schema, functions, provider interface, security)
  README.md  SETUP.md  LEGAL-TEMPLATES.md
  club.config.json         ONE config per site (tiers, points, limits, siteUrl, provider, App Check)
  firebase.json            functions + firestore (+ emulators). Hosting headers belong to the SITE's own firebase.json/vercel.json
  .firebaserc.example      copy to .firebaserc and set the project id
  firestore.rules          default deny; field allow-lists; owner-only reads
  firestore.indexes.json   orders(uid, createdAt desc), orders(uid, status, createdAt), products(active, sort)
  catalog.sample.json      3 DRAFT placeholder products, all active:false
  functions/               Node 20, CommonJS, firebase-functions v2 + firebase-admin, region europe-west1
    index.js               exports createCheckout, paymentWebhook, deleteMyAccount, onUserCreate
    src/config.js          config loader + validation (defaults merged, unsafe values rejected at startup)
    src/club.js            PURE: tier / discount / points math
    src/cart.js            PURE: input validation, server-side pricing, order items snapshot
    src/checkout.js        createCheckout core (dependency-injected, unit-testable)
    src/webhook.js         payment webhook core: signature -> amount check -> transactional state machine
    src/account.js         onUserCreate bootstrap + deleteMyAccount core
    src/errors.js          Hebrew, user-safe HttpsError messages
    src/log.js             safe logger (drops secrets/PII-looking keys, never dumps bodies)
    src/util.js            constant-time compare, phone normalisation, money conversions
    src/providers/         payplus.js (adapter), index.js (registry), README.md (how to add Cardcom/Tranzila/Meshulam)
    test/                  node:test unit tests + fake Firestore; test/rules + test/emulator need the emulator
  scripts/
    sync-config.js         predeploy hook: copies club.config.json into functions/
    set-admin.js           grant/remove the `admin` custom claim (local, service account)
    seed-products.js       write products from a catalog (dry run unless --confirm)
    refund-order.js        record a full refund in Firestore after refunding in the provider dashboard
  web/                     frontend (club/club.js) - owned by the frontend work, see CONTRACT.md
```

## Using the kit for a new site

1. Copy the whole `club-kit/` folder into the new site's repo (or keep it as a sibling folder).
2. Create a new Firebase project (Blaze) and follow `SETUP.md` (Auth, Firestore, secrets, deploy).
3. Edit `club.config.json`: `appId`, `siteUrl`, tiers/limits if needed. Keep `payplus.environment: "sandbox"` until the sandbox checklist passes.
4. `cd functions && npm install`, `npm test`, then `firebase deploy --only functions,firestore:rules,firestore:indexes` from `club-kit/`.
5. Seed/activate real products, publish the legal texts, wire the frontend (`web/club/club.js`) with that project's `firebaseConfig` and `appId`.

### Why the config is copied into `functions/`
Cloud Functions uploads only the `functions/` directory, so `../club.config.json` would not exist at runtime.
`firebase.json` has `"predeploy": ["node scripts/sync-config.js"]` which copies it to `functions/club.config.json` (git-ignored, regenerated on every deploy).
`src/config.js` reads that bundled copy first and falls back to `../club.config.json` for local runs and tests. If neither exists it uses safe defaults, but checkout refuses to run without `siteUrl`.

## Config reference (`club.config.json`)

| key | default | meaning |
|---|---|---|
| `appId` | `"site"` | stored on every order; `[a-z0-9_-]{1,40}` |
| `region` | `europe-west1` | functions region (the frontend must use the same) |
| `siteUrl` | `""` | https origin of the site (http only for localhost). **Required** for checkout |
| `returnPath` | `"/"` | page the customer returns to: `?checkout=success\|cancel&order=ID` is appended |
| `webhookUrl` | `""` | override for the webhook URL sent to the provider; empty = `https://<region>-<project>.cloudfunctions.net/paymentWebhook` |
| `currency` | `ILS` | only `ILS` is accepted |
| `provider` | `payplus` | adapter name in `functions/src/providers/index.js` |
| `enforceAppCheck` | `false` | passed to the callable functions |
| `payplus.environment` | `sandbox` | `sandbox` or `production` |
| `points.perShekel` | `1` | points per 1 NIS paid (floor) |
| `tiers[]` | member 0 / silver 20000 / gold 60000 agorot | `{id, minSpendAgorot, discountPct}`; sorted, first = 0, must include `member`; discount 0..90 |
| `limits.maxLines` | `20` | cart lines (max 20) |
| `limits.maxQtyPerLine` | `10` | per product, after merging duplicates (max 10) |
| `limits.maxPendingOrdersPerHour` | `5` | per user |
| `limits.maxOrderTotalAgorot` | `1000000` | sanity cap (10,000 NIS) |

## Behaviour summary

**createCheckout** `{items:[{productId,qty}], consent:true}` -> `{orderId, paymentUrl}`. Auth required. Validates every field; merges duplicate products (merged qty still <= 10);
reads price/name/grants/accessDays from `products` (inactive/unknown/malformed -> error); tier + discount from the server-side `members` doc;
rate-limit check and order creation in one transaction; then asks the provider for a hosted page. Provider failure marks the order `failed` and returns a generic Hebrew error.

**paymentWebhook** (POST only). Provider adapter authenticates the request (constant-time HMAC compare) -> 401 on failure.
Then, in ONE transaction, using only the *stored* order: amount + currency must equal the order; state machine `pending|failed|cancelled -> paid`, `pending -> failed`, `paid -x-> failed` (never downgraded), `paid -> refunded` (full refund: entitlements of that order deleted, points/spend/ordersCount reversed, tier recomputed; partial refund is only flagged `needsManualReview`).
Replays / concurrent duplicates are no-ops. Mismatch -> order untouched, `webhookAnomaly` set, logged at ERROR, HTTP 200 (retrying cannot help).
Unexpected internal failure -> HTTP 500 so the provider retries (safe because processing is idempotent).

**deleteMyAccount** anonymises the user's orders in batches (`uid -> "deleted"`, pending -> cancelled), recursively deletes `users/{uid}` (+ entitlements), deletes `members/{uid}`, and deletes the Auth user **last** (so a failure can be retried).

**onUserCreate** (Auth v1 trigger; v2 has no plain Auth onCreate) creates `users/{uid}` and `members/{uid}` only if missing. The webhook and checkout also tolerate a missing `members` doc.

### Additions to the contract (additive, backend-internal)
- `orders.items[]` also stores `grants` and `accessDays` (snapshot, so editing a product later cannot change what a paid order grants).
- `orders` extra server-written fields: `consent`, `termsAcceptedAt`, `pointsAwarded`, `spendAddedAgorot`, `grantedFeatures`, `refundedAt`, `refundedAgorot`, `anonymizedAt`, `webhookAnomaly`, `needsManualReview`, `lastPartialRefundAgorot`, `updatedAt`.
- Adapter `event.status` may be `'refunded'`, plus `event.providerRef` / `event.reason`; `verifyWebhook` may return `{ok:true,event:null}` for signed non-payment messages.
- Entitlement stacking: `accessDays * qty` per item; buying a feature you already have extends from the remaining time; lifetime wins. A refund revokes only entitlements still controlled by that order (`orderId` match).

## Testing

```bash
cd functions
npm install
npm test               # node:test, offline: 79 unit tests (math, cart, checkout, webhook, adapter, account)
npm run test:rules     # needs Java + firebase-tools: Firestore rules tests + admin-SDK flow on the emulator
```
`test:rules` runs `firebase emulators:exec` (install `firebase-tools` globally). Note the emulator does **not** enforce composite indexes: after deploying, exercise the real queries once.

## Known limitations / follow-ups
- PayPlus API facts are partly unverified: see `SETUP.md` section 11 and the `VERIFY-WITH-DOCS` list in `functions/src/providers/payplus.js`.
- Refunding an order whose entitlement was later extended by another purchase leaves that entitlement in place (it is controlled by the later order); handle manually.
- Partial refunds and amount anomalies are flagged, not auto-resolved.
- `deleteMyAccount` does not require a recent sign-in. Consider requiring `auth_time` within the last few minutes (frontend must then re-authenticate first).
- Pending orders are never garbage-collected; add a scheduled cleanup if volume grows.
- Rules allow the owner to write `email`/`phone` on their profile (unverified contact fields, never used for authorisation).
- Admin claim is created by `scripts/set-admin.js` but the rules deliberately grant admins nothing extra yet (products are edited via console/Admin SDK).
