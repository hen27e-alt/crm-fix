# SETUP — הקמת מועדון לקוחות, חנות ותשלומים (Club Kit)

מדריך צעד-אחר-צעד לבעל אתר שאינו מפתח. כל אתר מקבל פרויקט Firebase **נפרד**. אם נתקעתם באמצע, אפשר לעצור ולהמשיך מאוחר יותר: כל שלב עומד בפני עצמו.

> **חשוב:** המדריך מניח ספק סליקה **PayPlus**. את פרטי ה-API של PayPlus לא ניתן היה לאמת מול התיעוד הרשמי בזמן הכתיבה (ראו סעיף 11). **אל תעברו לתשלומים אמיתיים לפני שביצעתם את בדיקות ה-sandbox בסעיף 9 ואת רשימת האימות בסעיף 11.**

---

## 0. מה בונים

- התחברות עם גוגל או טלפון, מועדון לקוחות (נקודות ודרגות), חנות למוצרים **דיגיטליים**, הזמנות ותשלום בעמוד תשלום מתארח של PayPlus.
- **שום פרט כרטיס אשראי לא עובר דרך האתר או השרתים שלכם.** הלקוח משלם בעמוד של PayPlus.
- השרת (Cloud Functions) קובע את המחיר, ומאשר תשלום רק לפי הודעה חתומה מ-PayPlus.

מה תצטרכו: חשבון גוגל, כרטיס אשראי להפעלת תוכנית Blaze של Firebase (יש שכבה חינמית נדיבה; ראו סעיף 1), חשבון PayPlus עם גישת API, מחשב עם Node.js.

---

## 1. פרויקט Firebase ותוכנית Blaze

1. היכנסו ל-<https://console.firebase.google.com> → **Add project** → תנו שם (למשל `my-site-club`). אפשר להשבית Google Analytics.
2. **שדרוג ל-Blaze** (תשלום לפי שימוש): בתחתית התפריט הימני → **Upgrade**. נדרש כדי להפעיל Cloud Functions.
3. **הגדירו תקציב והתראה מיד** (מגן מפני חיובים מפתיעים): Google Cloud Console → **Billing** → **Budgets & alerts** → Create budget, סכום חודשי נמוך (למשל 20$), התראות ב-50% / 90% / 100%.

---

## 2. Authentication (התחברות)

בקונסולת Firebase: **Build → Authentication → Get started**.

### 2.1 ספקי התחברות (Sign-in method)
1. **Google** → Enable → בחרו אימייל תמיכה → Save.
2. **Phone** → Enable → Save.

### 2.2 הגבלת SMS לישראל בלבד (חשוב: מונע חיובי SMS והונאות)
1. **Authentication → Settings → SMS region policy**.
2. בחרו **Allow** → סמנו **רק Israel (IL)** → Save.
3. ב-Phone sign-in אפשר להוסיף "Phone numbers for testing" (למשל `+972501234567` עם קוד `123456`) לבדיקות בלי לשלוח SMS. **מחקו אותם לפני עלייה לאוויר.**

### 2.3 דומיינים מורשים (Authorized domains)
**Authentication → Settings → Authorized domains → Add domain**, והוסיפו **כל** דומיין שהאתר רץ בו:
- דומיין האתר (`my-site.co.il`, וגם `www.my-site.co.il` אם רלוונטי),
- דומיין ה-Vercel (`my-site.vercel.app`),
- `localhost` (קיים כברירת מחדל, לפיתוח).

בלי זה, ההתחברות תיכשל עם `auth/unauthorized-domain`.

---

## 3. Firestore

**Build → Firestore Database → Create database** → מצב **Production** → מיקום: `eur3 (europe)` או `europe-west1` (קרוב לפונקציות; **לא ניתן לשנות אחר כך**).

את הכללים והאינדקסים תפרסו בסעיף 7. אל תערכו כללים ידנית בקונסולה.

---

## 4. כלים במחשב

1. התקינו Node.js (גרסה 20 או 22) מ-<https://nodejs.org>.
2. התקינו את Firebase CLI והתחברו:
   ```bash
   npm install -g firebase-tools
   firebase login
   ```
3. הכינו קובץ פרויקט (מתוך תיקיית `club-kit`):
   ```bash
   cp .firebaserc.example .firebaserc
   ```
   ערכו את `.firebaserc` והחליפו את `YOUR-FIREBASE-PROJECT-ID` במזהה הפרויקט (מופיע בהגדרות הפרויקט בקונסולה).
4. התקנת תלויות הפונקציות:
   ```bash
   cd functions && npm install && cd ..
   ```

> **הערה על גרסת Node:** הערכה מוגדרת ל-Node 20 (`engines.node: "20"` ו-`runtime: nodejs20`). אם בזמן הפריסה Firebase מודיע ש-Node 20 אינו נתמך יותר, שנו ל-`22` בשני המקומות (`functions/package.json` ו-`firebase.json`) והריצו שוב את הבדיקות (`npm test`).

---

## 5. הגדרות האתר: `club.config.json`

פתחו את `club.config.json` ועדכנו **לפחות**:

| שדה | משמעות | דוגמה |
|---|---|---|
| `appId` | מזהה האתר (אותיות לועזיות/ספרות/מקף). נשמר בכל הזמנה | `"bach"` |
| `siteUrl` | הכתובת הראשית של האתר, **https**. אליה חוזר הלקוח אחרי התשלום | `"https://my-site.co.il"` |
| `returnPath` | הדף שאליו חוזרים (חייב להכיל את המועדון) | `"/"` |
| `webhookUrl` | כתובת ה-webhook (ימולא בסעיף 7.3). ריק = ברירת מחדל | `""` |
| `payplus.environment` | `"sandbox"` לבדיקות, `"production"` לאמיתי | `"sandbox"` |
| `enforceAppCheck` | הפעלת App Check (סעיף 10). להשאיר `false` עד שמפעילים בפרונט | `false` |
| `tiers`, `points`, `limits` | דרגות, הנחות, נקודות, מגבלות. ברירת המחדל לפי החוזה | ראו README |

ברירות המחדל: דרגות member (0 ₪, 0%) / silver (200 ₪, 5%) / gold (600 ₪, 10%); נקודה אחת על כל ש"ח ששולם; עד 5 הזמנות ממתינות בשעה למשתמש.

---

## 6. Secrets (מפתחות PayPlus)

המפתחות **לא נכתבים בקוד ולא בקבצים**. הם נשמרים ב-Secret Manager של גוגל.

1. ב-PayPlus (לוח הבקרה, **sandbox** קודם): אספו **API Key**, **Secret Key**, ו-**Payment Page UID** (מזהה עמוד התשלום שיצרתם בלוח הבקרה: Payment Pages → צרו עמוד, והעתיקו את ה-UID שלו).
2. הריצו (מתוך `club-kit`) והדביקו את הערך כשהמערכת מבקשת:
   ```bash
   firebase functions:secrets:set PAYPLUS_API_KEY
   firebase functions:secrets:set PAYPLUS_SECRET_KEY
   firebase functions:secrets:set PAYPLUS_PAGE_UID
   ```
3. כשעוברים ל-production: הגדירו מחדש את שלושת הסודות עם ערכי production, שנו `payplus.environment` ל-`production`, ופרסו שוב.

> לעולם אל תשלחו מפתחות בצ'אט/במייל ואל תעלו אותם ל-git. אם מפתח דלף: סובבו אותו מיד בלוח הבקרה של PayPlus והגדירו מחדש.

---

## 7. פריסה

### 7.1 פריסה ראשונה
```bash
firebase deploy --only functions,firestore:rules,firestore:indexes
```
- הפריסה מעתיקה אוטומטית את `club.config.json` לתוך `functions/` (הוק `predeploy`).
- בפעם הראשונה Firebase עשוי לבקש להפעיל APIs (Cloud Build, Artifact Registry, Secret Manager). אשרו.
- בסוף תוצג רשימת פונקציות: `createCheckout`, `paymentWebhook`, `deleteMyAccount`, `onUserCreate`.

### 7.2 אינדקסים
האינדקסים נוצרים בפריסה ולוקחים כמה דקות. עד שהם **Enabled** (Firestore → Indexes) שאילתות מסוימות ייכשלו. זה תקין.

### 7.3 כתובת ה-webhook
1. בפלט הפריסה חפשו: `Function URL (paymentWebhook(europe-west1)): https://paymentwebhook-xxxx-ew.a.run.app`. העתיקו אותה.
2. הדביקו אותה ב-`club.config.json` בשדה `webhookUrl`, ופרסו שוב: `firebase deploy --only functions`.
3. בדקו שהכתובת חיה: פתיחה בדפדפן צריכה להחזיר שגיאת **405** (נכון: היא מקבלת POST בלבד).

---

## 8. הגדרה אצל PayPlus

1. **כתובת callback:** הערכה שולחת את `refURL_callback` (= כתובת ה-webhook) **בכל בקשת תשלום**. מומלץ להגדיר אותה גם בלוח הבקרה של PayPlus (בהגדרות עמוד התשלום / IPN) לאותה כתובת, כגיבוי.
2. **כתובות חזרה:** נשלחות בכל בקשה: `…/?checkout=success&order=ID` ו-`…/?checkout=cancel&order=ID`.
3. **קבלות/חשבוניות:** בדקו בלוח הבקרה שהנפקת חשבונית-קבלה אוטומטית מופעלת, ושהחשבונית מציגה את הפירוט הרצוי (ראו סעיף 11, V5).
4. ודאו שעמוד התשלום מוגדר ל**חיוב רגיל** (לא "בדיקת כרטיס" / שמירת טוקן בלבד).
5. פרטי העסק, תנאים ומדיניות ביטולים צריכים להופיע גם בעמוד התשלום (ראו `LEGAL-TEMPLATES.md`).

---

## 9. בדיקות ב-sandbox (חובה לפני עלייה לאוויר)

תנאי: `payplus.environment` = `"sandbox"`, סודות sandbox מוגדרים, מוצר בדיקה פעיל (ראו סעיף 12), הפריסה בוצעה. השתמשו בכרטיסי הבדיקה שמופיעים בתיעוד ה-sandbox של PayPlus.

| # | פעולה | תוצאה מצופה |
|---|---|---|
| 1 | התחברו באתר עם גוגל | נוצרים `users/{uid}` ו-`members/{uid}` (tier `member`, 0 נקודות) ב-Firestore |
| 2 | התחברו עם טלפון ישראלי (מספר בדיקה) | כנ"ל. מספר זר נחסם בגלל מדיניות האזורים |
| 3 | הוסיפו מוצר לסל, סמנו הסכמה, "המשך לתשלום" | מוחזר `orderId` + מעבר לעמוד PayPlus; ב-Firestore נוצרת הזמנה `pending` עם **המחיר מהשרת** |
| 4 | בלי לסמן הסכמה | הכפתור חסום, ואם נשלחת בקשה ידנית: שגיאת "יש לאשר את תנאי השימוש…" |
| 5 | שלמו בכרטיס בדיקה תקין | חזרה לאתר, מסך המתנה, ואז הצלחה. ההזמנה `paid`, יש `paidAt`, `providerTxnUid`; נוצר `users/{uid}/entitlements/{feature}`; `members` עודכן (נקודות = שקלים ששולמו) |
| 6 | חזרו על אותו webhook (אם לוח PayPlus מאפשר שליחה חוזרת, או שליחה חוזרת של אותה בקשה חתומה) | קוד 200, **אין שינוי**: הנקודות והזכאות לא מוכפלות |
| 7 | שלמו בכרטיס בדיקה שנדחה | ההזמנה `failed` עם `failedReason`; אין זכאות |
| 8 | סגרו את עמוד התשלום / לחצו ביטול | חזרה עם `?checkout=cancel`; ההזמנה נשארת `pending` |
| 9 | הזמינו 6 פעמים ברצף בלי לשלם | הניסיון השישי נדחה: "בוצעו יותר מדי ניסיונות תשלום" |
| 10 | עברו 200 ₪ מצטברים (בהזמנות בדיקה) | tier עולה ל-`silver`, ההזמנה הבאה כוללת 5% הנחה |
| 11 | שלחו POST ל-webhook ידנית עם חתימה שגויה (`curl -X POST <url> -H 'hash: x' -d '{}'`) | תשובה **401**, ובלוגים `webhook: rejected` |
| 12 | רשמו מוצר לא פעיל / מזהה שגוי בקריאה ידנית | שגיאה "אחד הפריטים בסל אינו זמין יותר" |
| 13 | באזור החשבון: מחיקת חשבון | נמחקים `users`, `members`, `entitlements` ומשתמש ה-Auth; ההזמנות נשארות עם `uid: "deleted"` |
| 14 | החזר: בצעו החזר בלוח PayPlus | אם PayPlus שולח callback: ההזמנה `refunded` והזכאות נשללת. אם לא: הריצו `scripts/refund-order.js` (סעיף 13) |

**אם בדיקה 5 נכשלת** (ההזמנה נשארת `pending` אחרי תשלום מוצלח): פתחו Logs של `paymentWebhook`.
- `webhook: rejected reason=bad_signature` → הנחות V7 (אימות חתימה) שגויות: ראו סעיף 11.
- `result=rejected reason=amount_or_currency_mismatch` → שדה הסכום/מטבע בהודעה שונה מהצפוי (V8).
- `result=ignored reason=unknown_order` → שדה ה-`more_info` לא חוזר בהודעה (V8/V12).
- אין לוגים בכלל → כתובת ה-webhook לא נשלחה/נחסמה (V4).

---

## 10. App Check (אופציונלי, מומלץ)

מגן על ה-API מפני בקשות ממקורות שאינם האתר שלכם.
1. Firebase Console → **App Check** → Apps → בחרו את אפליקציית ה-Web → **reCAPTCHA v3** → צרו מפתחות ב-<https://www.google.com/recaptcha/admin> (reCAPTCHA v3, הוסיפו את דומייני האתר) → הדביקו את Secret Key בקונסולה.
2. באתר: אתחול App Check עם ה-**site key** (`initializeAppCheck` עם `ReCaptchaV3Provider`) **לפני** שימוש ב-Auth/Firestore/Functions. ודאו שהפרונט שלכם תומך (אם לא, אל תפעילו אכיפה).
3. עקבו ב-App Check → **Metrics** שהבקשות "Verified".
4. רק אחרי שרוב הבקשות מאומתות: ב-`club.config.json` הגדירו `"enforceAppCheck": true` ופרסו `firebase deploy --only functions`. לאכיפה ב-Firestore: App Check → Firestore → **Enforce**.
5. אם הכל נשבר אחרי ההפעלה: החזירו `false` ופרסו שוב.

---

## 11. בדיקת הנחות מול PayPlus (VERIFY-WITH-DOCS)

מתאם PayPlus נכתב בלי גישה לתיעוד הרשמי (`docs.payplus.co.il` לא היה נגיש). **מה שאומת באופן עקיף בלבד** (תקציר חיפוש, לא קריאת התיעוד עצמו): הכותרות `api-key` ו-`secret-key`; השדה `payment_page_uid`; `refURL_callback` ו-`refURL_success`; `more_info` חוזר בהודעות; הודעת callback כוללת כותרת `hash` ו-`user-agent`, וחתימת HMAC-SHA256 על גוף ה-JSON במפתח ה-secret.
**כל השאר הוא הנחה מזיכרון**. כל הנחה מבודדת בקבוע בראש `functions/src/providers/payplus.js`. עברו על הטבלה מול התיעוד ומול ה-sandbox שלכם וסמנו V:

| # | הנחה | איפה בקוד | איך מאמתים |
|---|---|---|---|
| V1 | כתובות בסיס: sandbox `https://restapidev.payplus.co.il/api/v1.0`, production `https://restapi.payplus.co.il/api/v1.0` | `API_BASE` | תיעוד / שגיאת רשת בבדיקה 3 |
| V2 | נתיב `POST /PaymentPages/generateLink` | `GENERATE_LINK_PATH` | תיעוד; תשובת 404 = שגוי |
| V3 | כותרות אימות `api-key`, `secret-key` | `HEADER_API_KEY`, `HEADER_SECRET_KEY` | תשובת 401/403 בבדיקה 3 |
| V4 | שמות שדות הבקשה: `payment_page_uid`, `charge_method` (1 = חיוב), `amount` (בשקלים עשרוניים!), `currency_code`, `language_code`, `refURL_success/failure/cancel/callback`, `send_failure_callback`, `more_info`, `customer{customer_name,email,phone}`, `items[{name,quantity,price}]`, `sendEmailApproval`, `create_token` | גוף הבקשה ב-`createPaymentPage` | תיעוד; שדה לא מוכר עלול להתעלם/להיכשל |
| V5 | סכום הפריטים חייב להיות שווה ל-`amount`. כשיש הנחת מועדון נשלחת שורה מאוחדת אחת ("הזמנה ID") | `buildItems` | בדקו מה מופיע בחשבונית שנוצרת |
| V6 | מבנה התשובה: `results.status === "success"`, `data.payment_page_link`, `data.page_request_uid` | `createPaymentPage` | תיעוד / תשובה בבדיקה 3 |
| V7 | חתימת ה-callback: כותרת `hash`, HMAC-SHA256, מפתח = Secret Key, מעל גוף הבקשה הגולמי. הקידוד (base64 או hex) לא ידוע ולכן **שניהם** מתקבלים; נבדק גם `JSON.stringify` של הגוף | `signatureMatches` | בדיקה 5; בדיקה 11 |
| V8 | שדות ההודעה: `transaction.uid`, `transaction.payment_page_request_uid`, `transaction.more_info`, `transaction.status_code` (`"000"` = אושר), `transaction.amount` (שקלים), `transaction.currency`, ונתיב קישור חשבונית/קבלה (**ניחוש**) | `parseEvent`, `RECEIPT_URL_PATHS`, `SUCCESS_STATUS_CODE` | הדפיסו הודעת sandbox אמיתית (בלוח PayPlus/ב-Cloud Run request logs) והשוו |
| V9 | כישלון תשלום מייצר callback (`send_failure_callback`) | גוף הבקשה | בדיקה 7 |
| V10 | האם ואיך PayPlus שולח הודעת החזר (`REFUND_MARKERS` = ניחוש) | `REFUND_MARKERS` | בדיקה 14; אם אין: `scripts/refund-order.js` |
| V11 | דומיין עמוד התשלום מסתיים ב-`payplus.co.il` (הגנה: קישור אחר נדחה) | `PAYMENT_URL_HOST_SUFFIX` | בדיקה 3 |
| V12 | מגבלות אורך/תווים של `more_info` (אנו שולחים 20 תווים) | `createPaymentPage` | תיעוד |

**דרך מהירה לבדוק V7/V8:** בצעו תשלום sandbox. אם ההזמנה לא עברה ל-`paid`, הלוגים יגידו למה (סעיף 9). אפשר לבקש ממפתח לתקן קבוע אחד בלבד בקובץ ולהריץ `npm test`.

---

## 12. מנהל ומוצרים

### 12.1 יצירת מנהל
1. Firebase Console → Project settings → **Service accounts** → **Generate new private key** → שמרו כ-`serviceAccount.json` **בתוך `club-kit` בלבד** (`.gitignore` חוסם אותו).
2. התחברו פעם אחת לאתר עם החשבון שיהיה מנהל.
3. הריצו:
   ```bash
   node scripts/set-admin.js --key ./serviceAccount.json --email owner@example.com
   ```
4. התנתקו והתחברו שוב. (הרשאת `admin` היא כרגע בסיס לפיתוח עתידי של ממשק ניהול; ניהול מוצרים נעשה בקונסולה או בסקריפט.)
5. **מחקו את קובץ המפתח** כשסיימתם, וגם את המפתח בקונסולת Google Cloud (IAM → Service accounts → Keys). מפתח כזה הוא "מפתח ראשי" לפרויקט.

### 12.2 הזנת מוצרים
קובץ `catalog.sample.json` מכיל 3 מוצרי **טיוטה** (`active: false`, שמות ומחירים סימליים). **אל תפעילו אותם.**
1. העתיקו ל-`catalog.json` וערכו: שם, תיאור, `priceAgorot` (באגורות, **כולל מע"מ**: 5000 = 50 ₪), `grants` (מפתחות הרשאה, למשל `premium_readings`), `accessDays` (מספר ימים או `null` = לתמיד), `sort`. מחקו את שדה `_draft`.
2. בדיקה (לא כותב כלום):
   ```bash
   node scripts/seed-products.js --file catalog.json --key ./serviceAccount.json
   ```
3. כתיבה: הוסיפו `--confirm`. מוצרים קיימים לא נדרסים (אלא עם `--overwrite`).
4. הפעילו מוצר: בקונסולה → Firestore → `products/<id>` → `active` = `true`.

---

## 13. החזרים

1. בצעו את ההחזר הכספי בלוח הבקרה של PayPlus.
2. אם PayPlus שולח הודעת החזר, המערכת מעדכנת לבד (מלא: סטטוס `refunded`, שלילת זכאות, ביטול נקודות/הוצאה; חלקי: מסומן `needsManualReview` ללא שינוי זכאות).
3. אחרת: `node scripts/refund-order.js --key ./serviceAccount.json --order ORDER_ID --confirm` (בלי `--confirm` זו הרצת בדיקה).
4. החזר לא הופך הזמנה חזרה ל-`paid` גם אם תגיע הודעה ישנה.

---

## 14. ניטור והתראות

1. **שגיאות פונקציות:** Google Cloud Console → **Logging → Log-based alerts** → שאילתה: `severity>=ERROR AND resource.type="cloud_run_revision"` → התראה במייל.
2. **webhook חשוד:** התראה על הודעות `webhook: rejected` (חתימה שגויה) בכמות חריגה, וגם על `reason=amount_or_currency_mismatch` (**כל מופע** שווה בדיקה).
3. **הזמנות לבדיקה ידנית:** ב-Firestore חפשו הזמנות עם `webhookAnomaly` או `needsManualReview: true`.
4. **תשלומים שנתקעו:** הזמנות `pending` ותיקות שלקוח טוען ששילם: בדקו בלוח PayPlus ואז בלוגי ה-webhook.
5. **תקציב:** התראת Billing מסעיף 1. מומלץ גם **Usage** של Authentication (SMS).
6. **גיבוי:** Firestore → Disaster recovery → הפעילו גיבויים יומיים (נתוני הזמנות נדרשים לצרכי מס).

---

## 15. רשימת בדיקה לפני עלייה לאוויר

- [ ] כל בדיקות סעיף 9 עברו ב-sandbox, כולל כישלון, כפילות webhook וחתימה שגויה.
- [ ] סעיף 11 עבר במלואו מול התיעוד (V1–V12), נרשם מה נבדק.
- [ ] סודות production הוגדרו, `payplus.environment` = `production`, פריסה מחדש, ותשלום אמיתי קטן אחד נבדק (והוחזר).
- [ ] מספרי בדיקה של טלפון נמחקו; מדיניות SMS = ישראל בלבד.
- [ ] דומיינים מורשים נכונים (אתר + Vercel).
- [ ] מוצרים אמיתיים עם מחירים כוללי מע"מ, והדוגמאות לא פעילות/נמחקו.
- [ ] טקסטים משפטיים הוכנו ואושרו ע"י עורך דין (`LEGAL-TEMPLATES.md`), הקישורים מפורסמים באתר ובתיבת ההסכמה.
- [ ] רישום מאגר מידע / התייעצות בנושא פרטיות לפי הצורך (עורך דין).
- [ ] הנפקת חשבוניות/קבלות מסודרת מול רואה החשבון.
- [ ] התראות וניטור (סעיף 14) ותקציב פעילים.
- [ ] קובץ `serviceAccount.json` נמחק מהמחשב והמפתח בוטל.
- [ ] כללי Firestore נפרסו (בדקו בקונסולה שאין "Test mode") וה-CSP/כותרות האבטחה באתר מוגדרים (`firebase.json`/`vercel.json` של האתר).

---

## 16. תקלות נפוצות

| סימפטום | סיבה אפשרית |
|---|---|
| `auth/unauthorized-domain` | הדומיין לא הוסף ב-Authorized domains (2.3) |
| SMS לא מגיע | מדיניות אזורים, מספר לא ישראלי, או מכסת SMS |
| "החנות עדיין אינה מוגדרת" | `siteUrl` ריק ב-`club.config.json` או סודות חסרים |
| שגיאת "שירות התשלום אינו זמין" | סודות שגויים, `environment` שגוי, או V1–V4 (ראו לוגים של `createCheckout`) |
| הקטלוג ריק | אין מוצרים עם `active: true`, או אינדקס עדיין נבנה |
| שאילתה נכשלת עם "requires an index" | המתינו לסיום בניית האינדקסים או פרסו שוב `firestore:indexes` |
| כל הקריאות נכשלות אחרי `enforceAppCheck: true` | האתר לא מאתחל App Check (סעיף 10) |
| פריסה נכשלת על runtime | ראו הערה על Node בסעיף 4 |
