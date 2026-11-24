'use strict';
/**
 * Safe structured logging. Rule: never log secrets, tokens, request headers, card data,
 * emails, phone numbers or names. Only ids (orderId, pseudonymised uid) and short codes.
 * Uses logger.write() so entries are plain JSON with a severity (no synthetic stack trace noise).
 *
 * Alerting: entries that need a human carry  alert: 'manual_review'  (see alertReview()).
 * In Cloud Logging:  jsonPayload.alert="manual_review"   -> create a log-based alert on it (SETUP.md section 14).
 */
const { logger } = require('firebase-functions');

const FORBIDDEN_KEYS = /(key|secret|token|password|authorization|hash|email|phone|name|card|cvv|signature)/i;

function scrub(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (FORBIDDEN_KEYS.test(k)) continue;
    if (typeof v === 'string') out[k] = v.length > 200 ? v.slice(0, 200) + '…' : v;
    else if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[k] = v;
    // objects/arrays are intentionally dropped to avoid dumping request bodies
  }
  return out;
}

const emit = (severity) => (message, fields) => logger.write({ severity, message, ...scrub(fields) });

module.exports = {
  info: emit('INFO'),
  warn: emit('WARNING'),
  error: emit('ERROR'),
  /** ERROR-level entry that a log-based alert should page the owner for. */
  alertReview: (message, fields) => logger.write({ severity: 'ERROR', message, ...scrub(fields), alert: 'manual_review' }),
  scrub,
};
