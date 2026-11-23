'use strict';
const crypto = require('node:crypto');

/** Constant-time string equality that is safe for different lengths. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  // HMAC both with a throwaway key so the compared buffers always have equal length
  // and timingSafeEqual never throws or leaks length through an early exit.
  const key = crypto.randomBytes(32);
  const ha = crypto.createHmac('sha256', key).update(a).digest();
  const hb = crypto.createHmac('sha256', key).update(b).digest();
  return crypto.timingSafeEqual(ha, hb) && a.length === b.length;
}

/** Trim, drop control chars, collapse whitespace, cap length. Returns '' for non-strings. */
function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const s = value.replace(/[\u0000-\u001F\u007F‎‏‪-‮]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Normalises an Israeli (or already international) phone number to E.164-ish "+972XXXXXXXXX".
 * Returns '' when it does not look like a phone number. Used only for the payment
 * provider customer record; never for authentication.
 */
function normalizePhone(input) {
  if (typeof input !== 'string') return '';
  let s = input.replace(/[\s\-().]/g, '');
  if (!/^\+?\d{7,15}$/.test(s)) return '';
  if (s.startsWith('+')) return s;
  if (s.startsWith('00')) return '+' + s.slice(2);
  if (s.startsWith('972')) return '+' + s;
  if (s.startsWith('0')) return '+972' + s.slice(1);
  return '';
}

/** Short stable pseudonym for logs (never log the raw uid next to other PII). */
function logId(value) {
  if (typeof value !== 'string' || !value) return '-';
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 10);
}

/** Integer agorot -> shekel number with 2 decimals, for provider APIs that take decimals. */
function agorotToShekel(agorot) {
  return Number((agorot / 100).toFixed(2));
}

/**
 * Provider decimal (number or numeric string, shekels) -> integer agorot, or null when
 * not a clean amount with at most 2 decimals. Avoids float drift by parsing as a string.
 */
function shekelToAgorot(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return null;
    value = String(value);
  }
  if (typeof value !== 'string') return null;
  const m = /^(\d{1,9})(?:\.(\d{1,2})\d*)?$/.exec(value.trim());
  if (!m) return null;
  // Reject amounts with more than 2 significant decimals (e.g. "10.005") rather than silently rounding.
  const frac = value.trim().split('.')[1] || '';
  if (frac.length > 2 && /[1-9]/.test(frac.slice(2))) return null;
  return parseInt(m[1], 10) * 100 + parseInt((m[2] || '').padEnd(2, '0') || '0', 10);
}

module.exports = { safeEqual, cleanText, normalizePhone, logId, agorotToShekel, shekelToAgorot };
