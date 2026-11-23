#!/usr/bin/env node
'use strict';
/**
 * Copies club-kit/club.config.json into functions/club.config.json so that the
 * config is bundled inside the deployed functions source (Cloud Functions only
 * uploads the `functions/` folder; a file outside it would not exist at runtime).
 * Runs automatically as the `predeploy` hook in firebase.json.
 * The copy is git-ignored; the single source of truth is club-kit/club.config.json.
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const src = path.join(root, 'club.config.json');
const dst = path.join(root, 'functions', 'club.config.json');

const raw = fs.readFileSync(src, 'utf8');
JSON.parse(raw); // fail early on invalid JSON
fs.writeFileSync(dst, raw);
console.log('club.config.json -> functions/club.config.json');
