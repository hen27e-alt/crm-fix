# CRM Pro — מרכז האפליקציות

CRM שמשמש גם כשרת האירוח: כל האפליקציות שלי נפתחות מתוכו, באותו דומיין.
פרויקט Firebase: `crm-fix-e5ef5` (hosting).

| אפליקציה | נתיב / כתובת | מצב |
|---|---|---|
| ביונד אינטימה | https://byondintima-d1d4e.web.app/ (אתר נפרד, לא חלק מהריפו הזה) | באוויר |
| ClinicMate | https://clinicmate.co.il/ (אתר נפרד, לא חלק מהריפו הזה) | באוויר (לפי הנמסר, לא נבדק מכאן) |
| פרחי באך | `/bach/` | מתארח כאן |
| כדור בדולח | `/kadur/` | מתארח כאן |
| ערב משחקים | `/games/` | בפיתוח (דף זמני) |

הסטטוס המלא, הריפוזיטוריז והצעדים הבאים לכל אפליקציה: [`docs/PROJECTS.md`](docs/PROJECTS.md).
יומן החלטות ותקלות: [`docs/CHANGELOG.md`](docs/CHANGELOG.md).

## מבנה
```
index.html        ה-CRM (דף אחד, localStorage: crm_pro_v3)
bach/ kadur/ games/   אפליקציות מתארחות (דף אחד כל אחת, אותו origin)
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
