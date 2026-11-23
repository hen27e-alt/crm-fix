# Club Kit — חוזה טכני

ערכת "מועדון לקוחות" משותפת: התחברות (גוגל / טלפון), מועדון, חנות דיגיטלית, הזמנות, תשלום באמצעות ספק סליקה ישראלי.
המקור כאן (`crm-fix/club-kit/`). כל אתר מקבל עותק (חשבון Firebase נפרד לכל אתר). מוצרים דיגיטליים בלבד.

## עקרונות
1. **שום פרט כרטיס אשראי לא נוגע בקוד שלנו.** התשלום מתבצע בעמוד תשלום מתארח של הספק (redirect). זה משאיר אותנו ברמת PCI SAQ-A.
2. **השרת הוא מקור האמת למחיר.** הלקוח שולח רק `productId` וכמות. השרת קורא את המחיר מ-Firestore.
3. **רק השרת כותב** הזמנות, זכאויות (entitlements) ונתוני מועדון. כללי Firestore אוסרים כתיבת לקוח לאלה.
4. **ה-webhook מאומת וחד-פעמי (idempotent).** אימות חתימה/hash, השוואת סכום ומטבע להזמנה, ועיבוד בטרנזקציה.
5. **מחירים באגורות, כולל מע"מ.** מטבע `ILS`.
6. אין להמציא מוצרים או מחירים. ברירת המחדל: קטלוג דוגמה עם `active:false`, והבעלים מעדכן.
7. הכול בעברית, RTL. טקסטים משפטיים הם תבניות שצריכות בדיקת עורך דין.

## מבנה Firestore
```
products/{productId}
  name: string, description: string,
  priceAgorot: int (>0, כולל מע"מ), currency: "ILS",
  grants: string[]            // מפתחות feature שנפתחים (למשל "premium_readings")
  accessDays: int | null      // null = לתמיד
  active: bool, sort: int, imageUrl?: string

orders/{orderId}              // נוצר ומתעדכן ע"י functions בלבד
  uid, appId, status: "pending"|"paid"|"failed"|"cancelled"|"refunded"
  items: [{productId, name, priceAgorot, qty}]
  subtotalAgorot, discountAgorot, totalAgorot, currency
  memberTier: string, discountPct: number
  provider: "payplus", providerRef?: string, providerTxnUid?: string
  receiptUrl?: string
  createdAt, paidAt?, failedReason?

users/{uid}                   // הלקוח יכול לקרוא ולכתוב רק שדות מותרים
  displayName, email?, phone?, marketingConsent: bool,
  termsAcceptedAt?: timestamp, createdAt

members/{uid}                 // functions בלבד
  points: int, lifetimeSpendAgorot: int, ordersCount: int,
  tier: "member"|"silver"|"gold", updatedAt

users/{uid}/entitlements/{feature}   // functions בלבד
  feature, productId, orderId, grantedAt, expiresAt: timestamp|null
```

### מועדון
- הצטרפות אוטומטית עם ההתחברות הראשונה (`members/{uid}` נוצר ב-trigger `onUserCreate` או בקריאה הראשונה, tier `member`).
- נקודות: 1 נקודה על כל 1 ש"ח ששולם (ניתן לשינוי בקובץ הקונפיג).
- דרגות לפי הוצאה מצטברת (ברירת מחדל): member 0, silver 20000 אגורות (200 ש"ח), gold 60000 אגורות (600 ש"ח).
- הנחה לפי דרגה (ברירת מחדל): member 0%, silver 5%, gold 10%. מחושבת בשרת בלבד.
כל הערכים בקובץ `club.config.json`.

## Cloud Functions (Node 20, firebase-functions v2, אזור `europe-west1`)
| שם | סוג | תיאור |
|---|---|---|
| `createCheckout` | `onCall`, דורש התחברות | קלט `{items:[{productId,qty}], consent:true}`. מאמת מוצרים פעילים, כמות 1–10, עד 20 פריטים, צרכן הסכים לתנאים. מחשב הנחה לפי דרגה. יוצר `orders/{id}` ב-`pending`. קורא לספק ליצור עמוד תשלום. מחזיר `{orderId, paymentUrl}`. הגבלת קצב: לא יותר מ-5 הזמנות `pending` בשעה למשתמש. |
| `paymentWebhook` | `onRequest` (POST) | מאמת חתימה. מוצא הזמנה לפי הפניה שנשלחה לספק. בודק סכום ומטבע. בטרנזקציה: אם כבר `paid` מחזיר 200 בלי לשנות; אחרת מסמן `paid`, כותב entitlements, מעדכן `members` (נקודות, הוצאה, דרגה), שומר `receiptUrl` ו-`providerTxnUid`. כישלון תשלום מסמן `failed`. תמיד 200 על בקשה תקינה כדי למנוע ניסיונות חוזרים אינסופיים, 4xx על חתימה לא תקינה. |
| `deleteMyAccount` | `onCall`, דורש התחברות | מוחק `users/{uid}`, `members/{uid}`, entitlements, ו-Auth. הזמנות לא נמחקות (חובת שמירה לצרכי מס): נשארות עם `uid` מוחלף ב-`"deleted"` ובלי פרטים אישיים. |
| `onUserCreate` | Auth trigger (v1 `auth.user().onCreate` או שקול) | יוצר `users/{uid}` ו-`members/{uid}` |

### מתאם ספק (provider adapter)
קובץ יחיד `functions/src/providers/payplus.js` עם הממשק:
```js
createPaymentPage({ order, customer, successUrl, cancelUrl, webhookUrl }) -> { paymentUrl, providerRef }
verifyWebhook(req) -> { ok: boolean, event: { orderId, status: 'paid'|'failed', amountAgorot, currency, txnUid, receiptUrl } }
```
בקשות ל-API של הספק רק מהשרת. מפתחות כ-secrets (`defineSecret`), לעולם לא בקוד.
החלפת ספק (Cardcom/Tranzila/Meshulam) = מתאם חדש בלבד.

## Frontend: `club/club.js` (ES module, בלי build)
```js
import { initClub } from './club/club.js';
const club = initClub({ firebaseConfig, appId: 'bach', region: 'europe-west1', brand: { accent:'#C2577A', name:'פרחי באך' } });
club.open('account'|'store'|'orders'|'club');   // פותח את המגירה
club.on('auth', user => ...); club.on('entitlements', set => ...);
club.has('premium_readings') // bool, לפי entitlements חיים
club.user                    // המשתמש הנוכחי או null
```
- Firebase JS SDK מודולרי מ-`https://www.gstatic.com/firebasejs/<version מוצמד>/...` (גרסה מוצמדת, בת שבועיים ומעלה).
- התחברות גוגל: `signInWithPopup`, ו-fallback ל-`signInWithRedirect`. טלפון: `RecaptchaVerifier` בלתי נראה + `signInWithPhoneNumber`, נרמול מספרים ישראליים ל-`+972`, שדה קוד בן 6 ספרות, ספירה לאחור לשליחה חוזרת.
- מגירה תחתונה (bottom sheet) עם לשוניות: חשבון, חנות, הזמנות, מועדון. נפתחת מכל מקום באפליקציה. כל הסגנון מוזרק מהמודול (CSS מבודד בקידומת `.kc-`), נושא דרך משתני CSS.
- חנות: קטלוג מ-Firestore (`products` פעילים), עגלה, אישור תנאים (תיבת סימון חובה + קישור), "המשך לתשלום" → `createCheckout` → redirect.
- חזרה מתשלום: `?checkout=success&order=ID` מציג מסך המתנה שמאזין להזמנה עד `paid` (עד 60 שניות), ואז הצלחה/כישלון. `?checkout=cancel` מציג הודעה.
- הזמנות: רשימה חיה, סטטוס, פריטים, סכום, קישור לקבלה.
- מועדון: דרגה, נקודות, התקדמות לדרגה הבאה, הטבות.
- חשבון: פרטי משתמש, הסכמה לדיוור (אופציונלי), התנתקות, מחיקת חשבון (שני שלבי אישור בתוך הדף).
- כל טקסט משתמש עובר escape. נגיש (aria, focus, 44px). `prefers-reduced-motion`.

## אבטחה (חובה)
- `firestore.rules`: ברירת מחדל deny. `products` קריאה לכולם רק אם `active==true`. `orders`, `members`, `entitlements`: קריאה לבעלים בלבד, כתיבה אסורה. `users/{uid}`: קריאה וכתיבה לבעלים בלבד, רק שדות מותרים, בדיקות סוג ואורך.
- ללא `allow read, write: if true`. אין שימוש בשדות שהלקוח שולח כמחיר.
- App Check (reCAPTCHA v3) מתועד כצעד הפעלה אופציונלי ומומלץ (`enforceAppCheck` מופעל בקונפיג).
- כותרות אבטחה ב-`firebase.json` וב-`vercel.json`: `Strict-Transport-Security`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, ו-CSP עם `object-src 'none'; base-uri 'self'`, `connect-src` מוגבל לדומייני Firebase/Google הנדרשים. ה-CSP כולל `'unsafe-inline'` ל-script/style כי האפליקציות הן דף יחיד עם קוד מוטמע. לא להגביל `frame-ancestors` כדי שההטמעה ב-CRM תמשיך לעבוד (מתועד כפשרה).
- הרשאות מנהל באמצעות custom claim `admin`, בסקריפט `scripts/set-admin.js` (רץ מקומית עם service account). שום מפתח ב-repo.
- `.gitignore` חוסם `serviceAccount*.json`, `.env*`, `.runtimeconfig.json`.

## תיעוד נדרש
`SETUP.md` (בעברית): הפעלת Authentication (Google + Phone, הגבלת אזורי SMS לישראל, דומיינים מורשים), Firestore, Blaze, הגדרת secrets (`firebase functions:secrets:set ...`), פריסה (`firebase deploy`), הגדרת ה-webhook אצל הספק, בדיקת תשלום בסביבת sandbox של הספק, יצירת מנהל, הזנת מוצרים, App Check.
`LEGAL-TEMPLATES.md`: תבניות (תנאי שימוש, מדיניות פרטיות, ביטול עסקה ומדיניות החזרים לפי חוק הגנת הצרכן לעסקאות מרחוק, גילוי נאות על מוצרים דיגיטליים). מסומן בבירור "תבנית, לא ייעוץ משפטי".
