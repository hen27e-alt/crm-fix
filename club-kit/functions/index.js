'use strict';
/**
 * Club Kit - Cloud Functions entrypoint (Node 20, firebase-functions v2, region from club.config.json).
 *   createCheckout   onCall    (auth required)
 *   paymentWebhook   onRequest (POST, signed by the provider)
 *   capturePayPalOrder onCall  (auth required) captures an approved PayPal order after the buyer returns
 *   declareAge       onCall    (auth required) the ONLY writer of users/{uid}.adult
 *   getEntitledContent onCall  (auth required) serves paid content only to a live entitlement
 *   deleteMyAccount  onCall    (auth required)
 *   onUserCreate     Auth v1 trigger (v2 has no plain Auth onCreate; blocking functions need Identity Platform)
 */
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { getStorage } = require('firebase-admin/storage');
const { setGlobalOptions } = require('firebase-functions/v2');
const { onCall, onRequest } = require('firebase-functions/v2/https');
const functionsV1 = require('firebase-functions/v1');

const { loadConfig } = require('./src/config');
const { getProvider } = require('./src/providers');
const { createCheckoutSafe } = require('./src/checkout');
const { handleWebhook } = require('./src/webhook');
const { deleteAccountCore, ensureUserAndMember } = require('./src/account');
const { captureOrderCore } = require('./src/capture');
const { declareAgeCore } = require('./src/age');
const { getEntitledContentCore } = require('./src/content');
const { httpsError, MSG, HttpsError } = require('./src/errors');
const log = require('./src/log');
const { logId } = require('./src/util');

initializeApp();
const db = getFirestore();
const config = loadConfig();
const provider = getProvider(config.provider);

setGlobalOptions({ region: config.region, maxInstances: 10 });

function resolveWebhookUrl() {
  if (config.webhookUrl) return config.webhookUrl;
  const project = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
  // Gen2 functions are also reachable through the cloudfunctions.net alias. Prefer setting
  // "webhookUrl" in club.config.json to the exact URL printed by `firebase deploy`.
  return project ? `https://${config.region}-${project}.cloudfunctions.net/paymentWebhook` : '';
}

exports.createCheckout = onCall(
  { secrets: provider.secrets, enforceAppCheck: config.enforceAppCheck, timeoutSeconds: 30, memory: '256MiB', maxInstances: 10 },
  async (request) => {
    if (!request.auth) throw httpsError('unauthenticated', MSG.unauthenticated);
    return createCheckoutSafe({
      db,
      provider,
      config,
      uid: request.auth.uid,
      token: request.auth.token,
      data: request.data,
      webhookUrl: resolveWebhookUrl(),
    });
  }
);

exports.paymentWebhook = onRequest(
  { secrets: provider.secrets, cors: false, timeoutSeconds: 30, memory: '256MiB', maxInstances: 10, invoker: 'public' },
  async (req, res) => {
    await handleWebhook({ req, res, provider, db, config });
  }
);

/** Wrap a callable body: only HttpsErrors reach the client, everything else becomes a generic Hebrew error. */
async function safely(name, uid, fn) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    log.error(`${name} failed`, { uid: logId(uid), errType: e && e.name ? String(e.name) : 'Error', errCode: e && e.code !== undefined ? String(e.code).slice(0, 40) : '' });
    throw httpsError('internal', MSG.internal);
  }
}

// PayPal capture after the buyer returns from PayPal. Safe to call repeatedly (idempotent); the webhook is the backup.
exports.capturePayPalOrder = onCall(
  { secrets: provider.secrets, enforceAppCheck: config.enforceAppCheck, timeoutSeconds: 60, memory: '256MiB', maxInstances: 10 },
  async (request) => {
    if (!request.auth) throw httpsError('unauthenticated', MSG.unauthenticated);
    if (config.provider !== 'paypal') throw httpsError('failed-precondition', MSG.noCapture);
    const orderId = request.data && typeof request.data === 'object' ? request.data.orderId : null;
    return safely('capturePayPalOrder', request.auth.uid, () => captureOrderCore({ db, provider, config, orderId, uid: request.auth.uid }));
  }
);

exports.declareAge = onCall(
  { enforceAppCheck: config.enforceAppCheck, timeoutSeconds: 15, memory: '256MiB', maxInstances: 5 },
  async (request) => {
    if (!request.auth) throw httpsError('unauthenticated', MSG.unauthenticated);
    return safely('declareAge', request.auth.uid, () => declareAgeCore({ db, uid: request.auth.uid, data: request.data, config }));
  }
);

exports.getEntitledContent = onCall(
  { enforceAppCheck: config.enforceAppCheck, timeoutSeconds: 30, memory: '256MiB', maxInstances: 10 },
  async (request) => {
    if (!request.auth) throw httpsError('unauthenticated', MSG.unauthenticated);
    const signUrl = async (path, expires) => {
      const [url] = await getStorage().bucket().file(path).getSignedUrl({ version: 'v4', action: 'read', expires });
      return url;
    };
    return safely('getEntitledContent', request.auth.uid, () => getEntitledContentCore({ db, uid: request.auth.uid, data: request.data, signUrl }));
  }
);

exports.deleteMyAccount = onCall(
  { enforceAppCheck: config.enforceAppCheck, timeoutSeconds: 120, memory: '256MiB', maxInstances: 5 },
  async (request) => {
    if (!request.auth) throw httpsError('unauthenticated', MSG.unauthenticated);
    try {
      const force = !!(request.data && typeof request.data === 'object' && request.data.force === true);
      return await deleteAccountCore({ db, auth: getAuth(), uid: request.auth.uid, force });
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      log.error('deleteMyAccount failed', { uid: logId(request.auth.uid), errType: e && e.name ? String(e.name) : 'Error' });
      throw httpsError('internal', MSG.internal);
    }
  }
);

exports.onUserCreate = functionsV1
  .region(config.region)
  .runWith({ maxInstances: 10 })
  .auth.user()
  .onCreate(async (user) => {
    try {
      await ensureUserAndMember({ db, user });
    } catch (e) {
      log.error('onUserCreate failed', { uid: logId(user.uid), errType: e && e.name ? String(e.name) : 'Error' });
      throw e; // surfaces as an error in Cloud Logging (alert on it); users/members are also created lazily by checkout/webhook
    }
  });
