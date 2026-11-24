# SETUP — הקמת מועדון לקוחות, חנות ותשלומים (Club Kit)

מדריך צעד-אחר-צעד לבעל אתר שאינו מפתח. כל אתר מקבל פרויקט Firebase **נפרד**. אפשר לעצור ולהמשיך בכל שלב.

> **חשוב — מה אומת ומה לא.** ספק התשלום המוגדר כברירת מחדל הוא **PayPal** (Orders API v2). **לא ניתן היה לאמת אף פרט של ה-API של PayPal מול התיעוד הרשמי או מול sandbox אמיתי** (אין גישה לרשת/לחשבון בזמן הכתיבה). הקוד כתוב לפי זיכרון של ה-API, וכל הנחה מבודדת בקבוע בראש `functions/src/providers/paypal.js` ורשומה בסעיף 11 (רשימת VERIFY-WITH-DOCS). **אין לעבור לתשלומים אמיתיים לפני שכל בדיקות ה-sandbox בסעיף 9 עברו ושעברתם על סעיף 11.** בדיקות היחידה מוכיחות שהקוד עושה מה שההנחות אומרות, מול fetch מדומה, ולא מוכיחות שה-API אכן מתנהג כך.

---

## 0. מה בונים

- התחברות עם גוגל או טלפון, מועדון לקוחות (נקודות ודרגות), חנות למוצרים **דיגיטליים** (כולל חבילות מטבעות), הזמנות, ותשלום ב-**PayPal**.
- **שום פרט כרטיס אשראי לא עובר דרך האתר או השרתים שלכם.** הלקוח מאשר את התשלום באתר של PayPal והשרת מבצע את החיוב (capture).
- השרת קובע את המחיר, מאשר תשלום רק לפי תשובת PayPal ישירה או webhook מאומת, ובודק סכום, מטבע וזיהוי הזמנה.
- **שער גיל:** רכישה מותרת רק למי שהצהיר על תאריך לידה ונמצא בן 18 ומעלה (הצהרה עצמית; אינה אימות זהות).
- מה שאפשר ומה שאי אפשר לאכוף: ראו סעיף 12.

מה תצטרכו: חשבון גוגל; כרטיס אשראי להפעלת תוכנית Blaze; **חשבון PayPal עסקי** (Business) שמאפשר קבלת שקלים (ILS); מחשב עם Node.js.

---

## 1. פרויקט Firebase ותוכנית Blaze

1. <https://console.firebase.google.com> → **Add project** → שם (למשל `my-site-club`).
2. **שדרוג ל-Blaze** (תשלום לפי שימוש; נדרש ל-Cloud Functions).
3. **תקציב והתראה מיד:** Google Cloud Console → **Billing → Budgets & alerts** → תקציב חודשי נמוך (למשל 20$) עם התראות 50% / 90% / 100%.

---

## 2. Authentication

**Build → Authentication → Get started**.

1. **Sign-in method:** Google → Enable. Phone → Enable.
2. **הגבלת SMS לישראל בלבד:** Settings → **SMS region policy** → Allow → רק Israel (IL). מספרי בדיקה (Phone numbers for testing) מותרים בפיתוח בלבד: **מחקו אותם לפני עלייה לאוויר.**
3. **דומיינים מורשים:** Settings → **Authorized domains** → הוסיפו את דומיין האתר (עם ובלי `www`), את דומיין ה-Vercel, ו-`localhost`. בלי זה: `auth/unauthorized-domain`.

---

## 3. Firestore (ו-Storage אופציונלי)

- **Build → Firestore Database → Create database** → Production → מיקום `eur3` או `europe-west1` (לא ניתן לשנות אחר כך).
- **Storage** נדרש רק אם תגישו קבצים בתשלום (סעיף 12.3): Build → Storage → Get started.

---

## 4. כלים במחשב

1. Node.js **22** מ-<https://nodejs.org> (הערכה מוגדרת ל-Node 22: `engines.node: "22"`, `runtime: nodejs22`).
2. `npm install -g firebase-tools` ואז `firebase login`.
3. מתוך `club-kit`: `cp .firebaserc.example .firebaserc` ועדכנו את מזהה הפרויקט.
4. `cd functions && npm install && npm test && cd ..` (כל הבדיקות צריכות לעבור לפני פריסה).

> אם `npm audit` מדווח על פגיעויות: אלו כמעט תמיד חבילות פיתוח/בדיקות (`firebase` ב-devDependencies), לא חבילות שנפרסות. **אל תריצו `npm audit fix --force`** (הוא מציע שדרוג/הורדת גרסה מטעים). לפני פריסה: `npm audit --omit=dev`.

---

## 5. הגדרות האתר: `club.config.json`

| שדה | משמעות | דוגמה |
|---|---|---|
| `appId` | מזהה האתר (אותיות לועזיות/ספרות/מקף), נשמר בכל הזמנה | `"game-night"` |
| `siteUrl` | הכתובת הראשית של האתר, **https**. אליה חוזר הלקוח מ-PayPal | `"https://my-site.co.il"` |
| `returnPath` | הדף שאליו חוזרים (מצורפים `?checkout=success\|cancel&order=ID`) | `"/"` |
| `webhookUrl` | כתובת ה-webhook (ימולא בסעיף 7.3) | `""` |
| `provider` | `"paypal"` (ברירת מחדל) או `"payplus"` (אופציונלי, סעיף 18) | `"paypal"` |
| `paypal.brandName`, `paypal.locale` | שם העסק שמוצג ב-PayPal; שפה | `"הדוגמה"`, `"he_IL"` |
| `termsVersion` | גרסת התנאים שנשמרת בכל הזמנה. **העלו אותה בכל שינוי בתנאים** | `"1"` |
| `ageGate.required`, `ageGate.minAge` | שער גיל (ברירת מחדל: חובה, 18) | `true`, `18` |
| `enforceAppCheck` | סעיף 10 | `false` |
| `tiers`, `points`, `limits` | דרגות, הנחות, נקודות, מגבלות | ברירת מחדל לפי החוזה |

סודות PayPal **לא** נכתבים כאן (סעיף 6).

---

## 6. PayPal: חשבון, אפליקציה, סודות

### 6.1 חשבון ו-sandbox
1. חשבון PayPal **עסקי**. ודאו בהגדרות החשבון ש**שקל (ILS)** מופעל לקבלת תשלומים.
2. <https://developer.paypal.com> → **Apps & Credentials** → מצב **Sandbox** → Create App (סוג Merchant) → העתיקו **Client ID** ו-**Secret**.
3. באותו מסך, ב-**Sandbox accounts**: ישנם חשבון "Business" וחשבון "Personal" לבדיקות (עם סיסמה שמוצגת בלוח). הקונה בבדיקות נכנס עם ה-Personal.

### 6.2 Webhook (אחרי הפריסה הראשונה: סעיף 8)
בדף האפליקציה → **Webhooks → Add Webhook**: כתובת ה-`paymentWebhook` (סעיף 7.3) והאירועים:
`CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.CAPTURE.REVERSED`. שמרו והעתיקו את **Webhook ID**.

### 6.3 סודות
מתוך `club-kit` (הדביקו את הערך כשמתבקש):
```bash
firebase functions:secrets:set PAYPAL_CLIENT_ID
firebase functions:secrets:set PAYPAL_CLIENT_SECRET
firebase functions:secrets:set PAYPAL_WEBHOOK_ID
firebase functions:secrets:set PAYPAL_ENV        # הערך: sandbox   (לייב: live)
```
`PAYPAL_ENV` חייב להיות בדיוק `sandbox` או `live`. כל ערך אחר גורם לכישלון סגור (הקוד מסרב לפעול).

למעבר ללייב: צרו אפליקציית **Live** בלוח PayPal (Client ID/Secret/Webhook חדשים), הגדירו מחדש את ארבעת הסודות עם ערכי הלייב ו-`live`, ופרסו שוב `firebase deploy --only functions`.

> לעולם אל תשלחו מפתחות בצ'אט/במייל ואל תעלו אותם ל-git. מפתח שדלף: סובבו אותו מיד בלוח PayPal והגדירו מחדש.

---

## 7. פריסה

### 7.1 פריסה
```bash
firebase deploy --only functions,firestore:rules,firestore:indexes
```
(ההוק `predeploy` מעתיק את `club.config.json` לתוך `functions/`.) בפעם הראשונה Firebase יבקש להפעיל APIs (Cloud Build, Artifact Registry, Secret Manager). אשרו.
פונקציות: `createCheckout`, `capturePayPalOrder`, `paymentWebhook`, `declareAge`, `getEntitledContent`, `deleteMyAccount`, `onUserCreate`.
כללי Storage (רק אם משתמשים בקבצים בתשלום): `firebase deploy --only storage`.

### 7.2 אינדקסים
נוצרים בפריסה ולוקחים כמה דקות (Firestore → Indexes → Enabled). עד אז שאילתות מסוימות ייכשלו, וזה תקין.

### 7.3 כתובת ה-webhook
1. בפלט הפריסה: `Function URL (paymentWebhook(europe-west1)): https://paymentwebhook-xxxx-ew.a.run.app`.
2. הדביקו ב-`club.config.json` בשדה `webhookUrl` ופרסו שוב `firebase deploy --only functions`.
3. פתיחה בדפדפן צריכה להחזיר **405** (נכון: POST בלבד).

---

## 8. רישום ה-webhook ב-PayPal
בצעו את סעיף 6.2 עם הכתובת מסעיף 7.3, שמרו את `PAYPAL_WEBHOOK_ID` (סעיף 6.3) ופרסו שוב. ה-webhook הוא **רשת ביטחון**: התשלום נקלט בדרך כלל כבר כשהלקוח חוזר לאתר (הפונקציה `capturePayPalOrder`), והאירוע `CHECKOUT.ORDER.APPROVED` גורם לשרת לבצע את החיוב גם אם הלקוח סגר את הדפדפן באמצע.

---

## 9. בדיקות ב-sandbox (חובה לפני עלייה לאוויר)

תנאי: `PAYPAL_ENV=sandbox`, סודות sandbox, מוצר בדיקה פעיל, פריסה בוצעה. הקונה: חשבון Personal מה-sandbox.

| # | פעולה | תוצאה מצופה |
|---|---|---|
| 1 | התחברו עם גוגל | נוצרים `users/{uid}` ו-`members/{uid}` (tier `member`, `coins: 0`) |
| 2 | נסו לרכוש לפני הצהרת גיל | שגיאה בעברית "לפני הרכישה יש להצהיר על תאריך לידה"; `details.reason` = `age-required`; לא נוצרה הזמנה |
| 3 | הצהירו תאריך לידה של קטין | `users.adult=false`; נסיון רכישה: "מיועדת לבני 18 ומעלה", `reason` = `not-adult`. הצהרה שנייה עם תאריך אחר מחזירה את הקיים (`already:true`) ולא משנה |
| 4 | הצהירו תאריך של בגיר (חשבון אחר) | `users.adult=true` נכתב על ידי השרת. ב-Firestore ניתן לראות שהלקוח לא מצליח לכתוב `adult` בעצמו (חוקים) |
| 5 | הוסיפו מוצר, סמנו הסכמה, "המשך לתשלום" | מוחזר `orderId` ו-`paymentUrl` של PayPal (דומיין `*.paypal.com`); ב-Firestore הזמנה `pending` עם `providerRef` (מזהה הזמנת PayPal), `termsVersion`, והמחיר מהשרת |
| 6 | אשרו בחשבון ה-Personal ב-PayPal | חזרה ל-`siteUrl` עם `?checkout=success&order=…&token=…&PayerID=…` |
| 7 | הקריאה `capturePayPalOrder({orderId})` (מהפרונט, או ידנית) | `{status:'paid'}`; ההזמנה `paid` עם `providerTxnUid` (מזהה ה-capture); נוצרה זכאות / נקודות / מטבעות; קריאה שנייה מחזירה `paid` בלי חיוב נוסף |
| 8 | לאחר מכן, בלוג `paymentWebhook`: `PAYMENT.CAPTURE.COMPLETED` | תשובה 200, ללא שינוי (`noop already_paid`), ללא כפל נקודות/מטבעות |
| 9 | אשרו ב-PayPal אך **סגרו** את הדפדפן לפני החזרה לאתר | תוך דקה: האירוע `CHECKOUT.ORDER.APPROVED` מבצע capture בשרת וההזמנה הופכת `paid` |
| 10 | בטלו ב-PayPal ("Cancel and return") | חזרה עם `?checkout=cancel`; ההזמנה נשארת `pending` |
| 11 | כרטיס/חשבון שנדחה (חשבון בדיקה עם מקור תשלום שנכשל, לפי תיעוד ה-sandbox) | capture מחזיר `failed` או `pending`; לא נוצרת זכאות |
| 12 | שלחו POST ל-webhook עם כותרות/חתימה מזויפות | **401**, ובלוג `webhook: rejected` |
| 13 | חבילת מטבעות: קנו `coins-250` | `members.coins` עולה ב-250 **פעם אחת בלבד**, שורה ב-`members/{uid}/coinLedger/{orderId}`, בלי הנחת דרגה |
| 14 | החזר מלא מלוח PayPal (Sandbox business → Transaction → Refund) | האירוע `PAYMENT.CAPTURE.REFUNDED`: ההזמנה `refunded`, תרומת ההזמנה הוסרה מהזכאות (זכאויות של הזמנות אחרות נשארות), מטבעות נוכו (ואם כבר נוצלו: `needsManualReview`) |
| 15 | הזמינו 6 פעמים בלי לשלם | ניסיון שישי נדחה: "בוצעו יותר מדי ניסיונות תשלום" |
| 16 | עברו 200 ₪ מצטברים | tier `silver`, הזמנה הבאה כוללת 5% הנחה (לא על חבילות מטבעות) |
| 17 | מחיקת חשבון מיד אחרי פתיחת תשלום | שגיאה "יש הזמנה שנפתחה לאחרונה" (`reason: pending_order`); עם `force:true` נמחק, וגם אז PayPal לא יחויב (ההזמנה מבוטלת ואינה ניתנת ל-capture) |
| 18 | תוכן בתשלום: קריאה ל-`getEntitledContent({contentId})` עם ובלי זכאות | עם זכאות: התוכן; בלי / פגה: `permission-denied` זהה לתוכן שאינו קיים |

**אם הזמנה נשארת `pending` אחרי תשלום מוצלח:** פתחו Logs של `capturePayPalOrder` ו-`paymentWebhook`:
- `capture: provider capture failed … issue …` → הנחות P2/P7/P8 (סעיף 11).
- `webhook: rejected reason=bad_signature` → P10/P11; `verify_unavailable` או `not_configured` → בדקו `PAYPAL_WEBHOOK_ID`, `PAYPAL_ENV` והסודות.
- `result=rejected reason=amount_or_currency_mismatch` → P4/P7 (פורמט סכום או מטבע).

---

## 10. App Check (אופציונלי, מומלץ)

1. Firebase Console → **App Check** → Apps → אפליקציית ה-Web → **reCAPTCHA v3** → מפתחות ב-<https://www.google.com/recaptcha/admin> (הוסיפו את הדומיינים) → Secret Key בקונסולה.
2. באתר: אתחול App Check (`initializeAppCheck` + `ReCaptchaV3Provider`) **לפני** Auth/Firestore/Functions. ודאו שהפרונט תומך; אם לא, אל תפעילו אכיפה.
3. App Check → **Metrics**: ודאו שרוב הבקשות "Verified".
4. אז `"enforceAppCheck": true` ב-`club.config.json` ופריסה (`--only functions`). אכיפה גם ב-Firestore: App Check → Firestore → Enforce.
5. אם נשבר: החזירו `false` ופרסו.

---

## 11. בדיקת הנחות מול PayPal (VERIFY-WITH-DOCS)

**כל** הפרטים הבאים הם הנחות מזיכרון (לא אומתו). כל אחד מבודד בקבוע בראש `functions/src/providers/paypal.js`. עברו עליהם מול <https://developer.paypal.com/docs/api/orders/v2/> ומול ה-sandbox שלכם, וסמנו V.

| # | הנחה | איפה בקוד | איך מאמתים |
|---|---|---|---|
| P1 | כתובות בסיס: sandbox `https://api-m.sandbox.paypal.com`, live `https://api-m.paypal.com` | `API_BASE` | תיעוד; שגיאת רשת בבדיקה 5 |
| P2 | OAuth: `POST /v1/oauth2/token`, אימות Basic (Client ID:Secret), גוף `grant_type=client_credentials`, תשובה `{access_token, expires_in}` | `OAUTH_PATH`, `accessToken` | שגיאת `oauth failed` בבדיקה 5 |
| P3 | יצירת הזמנה: `POST /v2/checkout/orders`, גוף: `intent:'CAPTURE'`, `purchase_units[{reference_id, custom_id, amount{currency_code,value,breakdown{item_total,discount}}, items[{name,quantity,unit_amount,category}]}]`, `payment_source.paypal.experience_context{return_url,cancel_url,brand_name,locale,shipping_preference,user_action}` (חלופה ישנה: `application_context`; מתג `USE_EXPERIENCE_CONTEXT`) | `ORDERS_PATH`, `createPaymentPage` | בדיקה 5 |
| P4 | סכומים הם **מחרוזות** עם 2 ספרות; ILS מופעל בחשבון; `category:"DIGITAL_GOODS"`; `breakdown.discount` מתקבל; `value = item_total − discount` | `money`, `ITEM_CATEGORY` | שגיאת 422 בבדיקה 5 (למשל `CURRENCY_NOT_SUPPORTED`) |
| P5 | קישור האישור: ב-`links[]` עם `rel` שווה `payer-action` (חדש) או `approve` (ישן), בדומיין `*.paypal.com` | `APPROVE_LINK_RELS` | בדיקה 5 |
| P6 | כותרת אידמפוטנטיות `PayPal-Request-Id` ביצירה וב-capture | `HEADER_REQUEST_ID` | תיעוד |
| P7 | Capture: `POST /v2/checkout/orders/{id}/capture`, גוף `{}`, כותרת `Prefer: return=representation`; תשובה `status:'COMPLETED'` ו-`purchase_units[0].payments.captures[0]{id,status,amount}`; `custom_id` חוזר | `CAPTURE_SUFFIX`, `interpretOrder` | בדיקה 7 |
| P8 | כבר נקלט → 422 עם `ORDER_ALREADY_CAPTURED` (אז מבוצע GET); עדיין לא אושר → `ORDER_NOT_APPROVED` | `ISSUE_*` | קריאה כפולה בבדיקה 7; קריאה לפני אישור |
| P9 | סטטוסי capture: `COMPLETED` (שולם), `PENDING` (בבדיקת PayPal: **לא** מעניקים), `DECLINED`/`FAILED` | `CAPTURE_*` | בדיקה 11 |
| P10 | כותרות ה-webhook: `paypal-auth-algo`, `paypal-cert-url`, `paypal-transmission-id`, `paypal-transmission-sig`, `paypal-transmission-time` | `WEBHOOK_HEADERS` | בדיקה 8 |
| P11 | `POST /v1/notifications/verify-webhook-signature` עם `{auth_algo, cert_url, transmission_id, transmission_sig, transmission_time, webhook_id, webhook_event}`; תשובה `verification_status:'SUCCESS'`; הגוף המנותח (לא הגולמי) מתקבל כ-`webhook_event` | `VERIFY_WEBHOOK_PATH`, `verifyWebhook` | בדיקה 8; אם תמיד FAILURE: ייתכן שנדרש הגוף הגולמי |
| P12 | מבנה האירועים: `PAYMENT.CAPTURE.COMPLETED/DENIED/REVERSED` (resource = capture עם `custom_id`, `supplementary_data.related_ids.order_id`), `PAYMENT.CAPTURE.REFUNDED` (resource = refund; ה-capture המקורי בקישור `rel:"up"`; `custom_id` ייתכן ואינו קיים), `CHECKOUT.ORDER.APPROVED` (resource = order) | `EVT`, `parseEvent` | בדיקות 8, 9, 14: הדפיסו אירוע sandbox אמיתי והשוו |
| P13 | `id` של האירוע (`WH-…`) ייחודי לאירוע, משמש לזיהוי שליחה חוזרת | `parseEvent` | תיעוד |
| P14 | עמלות PayPal על תשלומים קטנים (3.90 ₪) ותנאי החשבון שלכם (בעיה עסקית, לא טכנית) | — | בדקו את תעריף ה-micropayments בחשבון שלכם לפני שקובעים מחירי חבילות |

**ביקורת סיכון:** אם P11 שגוי, כל webhook יידחה (401) ו**נשארים רק** תשלומים שנקלטים דרך `capturePayPalOrder` כשהלקוח חוזר לאתר; החזרים ו-`APPROVED` לא יעבדו. אם P7/P12 שגויים, הסכום/מטבע לא יתאימו וההזמנה תסומן `needsManualReview` במקום להעניק (כישלון בטוח).

---

## 12. מנהל, מוצרים, חבילות מטבעות, תוכן בתשלום

### 12.1 מנהל
1. Firebase Console → Project settings → **Service accounts** → Generate new private key → שמרו כ-`serviceAccount.json` בתוך `club-kit` בלבד (ה-`.gitignore` חוסם).
2. התחברו פעם אחת לאתר עם החשבון שיהיה מנהל, ואז:
   ```bash
   node scripts/set-admin.js --key ./serviceAccount.json --email owner@example.com
   ```
3. התנתקו והתחברו שוב. **הערה:** ה-claim `admin` כרגע אינו נותן שום הרשאה ב-Firestore או בפונקציות (הוא בסיס לממשק ניהול עתידי); מוצרים מנוהלים בקונסולה או בסקריפט. אם לא תשתמשו בו, אל תריצו את הסקריפט.
4. **מחקו את קובץ המפתח** בסיום, וגם את המפתח בקונסולת Google Cloud (IAM → Service accounts → Keys).

### 12.2 מוצרים וחבילות מטבעות
- `catalog.sample.json`: 3 מוצרי **טיוטה** סימליים (`active:false`). אל תפעילו.
- `catalog.coin-packs.json`: חבילות המטבעות כפי שנקבעו (כולל מע"מ): **250 מטבעות ב-3.90 ₪, 850 ב-9.90 ₪, 5500 ב-19.90 ₪**. הן נטענות `active:false`. שדות: `coins` (מטבעות ליחידה), `noDiscount:true` (הנחת דרגה לא חלה).
- ערכו עותק (`catalog.json`), אז:
  ```bash
  node scripts/seed-products.js --file catalog.coin-packs.json --key ./serviceAccount.json            # בדיקה בלבד
  node scripts/seed-products.js --file catalog.coin-packs.json --key ./serviceAccount.json --confirm  # כתיבה
  ```
  מוצרים קיימים לא נדרסים (אלא עם `--overwrite`). הפעלה: Firestore → `products/<id>` → `active: true`, **רק אחרי** בדיקות sandbox 13 ו-14.
- המטבעות נכתבים רק על ידי השרת, לשדה `members/{uid}.coins` (קריאה לבעלים בלבד; הלקוח לא יכול לכתוב). יומן: `members/{uid}/coinLedger/{orderId}`.
- **החזר של חבילת מטבעות:** המטבעות מנוכים מהיתרה. אם הלקוח כבר הוציא אותם, היתרה לא יורדת מתחת ל-0, והחוב נרשם (`coinShortfall`, `needsManualReview`) להחלטתכם.

### 12.3 תוכן בתשלום שנאכף בשרת
כדי שתוכן באמת יהיה "בתשלום", הוא **לא** יכול להיות בקוד/ב-HTML של האתר. הכניסו אותו כך:
1. מסמך ב-Firestore `protectedContent/<contentId>` (גישה ללקוחות חסומה לגמרי): `{feature:'premium_readings', kind:'text', title:'…', body:'…'}`; או `kind:'json'` + `data:{…}`; או `kind:'file'` + `storagePath:'protected/guide.pdf'` (העלו את הקובץ ל-Storage תחת `protected/`; כללי Storage חוסמים הכול, והשרת מנפיק קישור חתום ל-10 דקות).
2. הפרונט קורא `getEntitledContent({contentId})`. השרת בודק את הזכאות **ואת התפוגה** בזמן הבקשה.
3. לקבצים: לחשבון השירות של הפונקציות נדרשת ההרשאה `Service Account Token Creator` על עצמו (חתימת URL). אם הקישור נכשל: IAM → חשבון השירות של Cloud Functions → הוסיפו את התפקיד.

**מה הפרונט (`club.has()`) יכול רק "לרמוז":** הסתרה/הצגה של כפתורים ומסכים. כל תוכן שכבר נמצא בקובץ הסטטי של האתר (HTML/JS/תמונות) חשוף לכל מי שפותח DevTools. זה "פתיחת ממשק", לא הגנת תוכן.

---

## 13. החזרים
1. בצעו את ההחזר הכספי בלוח PayPal (Transaction → Refund).
2. PayPal שולח `PAYMENT.CAPTURE.REFUNDED` והמערכת מעדכנת לבד. החזר חלקי רק מסומן `needsManualReview` (ללא שינוי זכאות). `PAYMENT.CAPTURE.REVERSED` (חיוב חוזר/chargeback) מטופל כהחזר מלא.
3. אם אירוע לא הגיע: `node scripts/refund-order.js --key ./serviceAccount.json --order ORDER_ID --confirm` (בלי `--confirm`: בדיקה בלבד). **הסקריפט לא מזיז כסף.**
4. הזמנה שהוחזרה נשארת `refunded` גם אם יגיע אירוע ישן.

---

## 14. ניטור והתראות

1. **התראה על כל מקרה שדורש בדיקה ידנית (חובה):** Google Cloud Console → **Logging → Log-based alerts** → שאילתה:
   ```
   jsonPayload.alert="manual_review"
   ```
   → התראה במייל. היא מופעלת על: חיוב כפול (`duplicate_charge`), תשלום אחרי החזר, אי-התאמת סכום/מטבע, תשלום שהגיע לחשבון שנמחק, החזר חלקי, מטבעות שכבר נוצלו, שימוש חוזר במזהה עסקה.
2. **שגיאות כלליות:** `severity>=ERROR AND resource.type="cloud_run_revision"`.
3. **webhook חשוד:** נפח חריג של `webhook: rejected`.
4. **הזמנות לבדיקה:** ב-Firestore חפשו `needsManualReview == true` או `webhookAnomaly != null`. **כל הזמנה כזו = כסף של לקוח שדורש החלטה**; בדקו אותה בלוח PayPal.
5. **תקציב:** התראת Billing מסעיף 1; ובדקו Usage של Authentication (SMS).
6. **גיבוי:** Firestore → Disaster recovery → גיבוי יומי (נתוני הזמנות נדרשים לצרכי מס).

---

## 15. כותרות אבטחה ו-CSP לאתר

קבצי דוגמה: `hosting-examples/firebase.hosting.example.json` ו-`hosting-examples/vercel.example.json`. מעתיקים את הבלוק ל-`firebase.json` / `vercel.json` של **האתר** (לא של הערכה), ומחליפים `PROJECT_ID`.
- כוללים: HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy: same-origin-allow-popups` (נדרש להתחברות גוגל בחלון קופץ), ו-CSP עם `object-src 'none'; base-uri 'self'`, `connect-src` לדומייני Firebase/Google הנדרשים, ו-`form-action` ל-PayPal.
- ה-CSP כולל `'unsafe-inline'` ל-script/style כי האפליקציות הן דף יחיד עם קוד מוטמע (פשרה מתועדת).
- **`frame-ancestors`:** כתבו שם במפורש את המקור היחיד שמורשה להטמיע (למשל ה-CRM) ולא יותר. דפי התחברות ותשלום חוסמים הטמעה ב-iframe בכל מקרה: אפליקציה עם רכישות צריכה להיפתח **בלשונית חדשה** ולא בתוך נגן מוטמע (`embed:false` ב-CRM).
- **בדקו בדפדפן** (קונסולה ללא הפרות CSP) לפני פריסה: התחברות גוגל, טלפון עם reCAPTCHA, מעבר ל-PayPal וחזרה.

---

## 16. רשימת בדיקה לפני עלייה לאוויר

- [ ] כל בדיקות סעיף 9 עברו ב-sandbox; סעיף 11 נבדק מול התיעוד (P1–P14), נרשם מה נבדק.
- [ ] אפליקציית Live ב-PayPal, ארבעת הסודות עם ערכי הלייב ו-`PAYPAL_ENV=live`, פריסה מחדש, ורכישה אמיתית קטנה אחת **ושחזור** (החזר) שעברו נכון.
- [ ] התראת `jsonPayload.alert="manual_review"` פעילה ונבדקה (גרמו לאירוע ובדקו שהגיע מייל).
- [ ] מספרי טלפון לבדיקה נמחקו; SMS לישראל בלבד; דומיינים מורשים נכונים.
- [ ] מוצרים אמיתיים עם מחירים כוללי מע"מ; הדוגמאות לא פעילות; חבילות המטבעות הופעלו רק אחרי הבדיקות.
- [ ] טקסטים משפטיים סופיים, **שאושרו ע"י עורך דין**, פורסמו, ו-`node scripts/check-legal.js <קבצי הדפים>` עובר (אין שאריות תבנית); `termsVersion` מעודכן. תיבת ההסכמה כוללת: הסכמה לתנאים, הצהרה שהמוצר דיגיטלי והגישה נפתחת מיד, והצהרת גיל.
- [ ] הוצאת חשבוניות/קבלות מסודרת מול רואה החשבון (PayPal אינו מנפיק חשבונית מס ישראלית בשבילכם).
- [ ] כללי Firestore נפרסו (בלי "test mode"); כותרות האבטחה והCSP באתר מוגדרים ונבדקו.
- [ ] `serviceAccount.json` נמחק והמפתח בוטל.
- [ ] הפרונט משתמש ב-`declareAge`, `capturePayPalOrder`, `getEntitledContent` (ראו README, "שינויים בחוזה לפרונט").

---

## 17. תקלות נפוצות

| סימפטום | סיבה אפשרית |
|---|---|
| `auth/unauthorized-domain` | הדומיין לא ב-Authorized domains |
| "לפני הרכישה יש להצהיר על תאריך לידה" | הפרונט לא קרא ל-`declareAge` (או שאין עדיין מסמך `users/{uid}`: המתינו רגע) |
| "החנות עדיין אינה מוגדרת" | `siteUrl` ריק או סודות PayPal חסרים/`PAYPAL_ENV` שגוי |
| "שירות התשלום אינו זמין" | סודות שגויים, ILS לא מופעל בחשבון, או הנחות P1–P5 (לוג של `createCheckout`) |
| לקוח שילם והזמנה `pending` | `capturePayPalOrder` לא נקרא ו-webhook לא מוגדר (סעיפים 8, 11) |
| `capture` מחזיר `pending` | PayPal מחזיק את התשלום בבדיקה: **אין להעניק**, התשלום יגיע ב-`PAYMENT.CAPTURE.COMPLETED` |
| הקטלוג ריק | אין מוצרים `active:true` או אינדקס בבנייה |
| "requires an index" | המתינו לאינדקסים או פרסו שוב `firestore:indexes` |
| הכול נכשל אחרי `enforceAppCheck:true` | האתר לא מאתחל App Check |
| פריסה נכשלת על runtime | ודאו Node 22 ו-`nodejs22`; אם Firebase דורש גרסה חדשה יותר, עדכנו את שני הקבצים והריצו `npm test` |

---

## 18. ספק חלופי אופציונלי: PayPlus

הערכה כוללת גם מתאם PayPlus (`provider: "payplus"`). הוא **לא נבדק מול התיעוד**: ראו `VERIFY-WITH-DOCS` V1–V12 בראש `functions/src/providers/payplus.js`. למעבר: סודות `PAYPLUS_API_KEY`, `PAYPLUS_SECRET_KEY`, `PAYPLUS_PAGE_UID`, `payplus.environment` בקונפיג, ופריסה. ב-PayPlus אין שלב capture נפרד (הפונקציה `capturePayPalOrder` אינה רלוונטית), והתשלום נקלט רק מה-webhook. לספק אחר (Cardcom/Tranzila/Meshulam): `functions/src/providers/README.md`.
