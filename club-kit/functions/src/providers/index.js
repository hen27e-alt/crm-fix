'use strict';
/** Provider registry. Add new providers here (see README.md in this folder). */
const REGISTRY = {
  paypal: () => require('./paypal'),
  payplus: () => require('./payplus'),
};

function getProvider(name) {
  const f = REGISTRY[name];
  if (!f) throw new Error(`Unknown payment provider "${name}". Known: ${Object.keys(REGISTRY).join(', ')}`);
  const p = f();
  for (const fn of ['createPaymentPage', 'verifyWebhook']) {
    if (typeof p[fn] !== 'function') throw new Error(`Provider "${name}" is missing ${fn}()`);
  }
  if (!Array.isArray(p.secrets)) throw new Error(`Provider "${name}" must export secrets: []`);
  return p;
}

module.exports = { getProvider, REGISTRY };
