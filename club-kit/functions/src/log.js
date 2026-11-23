'use strict';
/**
 * Safe logging wrapper. Rule: never log secrets, tokens, request headers, card data,
 * emails, phone numbers or names. Only ids (orderId, pseudonymised uid) and short codes.
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

module.exports = {
  info: (msg, f) => logger.info(msg, scrub(f)),
  warn: (msg, f) => logger.warn(msg, scrub(f)),
  error: (msg, f) => logger.error(msg, scrub(f)),
  scrub,
};
