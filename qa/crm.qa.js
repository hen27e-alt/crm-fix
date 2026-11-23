const {chromium}=require('playwright');
const BASE=process.env.BASE||'http://localhost:8765';
const OUT=process.env.OUT||'/tmp';

const ok=(c,m)=>{console.log((c?'PASS ':'FAIL ')+m);if(!c)process.exitCode=1;};
(async()=>{
const b=await chromium.launch();
const errs=[];
const mk=async(pre)=>{const ctx=await b.newContext({viewport:{width:390,height:844}});const pg=await ctx.newPage();
 pg.on('pageerror',e=>errs.push('PAGEERR '+e.message));
 pg.on('console',m=>{if(m.type()==='error'&&!/ERR_|Failed to load resource|net::|403/.test(m.text()))errs.push(m.text())});
 if(pre)await pg.addInitScript(pre);
 await pg.goto(BASE+'/index.html');await pg.waitForTimeout(300);return {ctx,pg};};

// 1 fresh
let {ctx,pg}=await mk();
ok(await pg.locator('.poster').count()===6,'6 posters on fresh load');
ok((await pg.locator('.hero-stage h1').innerText())==='ביונד אינטימה','hero default = ביונד אינטימה');
ok(await pg.locator('.ctl-row').count()===6,'6 control rows');
// player external link for byond
await pg.click('.hs-play');
ok((await pg.locator('#browser-ext-link').getAttribute('href'))==='https://byondintima-d1d4e.web.app/','byond ext link correct');
await pg.keyboard.press('Escape');
ok(await pg.locator('#app-browser.hidden').count()===1,'Esc closes player');
// clinicmate real domain
await pg.click('.poster:has-text("ClinicMate")');
ok((await pg.locator('#browser-ext-link').getAttribute('href'))==='https://clinicmate.co.il/','clinicmate opens https://clinicmate.co.il/');
ok(await pg.locator('#browser-no-url.hidden').count()===1,'clinicmate does not ask for a domain');
ok(await pg.locator('#pl-noembed:not(.hidden)').count()===1,'clinicmate shows open-in-new-tab panel (site blocks framing)');
ok((await pg.locator('#pl-ne-link').getAttribute('href'))==='https://clinicmate.co.il/','panel link points at clinicmate.co.il');
await pg.click('.pl-btn');
// bach & kadur load same-origin
for(const [name,url] of [['פרחי באך','https://bach-flowers-site.vercel.app/'],['כדור בדולח','https://kadur-habdolach.vercel.app/']]){
  await pg.click(`.poster:has-text("${name}")`);
  ok(await pg.locator('#pl-noembed.hidden').count()===1,name+' embeds in the player');
  ok((await pg.locator('#browser-ext-link').getAttribute('href'))===url,name+' opens '+url);
  await pg.click('.pl-btn');
}
// 2 CRUD + XSS
await pg.click('.bn-item[data-view=projects]');
await pg.click('#bn-fab');
await pg.fill('#pf-name','<img src=x onerror="window.__xss=1">Evil');await pg.fill('#pf-emoji','🧪');await pg.click('#mod-project .btn-primary');
await pg.waitForTimeout(200);
ok(await pg.evaluate(()=>window.__xss===undefined),'XSS in project name not executed');
await pg.click('.project-card:has-text("Evil")');
await pg.click('.tab:has-text("משימות")');
await pg.fill('#qt-inp','<b>task</b> one');await pg.press('#qt-inp','Enter');
ok((await pg.locator('.task-text').first().innerText()).includes('<b>task</b>'),'task text escaped');
await pg.click('.task-check');
await pg.click('.tab:has-text("הערות")');await pg.click('text=+ הערה חדשה');await pg.fill('#nf-body','note <script>1</script>');await pg.click('#mod-note .btn-primary');
ok((await pg.locator('.note-body').innerText()).includes('<script>'),'note escaped');
await pg.click('.tab:has-text("קשרים")');await pg.click('text=+ איש קשר');await pg.fill('#cf-name','דנה');await pg.fill('#cf-phone','050-1234567');await pg.click('#mod-contact .btn-primary');
ok(await pg.locator('.contact-row').count()===1,'contact added');
// delete project
await pg.click('.hero-btn.danger');await pg.click('#confirm-ok');await pg.waitForTimeout(200);
ok(await pg.locator('.poster:has-text("Evil")').count()===0,'project deleted, back on home');
// 3 publishing
await pg.click('.bn-item[data-view=social]');
await pg.fill('#post-title','כותרת');await pg.fill('#post-text','פוסט בדיקה');
await pg.click('.plat-chip[data-plat=whatsapp]');await pg.click('.plat-chip[data-plat=telegram]');
await pg.selectOption('#post-proj','seed-bi');
await pg.click('.pub-box .btn-primary');await pg.waitForTimeout(400);
ok(await pg.locator('#mod-share:not(.hidden)').count()===1,'share sheet opens for manual platforms');
const href=await pg.locator('#share-body a').first().getAttribute('href');
ok(/wa\.me\/\?text=/.test(href)||/t\.me/.test(href),'share link built: '+href.slice(0,40));
ok(decodeURIComponent(href).includes('byondintima-d1d4e.web.app'),'project URL attached to share text');
await pg.click('#mod-share .btn-ghost:has-text("סגור")');
ok(await pg.locator('.post-pill:has-text("מוכן לשיתוף")').count()>=1,'history shows ready-to-share');
// telegram configured -> mocked ok
await pg.route('https://api.telegram.org/**',r=>r.fulfill({status:200,contentType:'application/json',body:'{"ok":true}'}));
await pg.click('.plat-btn');await pg.fill('#plat-f-token','123456:ABC-def');await pg.fill('#plat-f-chat','@chan');await pg.click('#mod-platform .btn-primary');
await pg.fill('#post-text','tg only');await pg.click('.plat-chip[data-plat=telegram]');await pg.click('.pub-box .btn-primary');await pg.waitForTimeout(500);
ok(await pg.locator('.post-pill:has-text("נשלח")').count()>=1,'telegram auto-send recorded as sent');
// telegram failure
await pg.unroute('https://api.telegram.org/**');
await pg.route('https://api.telegram.org/**',r=>r.fulfill({status:401,contentType:'application/json',body:'{"ok":false,"description":"Unauthorized"}'}));
await pg.fill('#post-text','tg fail');await pg.click('.plat-chip[data-plat=telegram]');await pg.click('.pub-box .btn-primary');await pg.waitForTimeout(500);
ok(await pg.locator('.post-pill:has-text("נכשל")').count()>=1,'telegram failure recorded as failed');
// scheduler
await pg.evaluate(()=>{S.posts.push({id:'sch1',title:'',text:'late',platforms:['whatsapp'],status:'scheduled',scheduledAt:Date.now()-1000,projectId:null,createdAt:Date.now()});save();});
await pg.evaluate(()=>tickScheduled());await pg.waitForTimeout(400);
ok(await pg.evaluate(()=>S.posts.find(p=>p.id==='sch1').status)==='ready','due scheduled post dispatched');
await ctx.close();

// 4 migration of legacy data
({ctx,pg}=await mk(`if(!localStorage.getItem('__m')){localStorage.setItem('__m','1');localStorage.setItem('crm_pro_v3',JSON.stringify({view:'apps',projects:[{id:'x1',name:'ביונד אינטימה',emoji:'💜',url:'https://hen27e-alt.github.io/BYOND-INTIMA/',tasks:[],notes:[],contacts:[],campaigns:[]},{id:'x2',name:'אפליקציית משחקים',emoji:'🎮',url:'games/',tasks:[],notes:[],contacts:[],campaigns:[]},{id:'x3',name:'קליניקמייט',url:'clinicmate/',tasks:[],notes:[],contacts:[],campaigns:[]}],posts:[],apps:[{id:'a'}],conns:{}}));}`));
const mig=await pg.evaluate(()=>S.projects.map(p=>[p.id,p.name,p.url]));
console.log(JSON.stringify(mig));
ok(mig[0][0]==='seed-bi'&&mig[0][2]==='https://byondintima-d1d4e.web.app/','legacy byond migrated to real URL');
ok(mig[1][1]==='ערב משחקים','legacy games renamed');
ok(mig[2][1]==='ClinicMate'&&mig[2][2]==='https://clinicmate.co.il/','legacy clinicmate gets real domain');
ok((await pg.locator('.hero-stage').count())===1,'legacy view=apps lands on home');
await ctx.close();

// 5 desktop layout
const c2=await b.newContext({viewport:{width:1280,height:800}});const p2=await c2.newPage();
p2.on('pageerror',e=>errs.push('PAGEERR '+e.message));
await p2.goto(BASE+'/index.html');await p2.waitForTimeout(300);
await p2.screenshot({path:OUT+'/desktop-home.png'});
ok(!(await p2.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth)),'desktop no horizontal overflow');
console.log('ERRORS',JSON.stringify(errs));
ok(errs.length===0,'no console/page errors');
await b.close();
})();
