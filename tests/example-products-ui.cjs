/* Legacy demo products are excluded from owner totals and can be removed; disposable local SQLite only. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn,execFileSync}=require('node:child_process'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),python=process.env.PYTHON_BIN||'python3',port=18231,base=`http://localhost:${port}`,password='isolated-examples-password';
const data=fs.mkdtempSync(path.join(os.tmpdir(),'tsukenya-examples-db-'));
const hash=execFileSync(python,['-c',`from server.auth import hash_password;print(hash_password('${password}'))`],{cwd:root,encoding:'utf8'}).trim();
const env={...process.env,PORT:String(port),HOST:'127.0.0.1',DATA_DIR:data,ERP_DB_PATH:path.join(data,'crm.sqlite3'),OWNER_USERNAME:'tester',OWNER_PASSWORD_HASH:hash};
for(const key of Object.keys(env))if(/^DB_|^PG/.test(key)||['DATABASE_URL','POSTGRES_URL'].includes(key))delete env[key];
const log=fs.openSync(path.join(data,'server.log'),'a'),server=spawn(python,['-m','server.main'],{cwd:root,env,stdio:['ignore',log,log]});fs.closeSync(log);let browser,page;
const wait=async(fn,label)=>{for(let i=0;i<120;i++){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error(label);};
// Two real products at 50% margin, two artifact examples at 90% margin, one fixed expense.
const seed=`import os
os.environ.setdefault('DJANGO_SETTINGS_MODULE','server.settings')
import django;django.setup()
from server.erp.models import Document
Document.objects.filter(path__startswith='products/').delete()
for id,name,cost,markup,example in [('real_a','Пряник медовий',50,100,False),('real_b','Карамель льодяникова',50,100,False),('p1','Цукерки глазуровані вагові',10,900,True),('p2','Печиво вівсяне',10,900,True)]:
 data={'name':name,'unit':'шт','cost':cost,'markup':markup,'manualPrice':False,'price':None,'priceAt':''}
 if example:data['example']=True
 Document.objects.create(path='products/'+id,data=data)
Document.objects.update_or_create(path='expenses/qa_rent',defaults={'data':{'name':'Оренда','group':'fixed','amount':1000,'order':1}})`;
const products=()=>page.evaluate(async()=>(await(await fetch('/api/state')).json()).data.products.map(p=>p.id).sort());
(async()=>{try{
 await wait(async()=>{if(server.exitCode!==null)throw Error(fs.readFileSync(path.join(data,'server.log'),'utf8').slice(-2000));try{return(await fetch(base+'/health')).ok;}catch{return false;}},'server');
 execFileSync(python,['-c',seed],{cwd:root,env});
 browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH||process.platform==='darwin'?{executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}:{})});
 page=await browser.newPage({viewport:{width:1280,height:1000}});page.setDefaultTimeout(12000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://fonts.googleapis.com/**',r=>r.abort());await page.route('https://fonts.gstatic.com/**',r=>r.abort());
 await require('./browser-login.cjs')(page,base,password);
 const stat=label=>page.locator('.stat',{hasText:label}).locator('.v');
 await wait(async()=>(await stat('Товарів у каталозі').innerText())==='2','overview counts only real products');
 const notice=page.locator('#main p',{hasText:'товарів-прикладів'});
 assert.match(await notice.innerText(),/^2 товарів-прикладів/,'overview names the excluded examples');
 await page.evaluate(()=>location.hash='#operations/expenses');
 const be=page.locator('.expense-budget .be');await be.waitFor();
 const text=(await be.innerText()).replace(/\s+/g,' ');
 assert.match(text,/50% маржі/,'margin uses real products only, not the 90% examples');
 assert.match(text,/Враховано 2 із 2 товарів/,'coverage counts real products only');
 assert.match(text,/2 000 грн на місяць/,'break-even is 1000 / 0.5');
 assert.match(text,/2 товарів-прикладів/,'budget explains excluded examples');
 // One example is refused by the server (e.g. used in accounting); the rest are removed.
 await page.route('**/api/docs/products/p2',route=>route.request().method()==='DELETE'?route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'Товар уже використовується в обліку. Його не можна видалити.'})}):route.continue());
 page.once('dialog',dialog=>{assert.match(dialog.message(),/Прибрати 2 товарів-прикладів/);dialog.accept();});
 await be.getByRole('button',{name:'Прибрати приклади'}).click();
 await wait(async()=>/Прибрано 1 із 2/.test(await page.locator('#toast').innerText()),'partial removal is reported');
 assert.deepEqual(await products(),['p2','real_a','real_b']);
 await page.unroute('**/api/docs/products/p2');
 page.once('dialog',dialog=>dialog.accept());
 await be.getByRole('button',{name:'Прибрати приклади'}).click();
 await wait(async()=>(await page.locator('#toast').innerText())==='Приклади прибрано','examples removed');
 assert.deepEqual(await products(),['real_a','real_b'],'real products are untouched');
 await wait(async()=>await page.locator('.be',{hasText:'товарів-прикладів'}).count()===0,'notice disappears');
 assert.deepEqual(errors,[]);
 console.log('example-products-ui: ok');
}finally{await browser?.close();server.kill('SIGTERM');if(server.exitCode===null)await new Promise(resolve=>server.once('exit',resolve));fs.rmSync(data,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
