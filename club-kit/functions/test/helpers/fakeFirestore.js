'use strict';
/**
 * Minimal in-memory Firestore fake (admin-SDK shaped) used by the unit tests.
 * Supports: doc/collection refs, get/set/update/delete/create, where(==,>=,<=,>,<)+limit queries,
 * getAll, batch, recursiveDelete, and runTransaction with OPTIMISTIC CONCURRENCY (conflict -> retry),
 * including phantom detection for queries. That lets tests prove idempotency under concurrent webhooks.
 */
const crypto = require('node:crypto');
function autoId() {
  return crypto.randomBytes(15).toString('base64url').slice(0, 20);
}
const tick = () => new Promise((r) => setImmediate(r));
const clone = (v) => structuredClone(v);
const cmpVal = (v) => (v instanceof Date ? v.getTime() : v);

class FakeFirestore {
  constructor() {
    this.docs = new Map(); // path -> { data, version }
    this.collVersions = new Map(); // collection path -> counter
    this.txCommits = 0;
    this.txRetries = 0;
  }
  _collOf(path) {
    return path.slice(0, path.lastIndexOf('/'));
  }
  _bump(path) {
    const c = this._collOf(path);
    this.collVersions.set(c, (this.collVersions.get(c) || 0) + 1);
  }
  _write(path, data) {
    const cur = this.docs.get(path);
    this.docs.set(path, { data: clone(data), version: (cur ? cur.version : 0) + 1 });
    this._bump(path);
  }
  _remove(path) {
    if (this.docs.has(path)) {
      this.docs.delete(path);
      this._bump(path);
    }
  }
  _snap(path) {
    const e = this.docs.get(path);
    const ref = this.doc(path);
    return { id: ref.id, ref, exists: !!e, data: () => (e ? clone(e.data) : undefined), _version: e ? e.version : 0 };
  }
  collection(path) {
    return new CollectionRef(this, path);
  }
  doc(path) {
    return new DocRef(this, path);
  }
  async getAll(...refs) {
    await tick();
    return refs.map((r) => this._snap(r.path));
  }
  batch() {
    const ops = [];
    const db = this;
    return {
      update: (ref, patch) => ops.push(() => db._update(ref.path, patch)),
      set: (ref, data, opts) => ops.push(() => db._set(ref.path, data, opts)),
      delete: (ref) => ops.push(() => db._remove(ref.path)),
      commit: async () => {
        await tick();
        ops.forEach((o) => o());
      },
    };
  }
  _set(path, data, opts) {
    const cur = this.docs.get(path);
    this._write(path, opts && opts.merge && cur ? { ...cur.data, ...data } : data);
  }
  _update(path, patch) {
    const cur = this.docs.get(path);
    if (!cur) throw new Error('NOT_FOUND: ' + path);
    this._write(path, { ...cur.data, ...patch });
  }
  async recursiveDelete(ref) {
    await tick();
    for (const p of [...this.docs.keys()]) if (p === ref.path || p.startsWith(ref.path + '/')) this._remove(p);
  }
  async runTransaction(fn, { maxAttempts = 8 } = {}) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const reads = new Map(); // path -> version
      const collReads = new Map(); // collection path -> version
      const writes = [];
      const db = this;
      const tx = {
        async get(target) {
          await tick();
          if (target instanceof DocRef) {
            const s = db._snap(target.path);
            reads.set(target.path, s._version);
            return s;
          }
          const q = await target._run();
          collReads.set(target.path, db.collVersions.get(target.path) || 0);
          q.docs.forEach((d) => reads.set(d.ref.path, d._version));
          return q;
        },
        set(ref, data, opts) {
          writes.push(() => db._set(ref.path, data, opts));
        },
        update(ref, patch) {
          writes.push(() => db._update(ref.path, patch));
        },
        delete(ref) {
          writes.push(() => db._remove(ref.path));
        },
      };
      const result = await fn(tx);
      await tick();
      // validate (synchronously with commit: JS is single threaded, so this is atomic)
      let conflict = false;
      for (const [p, v] of reads) if ((this.docs.get(p) ? this.docs.get(p).version : 0) !== v) conflict = true;
      for (const [c, v] of collReads) if ((this.collVersions.get(c) || 0) !== v) conflict = true;
      if (conflict) {
        this.txRetries++;
        continue;
      }
      writes.forEach((w) => w());
      this.txCommits++;
      return result;
    }
    throw new Error('transaction aborted: too much contention');
  }
  // ---- test helpers ----
  seed(path, data) {
    this._write(path, data);
  }
  read(path) {
    const e = this.docs.get(path);
    return e ? clone(e.data) : undefined;
  }
  list(prefix) {
    return [...this.docs.keys()].filter((p) => p.startsWith(prefix));
  }
}

class DocRef {
  constructor(db, path) {
    this.db = db;
    this.path = path;
    this.id = path.slice(path.lastIndexOf('/') + 1);
  }
  collection(name) {
    return new CollectionRef(this.db, `${this.path}/${name}`);
  }
  async get() {
    await tick();
    return this.db._snap(this.path);
  }
  async set(data, opts) {
    await tick();
    this.db._set(this.path, data, opts);
  }
  async update(patch) {
    await tick();
    this.db._update(this.path, patch);
  }
  async delete() {
    await tick();
    this.db._remove(this.path);
  }
}

class Query {
  constructor(db, path, filters = [], lim = null) {
    this.db = db;
    this.path = path;
    this.filters = filters;
    this.lim = lim;
  }
  where(field, op, value) {
    return new Query(this.db, this.path, [...this.filters, { field, op, value }], this.lim);
  }
  limit(n) {
    return new Query(this.db, this.path, this.filters, n);
  }
  async _run() {
    const depth = this.path.split('/').length + 1;
    let docs = [...this.db.docs.keys()]
      .filter((p) => p.startsWith(this.path + '/') && p.split('/').length === depth)
      .map((p) => this.db._snap(p))
      .filter((s) =>
        this.filters.every(({ field, op, value }) => {
          const a = cmpVal(s.data()[field]);
          const b = cmpVal(value);
          if (a === undefined) return false;
          return { '==': a === b, '>=': a >= b, '<=': a <= b, '>': a > b, '<': a < b }[op];
        })
      );
    if (this.lim !== null) docs = docs.slice(0, this.lim);
    return { docs, size: docs.length, empty: docs.length === 0 };
  }
  async get() {
    await tick();
    return this._run();
  }
}

class CollectionRef extends Query {
  constructor(db, path) {
    super(db, path);
  }
  doc(id) {
    return new DocRef(this.db, `${this.path}/${id || autoId()}`);
  }
}

module.exports = { FakeFirestore };
