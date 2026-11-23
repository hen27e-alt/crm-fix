# club.js: מועדון לקוחות, חנות והזמנות לאתר סטטי

מודול ES יחיד, בלי build. מוסיף לאתר מגירה תחתונה עם ארבע לשוניות (חשבון, חנות, הזמנות, מועדון), התחברות עם Google או טלפון, עגלה, מעבר לתשלום בעמוד מתארח של ספק הסליקה, וחזרה עם מסך המתנה לאישור התשלום.

הקוד הזה הוא רק צד הלקוח. הוא דורש את צד השרת של הערכה (Cloud Functions וחוקי Firestore, ראו `SETUP.md` בשורש הערכה) וחוזה הנתונים ב-`CONTRACT.md`.

## התקנה בשלושה צעדים

1. **העתיקו** את התיקייה `club/` (שלושה קבצים: `club.js`, `club.config.json`, `README.md`) לשורש האתר. אין צורך להעתיק את `demo/`.
2. **הוסיפו** לדף, לפני סגירת `</body>`:

```html
<script type="module">
  import { initClub } from './club/club.js';

  const club = initClub({
    firebaseConfig: { apiKey: '...', authDomain: '...', projectId: '...', appId: '...' },
    appId: 'bach',                   // מזהה האתר, משמש גם למפתח העגלה ב-localStorage
    region: 'europe-west1',          // אזור ה-Functions
    brand: { name: 'פרחי באך', accent: '#C2577A' },
    legalUrls: { terms: 'terms.html', privacy: 'privacy.html', refunds: 'refunds.html' },
    productsFallbackUrl: './catalog.json'   // לא חובה
  });

  club.mountButton(document.querySelector('#account-slot'));  // כפתור "התחברות" / אווטאר
  window.club = club;
</script>
```

3. **דף החזרה מהתשלום.** השרת מחזיר את הלקוח לכתובת `siteUrl + returnPath` עם `?checkout=success&order=ID` (או `cancel`). ה-`initClub` חייב לרוץ בדף הזה. המודול מזהה את הפרמטרים לבד, פותח את המגירה, ומנקה אותם מהכתובת.

## אפשרויות של `initClub`

| אפשרות | תיאור |
|---|---|
| `firebaseConfig` | קונפיג האתר ב-Firebase (חובה, חוץ ממצב הדגמה) |
| `appId` | מזהה האתר |
| `region` | אזור ה-Functions, ברירת מחדל `europe-west1` |
| `brand.name` | כותרת המגירה |
| `brand.accent` | צבע מותג. כל שאר הצבעים נגזרים ממנו ונבדקים לניגודיות |
| `brand.theme` | `'auto'` (ברירת מחדל, לפי המכשיר), `'light'` או `'dark'` |
| `legalUrls` | קישורים לתנאי שימוש, פרטיות והחזרים (`terms`, `privacy`, `refunds`) |
| `productsFallbackUrl` | קובץ JSON (מערך או `{products:[...]}`) שנטען אם Firestore נכשל או ריק. מוצגים רק פריטים עם `active !== false` |
| `configUrl` | כתובת `club.config.json`. ברירת מחדל: לצד `club.js` |
| `checkoutWaitMs` | כמה זמן ממתינים לאישור תשלום (ברירת מחדל 60000) |
| `mock` | מצב הדגמה בלי Firebase, ראו בהמשך |

## API

```js
club.open('account' | 'store' | 'orders' | 'club');  // פותח את המגירה
club.close();
club.user;                       // { uid, displayName, email, phoneNumber, photoURL } או null
club.has('premium_readings');    // האם יש זכאות פעילה (לא פגה)
club.signOut();                  // Promise
club.mountButton(el?);           // מחזיר את הכפתור. בלי el: כפתור צף בפינה. עם el: כפתור רגיל בתוכו
club.ready;                      // Promise שנפתר כשהאתחול הסתיים
```

### אירועים: `const off = club.on(name, fn)`

| אירוע | נתון |
|---|---|
| `auth` | המשתמש או `null`. נקרא מיד בהרשמה אם המצב כבר ידוע |
| `entitlements` | `Set` של מפתחות feature פעילים. נקרא מיד בהרשמה אם המצב כבר ידוע |
| `member` | מסמך `members/{uid}` או `null` |
| `orders` | מערך ההזמנות, החדשות ראשונות |
| `checkout` | `{status: 'redirect' \| 'paid' \| 'failed' \| 'cancelled' \| 'cancel' \| 'timeout', orderId}` |
| `cart` | `{count}` |
| `open`, `close`, `ready` | מצב המגירה |

### נעילת תכונות לפי זכאות

```js
club.on('entitlements', () => {
  document.querySelector('#premium').hidden = !club.has('premium_readings');
});
```

**חשוב:** `club.has` נוח לממשק בלבד. כל מי שפותח את הקונסולה יכול לעקוף אותו. תוכן בתשלום חייב להיות מוגן בצד שרת (חוקי Firestore שבודקים `users/{uid}/entitlements/{feature}`, או Function שמוסרת את התוכן).

## עיצוב

כל ה-CSS מוזרק על ידי המודול עם הקידומת `.kc-`. אין תלות בעיצוב האתר. אפשר לדרוס משתנים:

```css
html .kc-root, html .kc-fab { --kc-radius: 10px; }
:root { --kc-font-family: "Heebo", system-ui, sans-serif; }
```

משתנים עיקריים: `--kc-accent`, `--kc-btn`, `--kc-on-btn`, `--kc-accent-fg`, `--kc-accent-soft`, `--kc-bg`, `--kc-surface`, `--kc-ink`, `--kc-muted`, `--kc-line`, `--kc-radius`, `--kc-font-family`. מצב כהה לפי `prefers-color-scheme` (או `brand.theme`). המודול מכבד `prefers-reduced-motion`.

הנגישות: `role="dialog"` עם `aria-modal`, `tablist` עם חצים, Escape סוגר, מלכודת פוקוס, שאר הדף מושבת (`inert`) כשהמגירה פתוחה, מטרות מגע של 44px לפחות, טבעת פוקוס גלויה.

## `club.config.json`

אותו מבנה כמו `club.config.json` בשורש הערכה (`points.perShekel`, `tiers[]` עם `id`, `minSpendAgorot`, `discountPct`), עם שדות נוספים לתצוגה בלבד: `label` ו-`benefits` (מערך טקסטים לא חובה). **השרת הוא מקור האמת לנקודות ולהנחות.** הקובץ בצד הלקוח משמש רק להצגת התקדמות לדרגה הבאה ולהערכת ההנחה בעגלה. שמרו את שני הקבצים באותם ערכים.

## מצב הדגמה (mock)

`initClub({ mock: true, ... })` מריץ את כל הממשק בלי Firebase: התחברות מדומה (Google, וטלפון עם הקוד `123456`), שלושה מוצרי דוגמה, תשלום מדומה, הזמנות, נקודות ודרגות, ומחיקת חשבון. אפשרויות: `mock: { latencyMs, payDelayMs, user: 'google', products: [...], seedOrders: [...], failCheckout: 'functions/resource-exhausted' }`. ראו `demo/index.html` (להריץ עם `python3 -m http.server` מתוך תיקיית `web/`).

המודול במצב הדגמה לא טוען שום קובץ של Firebase. בפרודקשן אפשר למחוק מ-`club.js` את כל הקטע שבין `3b. ===== MOCK BACKEND` ל-`END MOCK BACKEND`. הנתיב האמיתי לא תלוי בו.

## אבטחה

- **שום פרט כרטיס אשראי לא עובר בקוד.** התשלום מתבצע בעמוד מתארח של הספק. המודול מנתב רק לכתובת `https:` שהשרת החזיר.
- **המחיר מחושב בשרת.** הלקוח שולח `{items:[{productId, qty}], consent:true}` בלבד, וההנחה שמוצגת בעגלה היא הערכה.
- כל טקסט שמגיע ממשתמשים או מ-Firestore עובר escape לפני הכנסה ל-HTML. קישורי קבלה ותמונות מותרים רק ב-`https:`.
- כתיבה ל-Firestore: רק `users/{uid}` (שם, הסכמה לדיוור, אישור תנאים). הזמנות, חברות מועדון וזכאויות נכתבות על ידי השרת בלבד.
- **CSP.** אם יש לאתר Content-Security-Policy, הוסיפו: `script-src https://www.gstatic.com https://apis.google.com https://www.google.com`, `frame-src https://*.firebaseapp.com https://www.google.com`, `connect-src` ל-`*.googleapis.com` ול-`*.cloudfunctions.net`, ו-`style-src 'unsafe-inline'` (המודול מזריק `<style>`), `img-src https:` לתמונות מוצרים.
- **App Check** (reCAPTCHA v3) מומלץ. ראו `SETUP.md`.
- התחברות בטלפון משתמשת ב-reCAPTCHA בלתי נראה של Firebase. תג reCAPTCHA יופיע בפינת הדף, וזה תקין.
- הטקסטים המשפטיים הם תבניות בלבד ודורשים אישור עורך דין.

## גרסת Firebase SDK

נטען מ-`https://www.gstatic.com/firebasejs/10.14.1/`. הגרסה מוצמדת בראש `club.js` (`FIREBASE_SDK_VERSION`). לשדרוג, שנו שם ובדקו התחברות, שליחת SMS ותשלום בסביבת בדיקה.
