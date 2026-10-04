/* Actual catalogue-budget display on a disposable local database; no production writes. */
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawn, execFileSync} = require('node:child_process'), {chromium} = require('playwright'), net = require('node:net');
const root = path.resolve(__dirname, '..'), python = process.env.PYTHON_BIN || 'python3';
const proof = fs.mkdtempSync(path.join(os.tmpdir(), 'tsukenya-catalogue-range-')), data = path.join(proof, 'data'); fs.mkdirSync(data);
const env = {...process.env};
for (const key of Object.keys(env)) if (/^DB_|^PG|^OWNER_|^DJANGO_SECRET_KEY$|^QA_/.test(key) || ['DATABASE_URL','POSTGRES_URL','TSUKENYA_REQUIRE_POSTGRES','DATA_DIR','ERP_DB_PATH'].includes(key)) delete env[key];
Object.assign(env, {DATA_DIR:data, ERP_DB_PATH:path.join(data,'crm.sqlite3'), DJANGO_SECRET_KEY:'isolated-range-only-secret-key-not-production-at-least-fifty-characters', OWNER_USERNAME:'tester', HOST:'127.0.0.1'});
const password = 'isolated-range-password';
env.OWNER_PASSWORD_HASH = execFileSync(python,['-c','from server.auth import hash_password; print(hash_password("isolated-range-password"))'],{cwd:root,env,encoding:'utf8'}).trim();
const run = source => execFileSync(python,['-c',`import os;os.environ.setdefault('DJANGO_SETTINGS_MODULE','server.settings');import django;django.setup()\n${source}`],{cwd:root,env,encoding:'utf8'});
let server, browser, page; const checks=[];const tail=process.env.QA_RANGE_TAIL==='1', enlargedOnly=process.env.QA_RANGE_ENLARGED==='1';
const seed = `from server.erp.models import Document
Document.objects.filter(path__startswith='products/').delete()
Document.objects.filter(path__startswith='expenses/').delete()
for key,cost,price,extra in [('half',50,100,{}),('quarter',75,100,{}),('missing',0,100,{}),('demo',1,100,{'example':True}),('hidden',99,100,{'hidden':True})]:
 Document.objects.create(path='products/'+key,data={'name':key,'unit':'шт','cost':cost,'price':price,'manualPrice':True,**extra})
Document.objects.create(path='expenses/rent',data={'name':'Оренда','amount':1000,'group':'fixed'})`;
async function until(fn,label){for(let n=0;n<150;n++){if(server?.exitCode!==null&&server?.exitCode!==undefined)throw Error(fs.readFileSync(path.join(proof,'server.log'),'utf8').slice(-2500));if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error(label);}
(async()=>{try{
 const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));env.PORT=String(port);const base=`http://localhost:${port}`;
 const fd=fs.openSync(path.join(proof,'server.log'),'a');server=spawn(python,['-m','server.main'],{cwd:root,env,stdio:['ignore',fd,fd]});fs.closeSync(fd);
 await until(async()=>{try{return(await fetch(base+'/health')).ok;}catch{return false;}},'local startup');run(seed);
 browser=await chromium.launch({headless:true,...(process.platform==='darwin'?{executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}:{})});
 page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(15000);const errors=[],writes=[];
 page.on('pageerror',e=>errors.push(e.message));await page.route('https://fonts.googleapis.com/**',r=>r.abort());await page.route('https://fonts.gstatic.com/**',r=>r.abort());
 await require('./browser-login.cjs')(page,base,password);
 page.on('request',r=>{if(new URL(r.url()).origin===base&&!['GET','HEAD'].includes(r.method()))writes.push([r.method(),new URL(r.url()).pathname]);});
 let navigation=0;const open=async()=>{await page.goto(base+'/?range-check='+String(++navigation)+'#operations/expenses');await page.locator('[data-budget-mode=catalog]').click();await page.locator('[data-catalogue-range]').waitFor({state:'attached'});};
 const be=page.locator('.expense-budget .be');let text;if(!tail){await open();
 await until(async()=>/продажів немає/.test(await be.innerText()),'no sales fallback');
 text=(await be.innerText()).replace(/\s+/g,' ');assert.match(text,/2 000,00 – 4 000,00 грн на місяць/);assert.match(text,/Враховано 2 із 3 товарів/);assert.match(text,/25,00 – 50,00%/);assert.doesNotMatch(text,/2 666,67/);checks.push('actual no-sales range2000–4000, partial coverage, no equal-weight point');
 const baseFont=await be.locator('[data-catalogue-range] p').first().evaluate(el=>parseFloat(getComputedStyle(el).fontSize));
 for(const [width,scale] of (enlargedOnly?[[320,2]]:[[1440,1],[320,1],[320,2]])){
  await page.setViewportSize({width,height:1000});await page.addStyleTag({content:`[data-catalogue-range],.be>h3,.be>.be-fact{font-size:${baseFont*scale}px !important}`});
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  assert.equal(await be.locator('[data-catalogue-range] p').first().evaluate(el=>parseFloat(getComputedStyle(el).fontSize)),baseFont*scale);
  const geometry=await be.evaluate(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,inner:innerWidth,scroll:el.scrollWidth,width:el.clientWidth};});assert(geometry.left>=-1&&geometry.right<=geometry.inner+1&&geometry.scroll<=geometry.width+1,JSON.stringify(geometry));
  await be.screenshot({path:path.join(proof,`range-${width}-${scale}.png`)});
 }
 checks.push(enlargedOnly?'320px with verified doubled computed text size':'1440/320 and enlarged text fit actual budget panel');fs.writeFileSync(path.join(proof,'primary.json'),JSON.stringify({checks},null,2));}
 if(enlargedOnly){assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);fs.writeFileSync(path.join(proof,'report.json'),JSON.stringify({pass:true,scope:'enlarged text only',checks},null,2));console.log(JSON.stringify({proof,checks}));return;}
 run("from server.erp.models import Document\np=Document.objects.get(pk='products/quarter');p.data['cost']=100;p.save()");await open();
 text=(await be.innerText()).replace(/\s+/g,' ');assert.match(text,/від 2 000,00 грн на місяць/);assert.match(text,/Скінченної верхньої межі немає/);assert.match(text,/Товарів із нульовою або від’ємною маржею: 1/);checks.push('zero-margin item prevents a finite upper bound');
 run("from server.erp.models import Voucher,Store\nfrom django.contrib.auth.models import User\nfrom django.utils import timezone\nVoucher.objects.create(kind='sale',date=timezone.localdate(),store=Store.objects.first(),created_by=User.objects.get(username='tester'),status='posted',total='1000.00',cost='800.00')");
 await open();await be.getByRole('heading',{name:'За фактичними продажами'}).waitFor();
 const details=be.locator('.catalogue-range-details');assert.equal(await details.getAttribute('open'),null);assert.equal(await be.locator('[data-catalogue-range]').isVisible(),false);
 assert.match((await be.locator('.be-fact').innerText()).replace(/\s+/g,' '),/валова маржа 20%/);assert.match((await be.locator('.be-fact').innerText()).replace(/\s+/g,' '),/166,67 грн на день/);
 const summary=details.locator('summary');await summary.focus();await summary.press('Enter');assert.equal(await be.locator('[data-catalogue-range]').isVisible(),true);await summary.press('Enter');assert.equal(await be.locator('[data-catalogue-range]').isVisible(),false);
 assert((await summary.boundingBox()).height>=44);checks.push('real sales-weighted result primary; catalogue scenarios collapsed, keyboard toggle44px');
 assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);checks.push('read-only browser path, no page errors');fs.writeFileSync(path.join(proof,'report.json'),JSON.stringify({pass:true,scope:tail?'zero-margin and weighted-sales tail':'all',checks},null,2));console.log(JSON.stringify({proof,checks}));
 }finally{await browser?.close();if(server?.exitCode===null){server.kill('SIGTERM');await new Promise(r=>server.once('exit',r));}fs.rmSync(data,{recursive:true,force:true});}
})().catch(async e=>{console.error(e);process.exitCode=1;});
