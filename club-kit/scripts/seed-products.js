#!/usr/bin/env node
'use strict';
/**
 * Writes products from a catalog JSON to Firestore (Admin SDK).
 *
 *   node scripts/seed-products.js --key ./serviceAccount.json                 # dry run: validates + prints, writes NOTHING
 *   node scripts/seed-products.js --key ./serviceAccount.json --confirm       # writes (skips products that already exist)
 *   node scripts/seed-products.js --key ./serviceAccount.json --confirm --overwrite   # replaces existing docs
 *   node scripts/seed-products.js --key ... --file ./my-catalog.json --confirm
 *
 * Safety rules:
 *  - Nothing is written without --confirm.
 *  - Existing products are never overwritten without --overwrite (you may have edited them in the console).
 *  - Fields starting with "_" (e.g. "_draft") are notes for humans and are NOT written to Firestore.
 *  - A product that still carries a "_draft" marker is refused if it is active:true: replace the placeholder
 *    name/price/description with real values and delete the "_draft" note first.
 */
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs, banner, initAdmin } = require('./_common');

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function validateProduct(id, p) {
  const errs = [];
  if (!ID_RE.test(id)) errs.push('id must match [A-Za-z0-9_-]{1,64}');
  if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 200) errs.push('name: non-empty string up to 200 chars');
  if (typeof p.description !== 'string' || p.description.length > 2000) errs.push('description: string up to 2000 chars');
  if (!Number.isInteger(p.priceAgorot) || p.priceAgorot <= 0) errs.push('priceAgorot: positive integer (agorot, VAT included)');
  if (p.currency !== 'ILS') errs.push('currency must be "ILS"');
  if (!Array.isArray(p.grants) || !p.grants.every((g) => typeof g === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(g))) errs.push('grants: array of feature keys');
  if (!(p.accessDays === null || (Number.isInteger(p.accessDays) && p.accessDays > 0))) errs.push('accessDays: null (forever) or positive integer');
  if (typeof p.active !== 'boolean') errs.push('active: boolean');
  if (!Number.isInteger(p.sort)) errs.push('sort: integer');
  if (p.imageUrl !== undefined && !(typeof p.imageUrl === 'string' && /^https:\/\//.test(p.imageUrl))) errs.push('imageUrl: https URL when present');
  return errs;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const file = path.resolve(args.file || path.join(__dirname, '..', 'catalog.sample.json'));
  if (args.help) {
    console.log('Usage: node scripts/seed-products.js --key <serviceAccount.json> [--file catalog.json] [--confirm] [--overwrite]');
    return;
  }
  const catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(catalog.products) ? catalog.products : [];
  if (!list.length) throw new Error('catalog has no "products" array');

  const prepared = [];
  let bad = 0;
  const seen = new Set();
  for (const raw of list) {
    const id = raw.id;
    const clean = {};
    for (const [k, v] of Object.entries(raw)) if (k !== 'id' && !k.startsWith('_')) clean[k] = v;
    const errs = validateProduct(String(id), clean);
    if (seen.has(id)) errs.push('duplicate id');
    seen.add(id);
    if (raw._draft && clean.active === true) errs.push('still marked _draft but active:true - set real values and remove "_draft" first');
    if (errs.length) {
      bad++;
      console.error(`INVALID ${id}: ${errs.join('; ')}`);
    }
    prepared.push({ id, data: clean, draft: !!raw._draft });
  }
  if (bad) {
    console.error(`\n${bad} invalid product(s). Nothing written.`);
    process.exit(1);
  }

  console.log(`Catalog: ${file}`);
  for (const p of prepared) console.log(` - ${p.id}: "${p.data.name}" ${(p.data.priceAgorot / 100).toFixed(2)} NIS active=${p.data.active}${p.draft ? '  [DRAFT]' : ''}`);

  if (!args.confirm) {
    console.log('\nDRY RUN: nothing was written. Re-run with --confirm to write these products.');
    return;
  }
  banner(['Writing products with a service-account key (full project access).', 'Keep the key private; delete it when finished.']);
  const { admin, projectId } = initAdmin(args.key);
  const db = admin.firestore();
  let written = 0;
  let skipped = 0;
  for (const p of prepared) {
    const ref = db.collection('products').doc(p.id);
    if (!args.overwrite && (await ref.get()).exists) {
      console.log(`skip (exists): ${p.id}`);
      skipped++;
      continue;
    }
    await ref.set(p.data);
    written++;
  }
  console.log(`Done in project "${projectId}": ${written} written, ${skipped} skipped.`);
  if (prepared.some((p) => p.data.active === false)) console.log('Products with active:false are invisible to customers until you set active:true in the Firebase console.');
}

main().catch((e) => {
  console.error('Failed:', e && e.message ? e.message : e);
  process.exit(1);
});
