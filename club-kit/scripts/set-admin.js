#!/usr/bin/env node
'use strict';
/**
 * Grants (or removes) the custom claim `admin: true` for one user.
 *
 *   node scripts/set-admin.js --key ./serviceAccount.json --email owner@example.com
 *   node scripts/set-admin.js --key ./serviceAccount.json --uid ABC123 --remove
 *
 * WARNINGS
 *  - The service-account key is a MASTER KEY to your Firebase project. Download it only on your own
 *    computer, keep it outside the repository (or named serviceAccount*.json, which .gitignore blocks),
 *    never send it by chat/email, and DELETE it from the Google Cloud console when you are done.
 *  - Only give `admin` to people who must administer the shop.
 *  - The user must sign out and in again (or wait up to 1 hour) for the new claim to reach their token.
 */
const { parseArgs, banner, initAdmin } = require('./_common');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.email && !args.uid)) {
    console.log('Usage: node scripts/set-admin.js --key <serviceAccount.json> (--email <email> | --uid <uid>) [--remove]');
    process.exit(args.help ? 0 : 2);
  }
  banner([
    'SECURITY: this script uses a service-account key (full access to the project).',
    'Keep the key file private, never commit it, and delete the key when finished.',
  ]);
  const { admin, projectId } = initAdmin(args.key);
  const auth = admin.auth();
  const user = args.uid ? await auth.getUser(String(args.uid)) : await auth.getUserByEmail(String(args.email));
  const claims = { ...(user.customClaims || {}) };
  if (args.remove) delete claims.admin;
  else claims.admin = true;
  await auth.setCustomUserClaims(user.uid, claims);
  console.log(`${args.remove ? 'Removed' : 'Granted'} admin claim in project "${projectId}" for uid ${user.uid} (${user.email || user.phoneNumber || 'no email/phone'}).`);
  console.log('The user must sign out and sign in again for it to take effect.');
}

main().catch((e) => {
  console.error('Failed:', e && e.message ? e.message : e);
  process.exit(1);
});
