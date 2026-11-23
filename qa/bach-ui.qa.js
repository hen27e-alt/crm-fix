const {chromium}=require('playwright');
const BASE=process.env.BASE||'http://localhost:8765';
const OUT=process.env.OUT||'/tmp';

const ok=(c,m)=>{console.log((c?'PASS ':'FAIL ')+m);if(!c)process.exitCode=1;};
(async()=>{
const b=await chromium.launch();const errs=[];
for(const scheme of ['light','dark']){
const ctx=await b.newContext({viewport:{width:390,height:844},colorScheme:scheme});const pg=await ctx.newPage();
pg.on('pageerror',e=>errs.push(scheme+' PAGEERR '+e.message));pg.on('console',m=>{if(m.type()==='error'&&!/ERR_|Failed to load|net::|403/.test(m.text()))errs.push(scheme+' '+m.text())});
await pg.goto(BASE+'/bach/index.html');await pg.waitForTimeout(700);
await pg.screenshot({path:`${OUT}/bach-home-${scheme}.png`});
const tabs=pg.locator('nav [data-route], nav button, [role=tablist] button');
const n=await tabs.count();ok(n>=5,scheme+' bottom tabs ('+n+')');
if(scheme==='light'){
  // browse
  await tabs.nth(1).click();await pg.waitForTimeout(300);
  const cards=await pg.locator('[data-id]').count();ok(cards>=38,'browse shows >=38 items ('+cards+')');
  await pg.screenshot({path:OUT+'/bach-browse.png'});
  // search
  const inp=pg.locator('input[type=search], input[type=text]').first();await inp.fill('Aspen');await pg.waitForTimeout(300);
  const after=await pg.locator('[data-id]').count();ok(after>=1&&after<10,'search narrows ('+after+')');
  await pg.locator('[data-id]').first().click();await pg.waitForTimeout(400);
  await pg.screenshot({path:OUT+'/bach-detail.png'});
  const addBtn=pg.locator('#sheet [data-act=add]').first();ok(await addBtn.count()>0,'detail has add-to-blend');
  await addBtn.click();await pg.waitForTimeout(300);
  await pg.keyboard.press('Escape');
  await tabs.nth(3).click();await pg.waitForTimeout(400);
  await pg.screenshot({path:OUT+'/bach-blend.png'});
  ok((await pg.locator('body').innerText()).includes('טיפות'),'blend shows drop dosage text');
  await tabs.nth(2).click();await pg.waitForTimeout(300);
  await pg.screenshot({path:OUT+'/bach-diag.png'});
  await tabs.nth(4).click();await pg.waitForTimeout(300);
  await pg.screenshot({path:OUT+'/bach-journal.png'});
}
const ov=await pg.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth);ok(!ov,scheme+' no horizontal overflow');
await ctx.close();}
console.log('ERRORS',JSON.stringify(errs));ok(errs.length===0,'no errors');
await b.close();})();
