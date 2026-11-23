#!/usr/bin/env node
'use strict';
/**
 * Records a FULL refund of an order in Firestore: status -> refunded, entitlements of that order revoked,
 * points / lifetime spend reversed, tier recomputed. Uses exactly the same code as the payment webhook.
 *
 * IMPORTANT: this does NOT move money. First refund the customer in the PayPlus dashboard,
 * then run this so the shop state matches (needed when PayPlus does not send a refund callback).
 *
 *   node scripts/refund-order.js --key ./serviceAccount.json --order ORDER_ID            # dry run
 *   node scripts/refund-order.js --key ./serviceAccount.json --order ORDER_ID --confirm
 */
const { parseArgs, banner, initAdmin, requireFromFunctions } = require('./_common');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.order) {
    console.log('Usage: node scripts/refund-order.js --key <serviceAccount.json> --order <orderId> [--confirm]');
    process.exit(args.help ? 0 : 2);
  }
  const { admin, projectId } = initAdmin(args.key);
  const db = admin.firestore();
  const snap = await db.collection('orders').doc(String(args.order)).get();
  if (!snap.exists) throw new Error('order not found');
  const o = snap.data();
  console.log(`Project ${projectId}, order ${snap.id}: status=${o.status}, total=${(o.totalAgorot / 100).toFixed(2)} ${o.currency}, items=${(o.items || []).length}`);
  if (o.status !== 'paid') {
    console.log('Only PAID orders can be refunded. Nothing to do.');
    return;
  }
  if (!args.confirm) {
    console.log('DRY RUN. Re-run with --confirm after you refunded the customer in PayPlus.');
    return;
  }
  banner(['Reminder: this only updates Firestore. Money must be refunded in PayPlus.']);
  const { processPaymentEvent } = requireFromFunctions('./src/webhook.js');
  const { loadConfig } = requireFromFunctions('./src/config.js');
  const out = await processPaymentEvent({
    db,
    config: loadConfig(),
    event: { orderId: snap.id, status: 'refunded', amountAgorot: o.totalAgorot, currency: o.currency, txnUid: o.providerTxnUid || '', receiptUrl: '', providerRef: '', reason: 'manual' },
  });
  console.log('Result:', JSON.stringify(out));
}

main().catch((e) => {
  console.error('Failed:', e && e.message ? e.message : e);
  process.exit(1);
});
