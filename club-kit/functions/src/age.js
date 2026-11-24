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
  if (y < 1900) return null;
  if (dt.getTime() > now.getTime()) return null;
  return { y, m: mo, d };
}

/** Whole years between birth date and `now` (UTC calendar days). */
function ageOn(birth, now = new Date()) {
  let age = now.getUTCFullYear() - birth.y;
  const beforeBirthday = now.getUTCMonth() + 1 < birth.m || (now.getUTCMonth() + 1 === birth.m && now.getUTCDate() < birth.d);
  if (beforeBirthday) age -= 1;
  return age;
}

const MSG = Object.freeze({
  bad: 'תאריך הלידה אינו תקין. הזינו תאריך בפורמט שנה-חודש-יום.',
  locked: 'לא ניתן לשנות תאריך לידה שכבר הוצהר. לפניות: פנו אלינו.',
  minor: 'הרכישה באתר מיועדת לבני 18 ומעלה בלבד. ניתן לבקש מהורה או אפוטרופוס לבצע את הרכישה.',
  needAge: 'לפני הרכישה יש להצהיר על תאריך לידה (הרכישה מיועדת לבני 18 ומעלה).',
});

/**
 * @returns {{adult:boolean, declared:true}}  Never returns the birth date.
 */
async function declareAgeCore({ db, uid, data, config, now = new Date() }) {
  if (!uid) throw httpsError('unauthenticated', 'יש להתחבר כדי להמשיך.');
  const minAge = config.ageGate.minAge;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw httpsError('invalid-argument', MSG.bad);
  const birth = parseBirthDate(data.birthDate, now);
  if (!birth) throw httpsError('invalid-argument', MSG.bad);
  const key = `${birth.y}-${String(birth.m).padStart(2, '0')}-${String(birth.d).padStart(2, '0')}`;
  const adult = ageOn(birth, now) >= minAge;

  const gateRef = db.collection('ageGates').doc(uid);
  const userRef = db.collection('users').doc(uid);
  const result = await db.runTransaction(async (tx) => {
    const [g, u] = [await tx.get(gateRef), await tx.get(userRef)];
    if (g.exists) {
      const prev = g.data();
      if (prev.birthDate !== key) return { error: 'locked' }; // cannot "retry" a different date
    }
    if (!u.exists) return { error: 'no_profile' };
    if (!g.exists) tx.set(gateRef, { birthDate: key, declaredAt: now, minAge });
    // `adult` can only turn true (a minor who turns 18 re-declares the SAME date); it never silently flips back
    tx.update(userRef, { adult, ageDeclaredAt: now, ageGateMinAge: minAge });
    return { adult };
  });
  if (result.error === 'locked') throw httpsError('failed-precondition', MSG.locked, { reason: 'age_locked' });
  if (result.error === 'no_profile') throw httpsError('failed-precondition', 'הפרופיל טרם נוצר. נסו שוב בעוד רגע.', { reason: 'no_profile' });
  log.info('age declared', { uid: logId(uid), adult: result.adult });
  return { adult: result.adult, declared: true };
}

/** Checkout-side gate. Throws HttpsError with details.reason = 'age_required' | 'minor'. */
function assertAdult(userDoc, config) {
  if (!config.ageGate.required) return;
  if (userDoc && userDoc.adult === true) return;
  if (userDoc && userDoc.adult === false) throw new HttpsError('failed-precondition', MSG.minor, { reason: 'minor' });
  throw new HttpsError('failed-precondition', MSG.needAge, { reason: 'age_required' });
}

module.exports = { parseBirthDate, ageOn, declareAgeCore, assertAdult, MSG };
