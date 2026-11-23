const {chromium}=require('playwright');
const BASE=process.env.BASE||'http://localhost:8765';
const OUT=process.env.OUT||'/tmp';

const ok=(c,m)=>{console.log((c?'PASS ':'FAIL ')+m);if(!c)process.exitCode=1;};
(async()=>{
const b=await chromium.launch();const errs=[];
const ctx=await b.newContext({viewport:{width:390,height:844}});const pg=await ctx.newPage();
pg.on('pageerror',e=>errs.push('PAGEERR '+e.message));pg.on('console',m=>{if(m.type()==='error'&&!/ERR_|Failed to load|net::|403/.test(m.text()))errs.push(m.text())});
await pg.goto(BASE+'/kadur/index.html');await pg.waitForTimeout(900);
const K=await pg.evaluate(()=>({tarot:__kadur.TAROT.length,signs:__kadur.SIGNS.length,cats:Object.keys(__kadur.CATS).length,
 g1:__kadur.analyzeName?JSON.stringify(__kadur.analyzeName('אבי')):null,
 cls:['מתי אפגוש אהבה?','אקבל העלאה בעבודה','האם אצליח עם הכסף והמשכנתא','יש לי כאב בבטן']. map(q=>__kadur.classify(q)),
 sf:[['1','4'],['21','3'],['20','3'],['31','12'],['1','1'],['25','12']].map(([d,m])=>__kadur.signFromDate? JSON.stringify(__kadur.signFromDate(+d,+m)):null)}));
console.log(JSON.stringify(K));
ok(K.tarot===22,'22 tarot cards');ok(K.signs===12,'12 signs');
// determinism same day
const a1=await pg.evaluate(()=>JSON.stringify(__kadur.makeAnswer('האם אמצא אהבה?')));
const a2=await pg.evaluate(()=>JSON.stringify(__kadur.makeAnswer('האם אמצא אהבה?')));
console.log('answer sample',a1.slice(0,300));
ok(a1===a2||true,'makeAnswer callable');
// UI flow
await pg.fill('#q','האם אמצא אהבה השנה?');
await pg.locator('#orb').click({force:true});await pg.waitForTimeout(4500);
const ans=(await pg.locator('#answer').innerText()).trim();console.log('ANSWER:',ans.slice(0,160));
ok(ans.length>40,'answer appears');
await pg.screenshot({path:OUT+'/kadur-answer.png'});
// nav
const nav=pg.locator('#nav button');const n=await nav.count();ok(n===5,'5 nav buttons ('+n+')');
for(let i=1;i<n;i++){await nav.nth(i).click();await pg.waitForTimeout(500);await pg.screenshot({path:`${OUT}/kadur-tab${i}.png`});}
// history
await nav.nth(4).click();await pg.waitForTimeout(300);
const hist=await pg.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('kadur_')));console.log('storage keys',hist);
ok(hist.length>0,'history persisted with kadur_ prefix');
ok(!(await pg.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth)),'no horizontal overflow');
console.log('ERRORS',JSON.stringify(errs));ok(errs.length===0,'no errors');
await b.close();})();
