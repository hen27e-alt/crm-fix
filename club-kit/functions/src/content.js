'use strict';
/**
 * Server-side entitlement enforcement for PAID CONTENT.
 *
 * Honest scope: `club.has(feature)` in the browser only opens/hides UI - anything already inside the page's HTML/JS
 * is public (DevTools). Content that must really be paid for has to live OUTSIDE the page and be returned by this
 * callable, which checks the entitlement (including expiry) on the server at request time.
 *
 * Content registry: Firestore `protectedContent/{contentId}` (no client access in firestore.rules; owner writes it
 * from the console or with the Admin SDK):
 *   { feature: 'premium_readings', kind: 'text'|'json'|'file', title: '...',
 *     body: '...'            // kind text
 *     data: { ... }          // kind json
 *     storagePath: 'protected/x.pdf'   // kind file: returned as a short-lived signed URL
 *   }
 */
const { httpsError, MSG } = require('./errors');
const { isActive } = require('./entitlements');
const { logId } = require('./util');
const log = require('./log');

const CONTENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SIGNED_URL_TTL_MS = 10 * 60 * 1000;
const STORAGE_PREFIX = 'protected/';
const MAX_TEXT = 200000;

function toIso(v) {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : v && typeof v.toDate === 'function' ? v.toDate() : null;
  return d ? d.toISOString() : null;
}

async function getEntitledContentCore({ db, uid, data, signUrl, now = new Date() }) {
  if (!uid) throw httpsError('unauthenticated', MSG.unauthenticated);
  const id = data && typeof data === 'object' ? data.contentId : null;
  if (typeof id !== 'string' || !CONTENT_ID_RE.test(id)) throw httpsError('invalid-argument', MSG.badRequest);

  const cSnap = await db.collection('protectedContent').doc(id).get();
  // unknown content and "no access" look the same to the caller
  if (!cSnap.exists) throw httpsError('permission-denied', MSG.noAccess);
  const c = cSnap.data();
  if (typeof c.feature !== 'string' || !c.feature || !/^[A-Za-z0-9_.-]{1,64}$/.test(c.feature)) throw httpsError('permission-denied', MSG.noAccess);

  const eSnap = await db.collection('users').doc(uid).collection('entitlements').doc(c.feature).get();
  const ent = eSnap.exists ? eSnap.data() : null;
  if (!isActive(ent, now)) {
    log.info('content denied', { uid: logId(uid), contentId: id });
    throw httpsError('permission-denied', MSG.noAccess);
  }

  const out = { id, kind: c.kind, title: typeof c.title === 'string' ? c.title.slice(0, 200) : '', expiresAt: toIso(ent.expiresAt) };
  if (c.kind === 'text') {
    if (typeof c.body !== 'string' || c.body.length > MAX_TEXT) throw httpsError('internal', MSG.internal);
    out.body = c.body;
  } else if (c.kind === 'json') {
    if (c.data === null || typeof c.data !== 'object') throw httpsError('internal', MSG.internal);
    out.data = c.data;
  } else if (c.kind === 'file') {
    if (typeof c.storagePath !== 'string' || !c.storagePath.startsWith(STORAGE_PREFIX) || c.storagePath.includes('..') || c.storagePath.length > 300) throw httpsError('internal', MSG.internal);
    if (typeof signUrl !== 'function') throw httpsError('internal', MSG.internal);
    try {
      out.url = await signUrl(c.storagePath, new Date(now.getTime() + SIGNED_URL_TTL_MS));
      out.urlExpiresAt = new Date(now.getTime() + SIGNED_URL_TTL_MS).toISOString();
    } catch (e) {
      log.error('content: signing failed', { contentId: id, errType: e && e.name ? String(e.name) : 'Error' });
      throw httpsError('internal', MSG.internal);
    }
  } else {
    throw httpsError('internal', MSG.internal);
  }
  log.info('content served', { uid: logId(uid), contentId: id });
  return out;
}

module.exports = { getEntitledContentCore, STORAGE_PREFIX, SIGNED_URL_TTL_MS };
