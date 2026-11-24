#!/usr/bin/env node
'use strict';
/**
 * Fails (exit 1) when a legal page still looks like an unfinished template: leftover [placeholders],
 * "[לבדיקת עו"ד]" notes, or the "template / not legal advice" banner. Run it in CI or before every release:
 *
 *   node scripts/check-legal.js web/legal/terms.html web/legal/privacy.html web/legal/refunds.html
 *
 * It cannot tell you the text is legally correct - only that it is not an obviously empty template.
 */
const fs = require('node:fs');

const files = process.argv.slice(2);
if (!files.length) {
  console.error('Usage: node scripts/check-legal.js <file> [file...]');
  process.exit(2);
}
const PATTERNS = [
  [/\[[^\]\n]{1,80}\]/g, 'leftover [placeholder]'],
  [/לבדיקת\s+עו["״']?ד/g, '"for lawyer review" note'],
  [/תבנית[^<\n]{0,40}(לא ייעוץ|לאישור עורך דין)/g, 'template banner'],
  [/כאן יופיעו/g, '"will appear here" stub'],
  [/(YOUR|TODO|FIXME|lorem ipsum)/gi, 'TODO-style marker'],
];
let bad = 0;
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8').replace(/<script[\s\S]*?<\/script>/gi, '');
  for (const [re, label] of PATTERNS) {
    const m = text.match(re);
    if (m) {
      bad++;
      console.error(`${f}: ${label} x${m.length} (e.g. ${JSON.stringify(m[0])})`);
    }
  }
}
if (bad) {
  console.error(`\n${bad} problem(s): these pages are not ready to publish.`);
  process.exit(1);
}
console.log('OK: no template leftovers found (this is NOT a legal review).');
