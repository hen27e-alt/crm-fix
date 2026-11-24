'use strict';
/**
 * Age gate. The client sends a birth date to the `declareAge` callable; only the SERVER writes
 * users/{uid}.adult (rules forbid clients from writing it). The birth date itself is kept in a
 * server-only doc (ageGates/{uid}, no client access) so that a minor cannot simply retry with another date.
 */
const { httpsError, HttpsError } = require('./errors');
const { logId } = require('./util');
const log = require('./log');

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parse "YYYY-MM-DD" strictly (real calendar date, 1900..today). Returns {y,m,d} or null. */
function parseBirthDate(s, now = new Date()) {
  if (typeof s !== 'string') return null;
  const m = DATE_RE.exec(s);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  if (dt.getTime() > now.getTime()) return null;
  if (now.getUTCFullYear() - y > 120) return null; // implausible (also rejects < 1900 for any realistic clock)
  return { y, m: mo, d };
}

const IL_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' });
/** Current calendar day in Israel as {y,m,d} (the age is evaluated on the Israeli day). */
function israelToday(now = new Date()) {
  const [y, m, d] = IL_DAY.format(now).split('-').map(Number);
  return { y, m, d };
}

/** Whole years between birth date and `now` (calendar day in Israel). */
function ageOn(birth, now = new Date()) {
  const t = israelToday(now);
  let age = t.y - birth.y;
  const beforeBirthday = t.m < birth.m || (t.m === birth.m && t.d < birth.d);
  if (beforeBirthday) age -= 1;
  return age;
}

const MSG = Object.freeze({
  bad: 'תאריך הלידה אינו תקין. הזינו תאריך בפורמט שנה-חודש-יום.',
  minor: 'הרכישה באתר מיועדת לבני 18 ומעלה בלבד. ניתן לבקש מהורה או אפוטרופוס לבצע את הרכישה.',
  needAge: 'לפני הרכישה יש להצהיר על תאריך לידה (הרכישה מיועדת לבני 18 ומעלה).',
});

/**
 * Declaring twice never changes the stored declaration: a different date just returns the existing result
 * (`already:true`); the SAME date is re-evaluated, so a minor who turns 18 becomes an adult.
 * Reusable by other apps (e.g. Game Night): pass `userFields(birth, adult)` to store extra server-written
 * fields on the user doc (such as {birthYear}); pass `userCollection` for another users collection name.
 * @returns {{adult:boolean, already?:true}}  Never returns the birth date.
 */
async function declareAgeCore({ db, uid, data, config, now = new Date(), userFields = null, userCollection = 'users' }) {
  if (!uid) throw httpsError('unauthenticated', 'יש להתחבר כדי להמשיך.');
  const minAge = config.ageGate.minAge;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw httpsError('invalid-argument', MSG.bad, { reason: 'invalid' });
  const birth = parseBirthDate(data.birthDate, now);
  if (!birth) throw httpsError('invalid-argument', MSG.bad, { reason: 'invalid' });
  const key = `${birth.y}-${String(birth.m).padStart(2, '0')}-${String(birth.d).padStart(2, '0')}`;
  const adult = ageOn(birth, now) >= minAge;

  const gateRef = db.collection('ageGates').doc(uid);
  const userRef = db.collection(userCollection).doc(uid);
  const result = await db.runTransaction(async (tx) => {
    const [g, u] = [await tx.get(gateRef), await tx.get(userRef)];
    if (!u.exists) return { error: 'no_profile' };
    if (g.exists && g.data().birthDate !== key) {
      // cannot "retry" with another date to become an adult: return what is already recorded
      return { adult: u.data().adult === true, already: true };
    }
    if (!g.exists) tx.set(gateRef, { birthDate: key, declaredAt: now, minAge });
    // same date again: re-evaluated (a minor who turned 18 becomes an adult)
    tx.update(userRef, { adult, ageDeclaredAt: now, ageGateMinAge: minAge, ...(userFields ? userFields(birth, adult) : {}) });
    return g.exists ? { adult, already: true } : { adult };
  });
  if (result.error === 'no_profile') throw httpsError('failed-precondition', 'הפרופיל טרם נוצר. נסו שוב בעוד רגע.', { reason: 'no_profile' });
  log.info('age declared', { uid: logId(uid), adult: result.adult });
  return result.already ? { adult: result.adult, already: true } : { adult: result.adult };
}

/** Checkout-side gate. Throws HttpsError with details.reason = 'age_required' | 'minor'. */
function assertAdult(userDoc, config) {
  if (!config.ageGate.required) return;
  if (userDoc && userDoc.adult === true) return;
  if (userDoc && userDoc.adult === false) throw new HttpsError('failed-precondition', MSG.minor, { reason: 'not-adult' });
  throw new HttpsError('failed-precondition', MSG.needAge, { reason: 'age-required' });
}

module.exports = { parseBirthDate, ageOn, israelToday, declareAgeCore, assertAdult, MSG };
