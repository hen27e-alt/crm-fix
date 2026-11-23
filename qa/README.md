# בדיקות איכות

סקריפטי Playwright שרצים מול האתר המקומי.

```
npm i playwright          # פעם אחת
python3 -m http.server 8765   # מתוך שורש הריפו, בטרמינל נפרד
BASE=http://localhost:8765 OUT=/tmp node qa/crm.qa.js
node qa/bach-data.qa.js       # בדיקת 38 הפרחים מול החלוקה הקלאסית
node qa/bach-ui.qa.js
node qa/kadur.qa.js
```

`crm.qa.js` בודק: מדפי הבית, הנגן, מעבר מנתונים ישנים, הוספה ומחיקה, הגנת קלט (XSS), פרסום, תזמון ופריסה בשולחן עבודה.
בדיקות הפרסום מדמות את Telegram (route mock) ואינן שולחות הודעות אמיתיות.
`kadur.qa.js` נכתב לגרסה שחשפה `window.__kadur` לבדיקות. הגרסה בפרודקשן לא חושפת אותו, ולכן בדיקות הלוגיקה בו דורשות עותק לבדיקה.
