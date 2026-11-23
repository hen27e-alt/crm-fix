'use strict';
const { HttpsError } = require('firebase-functions/v2/https');

/** User-safe Hebrew messages. Nothing here ever includes internals, ids from other users, or stack traces. */
const MSG = Object.freeze({
  unauthenticated: 'יש להתחבר כדי להמשיך.',
  badRequest: 'הבקשה אינה תקינה. נסו לרענן את הדף.',
  emptyCart: 'הסל ריק.',
  tooManyLines: 'יותר מדי פריטים בסל.',
  badQty: 'כמות לא תקינה. ניתן להזמין בין 1 ל-10 יחידות מכל פריט.',
  consent: 'יש לאשר את תנאי השימוש ומדיניות הביטולים לפני התשלום.',
  unavailable: 'אחד הפריטים בסל אינו זמין יותר. רעננו את החנות ונסו שוב.',
  tooLarge: 'סכום ההזמנה גבוה מהמותר. פצלו את ההזמנה או פנו אלינו.',
  rate: 'בוצעו יותר מדי ניסיונות תשלום. נסו שוב בעוד שעה.',
  provider: 'שירות התשלום אינו זמין כרגע. נסו שוב בעוד רגע.',
  internal: 'אירעה שגיאה. נסו שוב מאוחר יותר.',
  notConfigured: 'החנות עדיין אינה מוגדרת לקבלת תשלומים.',
});

function httpsError(code, message) {
  return new HttpsError(code, message);
}

/** Convert anything thrown into an HttpsError that is safe to send to the client. */
function toClientError(err) {
  if (err instanceof HttpsError) return err;
  return new HttpsError('internal', MSG.internal);
}

module.exports = { MSG, httpsError, toClientError, HttpsError };
