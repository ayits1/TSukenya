/* Actual catalogue expense rows and controls. Disposable SQLite + bundled headless Chromium. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const python = process.env.PYTHON_BIN || 'python3';
const port = Number(18644);
assert(Number.isInteger(port) && port > 1024 && port < 65536, 'Invalid isolated port');
const proof = fs.mkdtempSync(path.join(os.tmpdir(), 'tsukenya-label-toolbar-proof-'));
fs.mkdirSync(proof, { recursive: true });
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tsukenya-directory-toolbar-data-'));
const base = `http://localhost:${port}`, password = 'isolated-directory-toolbar-password';
const env = { ...process.env };
for (const key of Object.keys(env))
  if (/^(?:DB_|PG|DATABASE_URL$|POSTGRES_URL$|OWNER_PASSWORD|DJANGO_SETTINGS_MODULE$|DJANGO_SECRET_KEY$|TSUKENYA_REQUIRE_POSTGRES$)/.test(key)) delete env[key];
Object.assign(env, { HOST: '127.0.0.1', PORT: String(port), DATA_DIR: data, ERP_DB_PATH: path.join(data, 'isolated.sqlite3'), OWNER_USERNAME: 'tester', DJANGO_SETTINGS_MODULE: 'server.settings', DJANGO_SECRET_KEY: 'isolated-directory-toolbar-secret-not-production-at-least-fifty-characters' });
env.OWNER_PASSWORD_HASH = execFileSync(python, ['-c', `from server.auth import hash_password;print(hash_password('${password}'))`], { cwd: root, env, encoding: 'utf8' }).trim();
const log = fs.openSync(path.join(proof, 'server.log'), 'w');
const server = spawn(python, ['-m', 'server.main'], { cwd: root, env, stdio: ['ignore', log, log] });
let browser, page, ids;
const requests = [], errors = [], measurements = [], artifacts = [], stages = [];
const source = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const manifest = path.join(root, 'frontend/dist/.vite/manifest.json');
const buildManifestSha256 = fs.existsSync(manifest) ? crypto.createHash('sha256').update(fs.readFileSync(manifest)).digest('hex') : null;

async function wait(check, message) {
  for (let i = 0; i < 250; i++) {
    if (server.exitCode !== null || server.signalCode !== null) throw Error('Isolated server exited: ' + message);
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('Timed out: ' + message);
}
async function capture(name) {
  const file = path.join(proof, name + '.png');
  await page.screenshot({ path: file, fullPage: false });
  artifacts.push(file);
}
const fixture = code => execFileSync(python, ['-c', `import django;django.setup()\n${code}`], {cwd:root,env,encoding:'utf8'}).trim();


(async()=>{
 await wait(async()=>{try{return(await fetch(base+'/health')).ok;}catch{return false;}},'server');
 fixture("from server.erp.models import Document\nDocument.objects.create(path='products/toolbar',data={'name':'Контрольна кава','unit':'шт','price':60,'manualPrice':True,'cost':20,'priceAt':'2026-10-04'})");
 browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1440,height:900}});page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://fonts.googleapis.com/**',r=>r.abort());await page.route('https://fonts.gstatic.com/**',r=>r.abort());await require('./browser-login.cjs')(page,base,password);
 await page.goto(base+'/#operations/tags');await page.getByRole('tab',{name:'Макет',exact:true}).waitFor();
 page.on('request',r=>{if(!['GET','HEAD'].includes(r.method()))requests.push(r.method()+' '+r.url());});
 const store=page.getByRole('button',{name:/Ціни та друк для/});
 for(const width of [1440,1280,320]){
  await page.setViewportSize({width,height:900});await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'no page overflow');
  if(width>=1200){
   const boxes=await page.evaluate(()=>['.tk-pricing-context .tk-select-trigger','.tk-pricing-context-info summary','.tk-studio-tabs','.tk-studio-history','.tk-studio-save > .tk-button'].map(sel=>{const r=document.querySelector(sel).getBoundingClientRect();return {sel,x:r.x,right:r.right,y:r.y,bottom:r.bottom,height:r.height};}));
   for(const b of boxes)assert(b.height>=44,'44px '+b.sel);
   assert(Math.max(...boxes.map(b=>b.y))<Math.min(...boxes.map(b=>b.bottom)),'one command row '+JSON.stringify(boxes));
   for(let i=1;i<boxes.length;i++)assert(boxes[i-1].right<=boxes[i].x+1,'no overlap '+JSON.stringify(boxes));measurements.push({width,boxes});
  }
  const summary=page.locator('.tk-pricing-context-info summary');await summary.focus();await summary.press('Enter');await page.locator('.tk-pricing-context-confirmed').waitFor();
  assert(await page.locator('.tk-pricing-context-confirmed').evaluate(el=>{const r=el.getBoundingClientRect();return r.x>=0&&r.right<=innerWidth;}),'context popup fits');
  await summary.press('Enter');await store.focus();await store.press('Enter');await page.getByRole('listbox').waitFor();await page.keyboard.press('Escape');
  await page.getByRole('tab',{name:'Макет',exact:true}).focus();await page.keyboard.press('ArrowRight');await wait(async()=>await page.getByRole('tab',{name:/Товари для друку/}).getAttribute('aria-selected')==='true','keyboard tabs');await page.getByRole('tab',{name:'Макет',exact:true}).click();
  await page.screenshot({path:path.join(proof,'toolbar-'+width+'.png'),fullPage:false});
 }
 assert.deepEqual(errors,[]);assert.deepEqual(requests,[],'toolbar verification does not write');fs.writeFileSync(path.join(proof,'report.json'),JSON.stringify({pass:true,measurements,errors,requests},null,2));console.log('LABEL TOOLBAR PASS '+proof);
})().catch(async e=>{console.error(e);if(page)await capture('failure');console.error(proof);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();if(server.exitCode===null&&server.signalCode===null)await new Promise(resolve=>{const timer=setTimeout(()=>server.kill('SIGKILL'),5000);server.once('exit',()=>{clearTimeout(timer);resolve();});server.kill('SIGTERM');});});
