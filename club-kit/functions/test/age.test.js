'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeFirestore } = require('./helpers/fakeFirestore');
const { config } = require('./helpers/fixtures');
const { parseBirthDate, ageOn, israelToday, declareAgeCore, assertAdult } = require('../src/age');

const NOW = new Date('2026-11-24T12:00:00Z');
const codeOf = async (p) => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  return null;
};

test('parseBirthDate: strict real dates only', () => {
  assert.deepEqual(parseBirthDate('2000-02-29', NOW), { y: 2000, m: 2, d: 29 });
  for (const bad of ['2001-02-29', '2000-13-01', '2000-00-10', '2000-1-1', '01-01-2000', '2000/01/01', '1899-12-31', '1900-01-01', '2027-01-01', '', null, undefined, 5, {}, '2000-01-01T00:00:00Z']) {
    assert.equal(parseBirthDate(bad, NOW), null, String(bad));
  }
  assert.ok(parseBirthDate('2026-11-24', NOW)); // today (age 0) is a valid date
});

test('age boundary: turns 18 exactly on the birthday', () => {
  assert.equal(ageOn({ y: 2008, m: 11, d: 24 }, NOW), 18);
  assert.equal(ageOn({ y: 2008, m: 11, d: 25 }, NOW), 17);
  assert.equal(ageOn({ y: 2008, m: 12, d: 1 }, NOW), 17);
  assert.equal(ageOn({ y: 2008, m: 1, d: 1 }, NOW), 18);
  assert.equal(ageOn({ y: 1990, m: 6, d: 15 }, NOW), 36);
});

function setup() {
  const db = new FakeFirestore();
  db.seed('users/u1', { displayName: 'a', marketingConsent: false, createdAt: NOW });
  return db;
}

test('declareAge: adult -> users.adult true (server-written), birth date kept server-only, never returned', async () => {
  const db = setup();
  const r = await declareAgeCore({ db, uid: 'u1', data: { birthDate: '1990-05-05' }, config, now: NOW });
  assert.deepEqual(r, { adult: true });
  const u = db.read('users/u1');
  assert.deepEqual([u.adult, u.ageGateMinAge], [true, 18]);
  assert.equal(db.read('ageGates/u1').birthDate, '1990-05-05');
  assert.ok(!JSON.stringify(r).includes('1990'));
});

test('declareAge: minor -> adult false; a DIFFERENT date afterwards returns the existing result (no retry-until-adult)', async () => {
  const db = setup();
  assert.deepEqual(await declareAgeCore({ db, uid: 'u1', data: { birthDate: '2012-01-01' }, config, now: NOW }), { adult: false });
  assert.equal(db.read('users/u1').adult, false);
  assert.deepEqual(await declareAgeCore({ db, uid: 'u1', data: { birthDate: '1990-01-01' }, config, now: NOW }), { adult: false, already: true });
  assert.equal(db.read('users/u1').adult, false);
  assert.equal(db.read('ageGates/u1').birthDate, '2012-01-01');
});

test('declareAge: reusable hook writes extra server fields (Game Night stores birthYear) and supports another users collection', async () => {
  const db = new FakeFirestore();
  db.seed('gnUsers/u1', { name: 'x' });
  await declareAgeCore({ db, uid: 'u1', data: { birthDate: '1990-05-05' }, config, now: NOW, userCollection: 'gnUsers', userFields: (b) => ({ birthYear: b.y }) });
  assert.deepEqual([db.read('gnUsers/u1').adult, db.read('gnUsers/u1').birthYear], [true, 1990]);
});

test('declareAge: the SAME date becomes adult once the person turns 18', async () => {
  const db = setup();
  await declareAgeCore({ db, uid: 'u1', data: { birthDate: '2008-12-01' }, config, now: NOW });
  assert.equal(db.read('users/u1').adult, false);
  const later = new Date('2026-12-02T00:00:00Z');
  assert.deepEqual(await declareAgeCore({ db, uid: 'u1', data: { birthDate: '2008-12-01' }, config, now: later }), { adult: true, already: true });
  assert.equal(db.read('users/u1').adult, true);
});

test('declareAge: invalid input, unauthenticated, missing profile', async () => {
  const db = setup();
  for (const d of [null, {}, { birthDate: 'x' }, { birthDate: '2030-01-01' }, { birthDate: '1890-01-01' }, { birthDate: '1900-01-01' }, []]) {
    const e = await codeOf(declareAgeCore({ db, uid: 'u1', data: d, config, now: NOW }));
    assert.deepEqual([e.code, e.details.reason], ['invalid-argument', 'invalid'], JSON.stringify(d));
  }
  assert.equal((await codeOf(declareAgeCore({ db, uid: '', data: { birthDate: '1990-01-01' }, config, now: NOW }))).code, 'unauthenticated');
  assert.equal((await codeOf(declareAgeCore({ db, uid: 'nobody', data: { birthDate: '1990-01-01' }, config, now: NOW }))).details.reason, 'no_profile');
  assert.equal(db.read('ageGates/nobody'), undefined);
});

test('assertAdult: only an explicit adult:true passes; distinct reasons; can be switched off by config', () => {
  assert.doesNotThrow(() => assertAdult({ adult: true }, config));
  const e1 = (() => { try { assertAdult({ adult: false }, config); } catch (e) { return e; } })();
  assert.equal(e1.details.reason, 'not-adult');
  assert.match(e1.message, /18/);
  for (const u of [null, {}, { adult: 'true' }, { adult: 1 }]) {
    const e = (() => { try { assertAdult(u, config); } catch (x) { return x; } })();
    assert.equal(e.details.reason, 'age-required');
  }
  assert.doesNotThrow(() => assertAdult({}, { ageGate: { required: false } }));
});

test('age is evaluated on the ISRAELI calendar day (UTC+2 / +3)', () => {
  const lateUtc = new Date('2026-11-24T22:30:00Z'); // already Nov 25 in Israel
  assert.deepEqual(israelToday(lateUtc), { y: 2026, m: 11, d: 25 });
  assert.equal(ageOn({ y: 2008, m: 11, d: 25 }, lateUtc), 18);
  assert.equal(ageOn({ y: 2008, m: 11, d: 25 }, new Date('2026-11-24T21:00:00Z')), 17); // 23:00 Nov 24 in Israel
  const summer = new Date('2026-07-01T21:30:00Z'); // UTC+3: already Jul 2
  assert.deepEqual(israelToday(summer), { y: 2026, m: 7, d: 2 });
});
