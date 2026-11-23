# CRM Pro — מרכז האפליקציות

CRM שמשמש גם כשרת האירוח: כל האפליקציות שלי נפתחות מתוכו, באותו דומיין.
פרויקט Firebase: `crm-fix-e5ef5` (hosting).

| אפליקציה | נתיב / כתובת | מצב |
|---|---|---|
| ביונד אינטימה | https://byondintima-d1d4e.web.app/ (אתר נפרד, לא חלק מהריפו הזה) | באוויר |
| ClinicMate | https://clinicmate.co.il/ (אתר נפרד, ריפו `clinicmate-v2`) | לפי הנמסר. התיעוד בריפו מציין שעד 2026-11-04 עלה רק preview מוגן, לא נבדק מכאן |
| פרחי באך | https://bach-flowers-site.vercel.app/ (Vercel, ריפו `bach-flowers-site`) | באוויר (לפי הנמסר, לא נבדק מכאן) |
| כדור בדולח | https://kadur-habdolach.vercel.app/ (Vercel, ריפו `kadur-habdolach`) | באוויר (לפי הנמסר, לא נבדק מכאן) |
| ערב משחקים | https://erev-mischakim-jfkpt.web.app/ (Firebase, ריפו `erev-mischakim`; גם Vercel `game-night`) | באוויר לפי ה-README של הריפו (לא נבדק מכאן) |

הסטטוס המלא, הריפוזיטוריז והצעדים הבאים לכל אפליקציה: [`docs/PROJECTS.md`](docs/PROJECTS.md).
יומן החלטות ותקלות: [`docs/CHANGELOG.md`](docs/CHANGELOG.md).

## מבנה
```
index.html        ה-CRM (דף אחד, localStorage: crm_pro_v3)
bach/ kadur/   עותקי גיבוי של האפליקציות (ה-CRM פותח את גרסאות ה-Vercel)
docs/             תיעוד לכל פרויקט (לא מתפרסם)
firebase.json     הגדרות hosting
.github/workflows/firebase-deploy.yml   פריסה אוטומטית ב-push ל-main
```

## פריסה
פריסה ידנית: `firebase deploy --only hosting --project crm-fix-e5ef5`.
פריסה אוטומטית: להריץ פעם אחת `firebase init hosting:github` (יוצר את הסוד `FIREBASE_SERVICE_ACCOUNT`), ואז כל push ל-`main` מתפרסם.
בלי הסוד ה-workflow מדלג ולא נכשל.

## כללים
- האתר `byondintima-d1d4e` הוא פרודקשן נפרד. לא נוגעים בו מכאן.
- אפליקציות חיצוניות שחוסמות הטמעה נפתחות בטאב חדש (כפתור החץ בנגן).
