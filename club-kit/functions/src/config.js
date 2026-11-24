'use strict';
/**
 * Config loader.
 *
 * Source of truth: club-kit/club.config.json. Cloud Functions uploads only the
 * `functions/` directory, so `firebase.json` runs scripts/sync-config.js as a
 * `predeploy` hook which copies the file to functions/club.config.json. This
 * loader reads that bundled copy first, and falls back to ../club.config.json
 * (the source file) for local runs and unit tests. Values are validated and
 * merged over safe defaults, so a missing key never produces an undefined price rule.
 */
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = Object.freeze({
  appId: 'site',
  region: 'europe-west1',
  siteUrl: '',
  returnPath: '/',
  webhookUrl: '',
  currency: 'ILS',
  provider: 'paypal',
  termsVersion: '1',
  enforceAppCheck: false,
  ageGate: { required: true, minAge: 18 },
  paypal: { brandName: '', locale: 'he_IL' },
  payplus: { environment: 'sandbox' },
  points: { perShekel: 1 },
  tiers: [
    { id: 'member', minSpendAgorot: 0, discountPct: 0 },
    { id: 'silver', minSpendAgorot: 20000, discountPct: 5 },
    { id: 'gold', minSpendAgorot: 60000, discountPct: 10 },
  ],
  limits: {
    maxLines: 20,
    maxQtyPerLine: 10,
    maxPendingOrdersPerHour: 5,
    maxOrderTotalAgorot: 1000000,
  },
});

const CANDIDATE_PATHS = [
  path.join(__dirname, '..', 'club.config.json'), // bundled copy (deploy)
  path.join(__dirname, '..', '..', 'club.config.json'), // source (local / tests)
];

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function mergeConfig(user) {
  const u = isPlainObject(user) ? user : {};
  return {
    ...DEFAULTS,
    ...u,
    paypal: { ...DEFAULTS.paypal, ...(isPlainObject(u.paypal) ? u.paypal : {}) },
    ageGate: { ...DEFAULTS.ageGate, ...(isPlainObject(u.ageGate) ? u.ageGate : {}) },
    payplus: { ...DEFAULTS.payplus, ...(isPlainObject(u.payplus) ? u.payplus : {}) },
    points: { ...DEFAULTS.points, ...(isPlainObject(u.points) ? u.points : {}) },
    limits: { ...DEFAULTS.limits, ...(isPlainObject(u.limits) ? u.limits : {}) },
    tiers: Array.isArray(u.tiers) && u.tiers.length ? u.tiers.map((t) => ({ ...t })) : DEFAULTS.tiers.map((t) => ({ ...t })),
  };
}

/** Throws Error with a developer-facing (English) message when the config is unsafe/invalid. */
function validateConfig(cfg) {
  const errs = [];
  const isInt = Number.isInteger;
  if (typeof cfg.appId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,39}$/i.test(cfg.appId)) errs.push('appId must match [a-z0-9_-]{1,40}');
  if (cfg.currency !== 'ILS') errs.push('currency must be "ILS"');
  if (typeof cfg.region !== 'string' || !cfg.region) errs.push('region must be a non-empty string');
  if (!['paypal', 'payplus'].includes(cfg.provider)) errs.push('provider must be "paypal" or "payplus"');
  if (typeof cfg.termsVersion !== 'string' || !/^[A-Za-z0-9._-]{1,32}$/.test(cfg.termsVersion)) errs.push('termsVersion must match [A-Za-z0-9._-]{1,32}');
  if (typeof cfg.ageGate.required !== 'boolean') errs.push('ageGate.required must be boolean');
  if (!isInt(cfg.ageGate.minAge) || cfg.ageGate.minAge < 13 || cfg.ageGate.minAge > 21) errs.push('ageGate.minAge must be an integer 13..21');
  if (typeof cfg.paypal.brandName !== 'string' || cfg.paypal.brandName.length > 127) errs.push('paypal.brandName must be a string up to 127 chars');
  if (typeof cfg.paypal.locale !== 'string' || !/^[a-z]{2}_[A-Z]{2}$/.test(cfg.paypal.locale)) errs.push('paypal.locale must look like he_IL');
  if (typeof cfg.enforceAppCheck !== 'boolean') errs.push('enforceAppCheck must be boolean');
  if (typeof cfg.returnPath !== 'string' || !cfg.returnPath.startsWith('/') || cfg.returnPath.startsWith('//')) errs.push('returnPath must start with a single "/"');
  if (cfg.siteUrl) {
    let u;
    try {
      u = new URL(cfg.siteUrl);
    } catch (_) {
      errs.push('siteUrl is not a valid URL');
    }
    if (u) {
      const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
      if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) errs.push('siteUrl must be https (http only for localhost)');
      if (u.username || u.password) errs.push('siteUrl must not contain credentials');
    }
  }
  if (cfg.webhookUrl && !/^https:\/\//.test(cfg.webhookUrl)) errs.push('webhookUrl must be https when set');
  if (!['sandbox', 'production'].includes(cfg.payplus.environment)) errs.push('payplus.environment must be "sandbox" or "production"');
  if (typeof cfg.points.perShekel !== 'number' || !(cfg.points.perShekel >= 0) || !Number.isFinite(cfg.points.perShekel)) errs.push('points.perShekel must be a number >= 0');

  const t = cfg.tiers;
  if (!Array.isArray(t) || t.length === 0) errs.push('tiers must be a non-empty array');
  else {
    const ids = new Set();
    t.forEach((tier, i) => {
      if (typeof tier.id !== 'string' || !/^[a-z][a-z0-9_]{0,23}$/.test(tier.id)) errs.push(`tiers[${i}].id invalid`);
      if (ids.has(tier.id)) errs.push(`tiers[${i}].id duplicated`);
      ids.add(tier.id);
      if (!isInt(tier.minSpendAgorot) || tier.minSpendAgorot < 0) errs.push(`tiers[${i}].minSpendAgorot must be an integer >= 0`);
      if (typeof tier.discountPct !== 'number' || !(tier.discountPct >= 0 && tier.discountPct <= 90)) errs.push(`tiers[${i}].discountPct must be 0..90`);
      if (i > 0 && isInt(tier.minSpendAgorot) && isInt(t[i - 1].minSpendAgorot) && tier.minSpendAgorot <= t[i - 1].minSpendAgorot) errs.push(`tiers must be sorted by strictly increasing minSpendAgorot (index ${i})`);
    });
    if (t[0] && t[0].minSpendAgorot !== 0) errs.push('first tier must have minSpendAgorot 0');
    // The contract's data model restricts members.tier to member|silver|gold.
    if (!ids.has('member')) errs.push('tiers must include the base tier "member"');
  }
  const l = cfg.limits;
  if (!isInt(l.maxLines) || l.maxLines < 1 || l.maxLines > 20) errs.push('limits.maxLines must be an integer 1..20');
  if (!isInt(l.maxQtyPerLine) || l.maxQtyPerLine < 1 || l.maxQtyPerLine > 10) errs.push('limits.maxQtyPerLine must be an integer 1..10');
  if (!isInt(l.maxPendingOrdersPerHour) || l.maxPendingOrdersPerHour < 1 || l.maxPendingOrdersPerHour > 50) errs.push('limits.maxPendingOrdersPerHour must be an integer 1..50');
  if (!isInt(l.maxOrderTotalAgorot) || l.maxOrderTotalAgorot < 100) errs.push('limits.maxOrderTotalAgorot must be an integer >= 100');
  if (errs.length) throw new Error('Invalid club.config.json: ' + errs.join('; '));
  return cfg;
}

function parseConfig(user) {
  return validateConfig(mergeConfig(user));
}

let cached = null;
function loadConfig() {
  if (cached) return cached;
  let raw = null;
  for (const p of CANDIDATE_PATHS) {
    if (fs.existsSync(p)) {
      raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      break;
    }
  }
  cached = parseConfig(raw); // raw === null -> defaults
  return cached;
}

function resetConfigCache() {
  cached = null;
}

module.exports = { DEFAULTS, mergeConfig, validateConfig, parseConfig, loadConfig, resetConfigCache };
