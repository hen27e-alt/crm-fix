'use strict';
/** Shared helpers for the local admin scripts. These scripts run on YOUR computer with a service account. */
const fs = require('node:fs');
const path = require('node:path');

function requireFromFunctions(name) {
  const resolved = require.resolve(name, { paths: [path.join(__dirname, '..', 'functions')] });
  return require(resolved);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

function banner(lines) {
  const bar = '='.repeat(72);
  console.log(['', bar, ...lines, bar, ''].join('\n'));
}

/** Initialise firebase-admin from a local service-account JSON. Never prints key contents. */
function initAdmin(keyPath) {
  if (!keyPath || typeof keyPath !== 'string') {
    console.error('Missing --key <path to service account json>.');
    process.exit(2);
  }
  const abs = path.resolve(keyPath);
  if (!fs.existsSync(abs)) {
    console.error(`Service account file not found: ${abs}`);
    process.exit(2);
  }
  let json;
  try {
    json = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (_) {
    console.error('The service account file is not valid JSON.');
    process.exit(2);
  }
  if (json.type !== 'service_account' || !json.project_id) {
    console.error('That file does not look like a service-account key (type/project_id missing).');
    process.exit(2);
  }
  if (!path.basename(abs).startsWith('serviceAccount') && !/service[-_]?account/i.test(path.basename(abs))) {
    console.warn('WARNING: name your key file serviceAccount*.json so .gitignore keeps it out of git.');
  }
  const admin = requireFromFunctions('firebase-admin');
  admin.initializeApp({ credential: admin.credential.cert(json), projectId: json.project_id });
  return { admin, projectId: json.project_id };
}

module.exports = { parseArgs, banner, initAdmin, requireFromFunctions };
