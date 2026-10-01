/* React catalogue against an isolated real Django server; never the VPS. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn, execFileSync} = require('node:child_process');
const {chromium, webkit} = require('playwright');
const root = path.resolve(__dirname, '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tsukenya-catalog-ui-'));
const python = process.env.PYTHON_BIN || 'python3';
const base = 'http://localhost:18207', password = 'isolated-catalog-ui-password';
const hash = execFileSync(python, ['-c', 'from server.auth import hash_password; print(hash_password("isolated-catalog-ui-password"))'], {cwd: root, encoding:'utf8'}).trim();
const env = {...process.env, DATA_DIR:data, ERP_DB_PATH:path.join(data, 'crm.sqlite3'), PORT:'18207', HOST:'127.0.0.1', OWNER_USERNAME:'tester', OWNER_PASSWORD_HASH:hash};
for(const key of ['DB_HOST','DB_PORT','DB_NAME','DB_USER','DB_PASSWORD']) delete env[key];
const server = spawn(python, ['-m','server.main'], {cwd:root, env, stdio:'ignore'});
let browser;
async function until(condition, label) { for(let i=0;i<120;i++){if(await condition())return;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error(label); }
(async () => {
 await until(async()=>{try{return (await fetch(base+'/health')).ok;}catch{return false;}},'server startup');
 const browserType=process.env.QA_BROWSER==='webkit'?webkit:chromium;
 browser=await browserType.launch(process.env.QA_BROWSER==='webkit'?{headless:true}:{headless:true,...(process.platform==='darwin'?{executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}:{})});
 const page=await browser.newPage({viewport:{width:1440,height:1000}}), errors=[];page.on('pageerror',error=>errors.push(error.message));
 // Functional checks use the system-font fallback instead of waiting for an external font CDN.
 await page.route('https://fonts.googleapis.com/**', route=>route.abort());
 await page.route('https://fonts.gstatic.com/**', route=>route.abort());
 page.setDefaultTimeout(10_000);await require('./browser-login.cjs')(page,base,password);
 await page.goto(base+'/#operations/products');
 await until(async()=>await page.locator('.tk-product-table tbody tr').count()===20,'React catalogue page');
 assert(await page.evaluate(()=>!!window.ReactCatalog));console.log('React catalogue loaded');
 if(process.env.QA_REFERENCES_ONLY){
  await require('./catalog-references.cjs')(page, until);
  assert.deepEqual(errors,[]);return;
 }
 if(process.env.QA_DATE_ONLY){
  await require('./catalog-date.cjs')(page, until);
  await require('./catalog-references.cjs')(page, until);
  assert.deepEqual(errors,[]);return;
 }
 if(!process.env.QA_LAYOUT_ONLY && !process.env.QA_FILTERS_ONLY){
  await require('./catalog-price.cjs')(page, until);
  if(process.env.QA_PRICE_ONLY){assert.deepEqual(errors,[]);return;}
  await require('./catalog-date.cjs')(page, until);
 }
 if(!process.env.QA_LAYOUT_ONLY && !process.env.QA_FILTERS_ONLY){
 await page.getByRole('button',{name:'Далі',exact:true}).click();
 await until(async()=>/21–40/.test(await page.locator('.tk-catalog-pagination').innerText()),'server pagination');
 await page.getByRole('searchbox',{name:'Пошук товару'}).fill('Американо');
 await until(async()=>await page.locator('.tk-product-table tbody tr').count()===1,'server search');
 await page.getByRole('button',{name:'Скинути фільтри'}).click();
 await page.getByRole('combobox',{name:'Група',exact:true}).fill('Напої');
 await page.getByRole('combobox',{name:'Група',exact:true}).press('ArrowDown');await page.getByRole('combobox',{name:'Група',exact:true}).press('Enter');
 await until(async()=>!(await page.locator('.tk-catalog').getAttribute('aria-busy')==='true'),'group filter');
 await page.getByRole('combobox',{name:'Категорія',exact:true}).click();
 assert.equal(await page.getByRole('option',{name:'Шоколад',exact:true}).count(),0,'dependent category list');
 await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'Скинути фільтри'}).click();
 await page.getByRole('button',{name:'Додати товар'}).click();
 const dialog=page.getByRole('dialog');
 await dialog.getByRole('textbox',{name:'Назва товару'}).fill('Контрольний React товар');
 await dialog.getByRole('combobox',{name:'Група',exact:true}).fill('Напої');
 await page.getByRole('option',{name:'Напої',exact:true}).click();
 await dialog.getByRole('button',{name:'Додати запис: Категорія'}).click();
 await dialog.getByRole('textbox',{name:'Новий запис: Категорія'}).fill('Тест');
 await dialog.getByRole('button',{name:'Додати й вибрати'}).click();
 await until(async()=>await dialog.getByRole('combobox',{name:'Категорія',exact:true}).inputValue()==='Тест','inline category creation');
 await dialog.getByRole('textbox',{name:'Мінімальний залишок'}).fill('3');
 await dialog.getByText('Задати ціну продажу вручну',{exact:true}).click();
 await dialog.getByRole('textbox',{name:'Звичайна ціна: гривні',exact:true}).fill('45');
 await dialog.getByText('Акція — окрема ціна та позначка на ціннику',{exact:true}).click();
 await dialog.getByRole('textbox',{name:'Акційна ціна: гривні',exact:true}).fill('39');
 await dialog.getByRole('button',{name:'Зберегти товар'}).click();
 await until(async()=>await page.getByRole('dialog').count()===0,'create product');
 await page.getByRole('searchbox',{name:'Пошук товару'}).fill('Контрольний React товар');
 await until(async()=>await page.locator('.tk-product-link').count()===1,'new product search');
 console.log('Creation completed');
 const product=await page.evaluate(async()=>{const r=await fetch('/api/v1/catalog/products?q='+encodeURIComponent('Контрольний React товар'));return (await r.json()).items[0];});
 assert.equal(product.regularPrice,'45.00');assert.equal(product.promotionPrice,'39.00');assert.equal(product.salePrice,'39.00');assert.equal(Number(product.minStock),3);assert.equal(product.promotion,true);
 await page.locator('.tk-product-link').click();
 await page.getByRole('dialog').getByRole('textbox',{name:'Назва товару'}).fill('Незбережена моя назва');
 await page.evaluate(async id=>{const session=await (await fetch('/api/v1/session')).json();const result=await fetch('/api/docs/products/'+id,{method:'PATCH',headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrf},body:JSON.stringify({name:'Оновлено іншим редактором'})});if(!result.ok)throw new Error('isolated competing edit failed');},product.id);
 await page.getByRole('dialog').getByRole('button',{name:'Зберегти товар'}).click();
 await page.getByRole('alert').filter({hasText:'Товар уже змінено'}).waitFor();
 assert.equal(await page.getByRole('dialog').getByRole('textbox',{name:'Назва товару'}).inputValue(),'Незбережена моя назва');
 await page.getByRole('button',{name:'Завантажити актуальний товар'}).click();
 await until(async()=>await page.getByRole('dialog').getByRole('textbox',{name:'Назва товару'}).inputValue()==='Оновлено іншим редактором','explicit conflict reload');
 console.log('Conflict protection completed');await page.getByRole('button',{name:'Закрити редактор'}).click();
 await page.getByRole('searchbox',{name:'Пошук товару'}).fill('Оновлено іншим редактором');
 await until(async()=>await page.locator('.tk-product-link').count()===1,'updated search');
 await page.getByRole('button',{name:/Акція для Оновлено/}).click();
 await until(async()=>await page.getByRole('button',{name:/Акція для Оновлено/}).getAttribute('aria-pressed')==='false','promotion toggle persisted');
 await page.goto(base+'/#operations/tags');await page.waitForSelector('.tk-studio');const preview=page.getByRole('combobox',{name:'Товар для перегляду',exact:true});await preview.fill('Оновлено іншим редактором');await page.getByRole('option',{name:'Оновлено іншим редактором',exact:true}).click();
 assert.equal(await page.locator('.tk-studio-canvas [data-field=name]').innerText(),'Оновлено іншим редактором');assert.equal(await page.locator('.tk-studio-canvas .t-promo').count(),0);
 }
 if(process.env.QA_FILTERS_ONLY){
  await page.getByRole('searchbox',{name:'Пошук товару'}).fill('Американо');
  await until(async()=>await page.locator('.tk-product-table tbody tr').count()===1,'single filtered product');
  await page.locator('.tab[data-tab=tags]').click();await page.waitForSelector('.tk-studio');
  await page.locator('.tab[data-tab=products]').click();await page.waitForSelector('.tk-product-table');
  assert.equal(await page.getByRole('searchbox',{name:'Пошук товару'}).inputValue(),'Американо','filter retained after navigation');
  const before=await page.evaluate(async()=> (await (await fetch('/api/state')).json()).data.products);
  await page.locator('[data-disclosure=bulk] summary').click();await page.locator('#bulkC').selectOption('__f');await page.locator('#bulkM').fill('42');
  page.once('dialog',async dialog=>{assert.match(dialog.message(),/для 1 товар/);await dialog.accept();});
  await page.locator('[data-act=bulk]').click();
  await until(async()=>await page.evaluate(async()=> (await (await fetch('/api/state')).json()).data.products.find(p=>p.data.name==='Американо').data.markup===42),'bulk filters compatibility');
  const after=await page.evaluate(async()=> (await (await fetch('/api/state')).json()).data.products);
  assert.equal(before.filter(p=>JSON.stringify(p.data)!==JSON.stringify(after.find(item=>item.id===p.id).data)).length,1,'bulk changed only the selected filter');
  await page.getByRole('button',{name:'Скинути фільтри'}).click();
 }
 await page.goto(base+'/#operations/products');await page.waitForSelector('.tk-product-table');
 for(const width of [1440,390,320]){
  await page.setViewportSize({width,height:1000});
  const overflow=await page.evaluate(()=>[...document.querySelectorAll('body *')].filter(el=>{const b=el.getBoundingClientRect();return b.width&&b.right>innerWidth+1;}).map(el=>({tag:el.tagName,cls:el.className,width:el.getBoundingClientRect().width,right:el.getBoundingClientRect().right,min:getComputedStyle(el).minWidth})).slice(0,20));
  await page.screenshot({path:path.join(os.tmpdir(),`tsukenya-react-catalog-${width}-${process.env.QA_BROWSER||'chromium'}.png`),fullPage:true});
  await page.screenshot({path:path.join(os.tmpdir(),`tsukenya-react-catalog-viewport-${width}-${process.env.QA_BROWSER||'chromium'}.png`)});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'catalogue overflow at '+width+' '+JSON.stringify(overflow));
  await page.screenshot({path:path.join(os.tmpdir(),`tsukenya-react-catalog-${width}-${process.env.QA_BROWSER||'chromium'}.png`),fullPage:true});
 }
 await page.getByRole('button',{name:'Додати товар'}).click();
 await page.getByRole('dialog').waitFor();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'editor mobile overflow');
 await page.screenshot({path:path.join(os.tmpdir(),'tsukenya-react-catalog-editor-'+(process.env.QA_BROWSER||'chromium')+'.png')});
 await page.keyboard.press('Escape');assert.equal(await page.getByRole('dialog').count(),0);
 assert.deepEqual(errors,[]);
 console.log((process.env.QA_LAYOUT_ONLY||process.env.QA_FILTERS_ONLY)?'PASS: catalogue/editor geometry at 1440/390/320, Escape and no runtime errors.':'PASS: real React catalogue, server search/page, dependent filters, creation/minimum stock/promotion, conflict protection, label integration, desktop/mobile geometry and focus.');
})().finally(async()=>{await browser?.close();server.kill('SIGTERM');fs.rmSync(data,{recursive:true,force:true});}).catch(error=>{console.error(error);process.exitCode=1;});
