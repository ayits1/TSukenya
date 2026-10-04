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
const port = Number(18643);
assert(Number.isInteger(port) && port > 1024 && port < 65536, 'Invalid isolated port');
const proof = fs.mkdtempSync(path.join(os.tmpdir(), 'tsukenya-expense-layout-proof-'));
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

(async () => {
  await wait(async()=>{try{return(await fetch(base+'/health')).ok;}catch{return false;}},'server');
  fixture("from server.erp.models import Document\nfor i,name in enumerate(['Оренда','Оренда складського приміщення та щомісячне обслуговування обладнання']):Document.objects.create(path='expenses/layout'+str(i),data={'name':name,'group':'fixed','amount':10000.99,'order':i})");
  browser=await chromium.launch({headless:true});
  page=await browser.newPage({viewport:{width:1440,height:1050}});
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://fonts.googleapis.com/**',r=>r.abort());
  await page.route('https://fonts.gstatic.com/**',r=>r.abort());
  await require('./browser-login.cjs')(page,base,password);
  await page.goto(base+'/#operations/expenses');
  await page.locator('[data-budget-mode=catalog]').click();
  await page.locator('[data-exp=layout0]').waitFor();
  page.on('request',r=>{if(r.method()!=='GET')requests.push(r.method()+' '+r.url());});
  for(const [width,scale] of [[1440,1],[1024,1],[320,1],[1440,2]]){
    await page.setViewportSize({width,height:1050});
    await page.evaluate(scale=>{document.querySelectorAll('[data-qa-font]').forEach(el=>el.style.removeProperty('font-size'));if(scale===2){const nodes=[...document.querySelectorAll('.expense-budget :is(h2,h3,p,label,input,select,button,span)')];const sizes=nodes.map(el=>parseFloat(getComputedStyle(el).fontSize)*2);nodes.forEach((el,i)=>{el.dataset.qaFont='';el.style.setProperty('font-size',sizes[i]+'px','important');});}},scale);
    await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'page overflow '+width+' '+scale);
    const metrics=await page.locator('.expense-budget .exp').evaluateAll(rows=>rows.map(row=>{
      const rect=el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,w:r.width,h:r.height};};
      return {row:rect(row),name:rect(row.querySelector('.n')),amount:rect(row.querySelector('.expense-amount')),input:rect(row.querySelector('input')),textFits:(()=>{const el=row.querySelector("input"),style=getComputedStyle(el),ctx=document.createElement("canvas").getContext("2d");ctx.font=style.font;return ctx.measureText(el.value).width+parseFloat(style.paddingLeft)+parseFloat(style.paddingRight)+20<=el.clientWidth;})(),currency:rect(row.querySelector('.expense-amount span')),edit:rect(row.querySelector('[data-legacy-edit]')),remove:rect(row.querySelector('[data-del-exp]'))};
    }));
    for(const m of metrics){
      for(const key of ['name','amount','edit','remove'])assert(m[key].x>=m.row.x-1&&m[key].right<=m.row.right+1,key+' contained '+JSON.stringify(m));
      assert(m.name.bottom<=m.amount.y+1||m.name.right<=m.amount.x+1,'name separate from amount');
      assert(m.input.right<=m.currency.x-4,'currency separate from input');assert(m.textFits,'amount is readable without horizontal scrolling');
      assert(m.amount.bottom<=m.edit.y&&m.amount.bottom<=m.remove.y,'actions below amount');
      assert(m.edit.right<=m.remove.x-4,'edit separate from delete');
      assert(m.edit.h>=44&&m.remove.h>=44&&m.remove.w>=44,'touch targets');
    }
    assert(await page.locator('.expense-group nav').first().isHidden(),'single page pagination hidden');
    assert(await page.locator('[data-collection="expenses:variable"] .empty').isVisible(),'empty state');
    measurements.push({width,scale,metrics});
    await page.locator('.expense-budget').scrollIntoViewIfNeeded();await capture('expenses-'+width+'-'+scale);
  }
  await page.evaluate(()=>document.querySelectorAll('[data-qa-font]').forEach(el=>el.style.removeProperty('font-size')));
  await page.setViewportSize({width:1440,height:1050});
  const search=page.locator('[data-collection-search="expenses:fixed"]');
  await search.locator('input').fill('складського');await search.locator('input').press('Enter');
  await page.locator('[data-exp=layout0]').waitFor({state:'hidden'});await page.locator('[data-exp=layout1]').waitFor();
  await search.locator('input').fill('');await search.locator('input').press('Enter');await page.locator('[data-exp=layout0]').waitFor();
  const edit=page.locator('[data-legacy-edit=expenses][data-id=layout0]');await edit.focus();await page.keyboard.press('Enter');await page.locator('dialog[open]').waitFor();await page.keyboard.press('Escape');await page.locator('dialog[open]').waitFor({state:'hidden'});
  assert.deepEqual(requests,[],'layout/search/edit-cancel do not write business data');
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(proof,'report.json'),JSON.stringify({pass:true,source,measurements,artifacts,errors},null,2));
  console.log('EXPENSE LAYOUT PASS '+proof);
})().catch(async e=>{console.error(e);if(page)await capture('failure');console.error(proof);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();if(server.exitCode===null&&server.signalCode===null)await new Promise(resolve=>{const timer=setTimeout(()=>server.kill('SIGKILL'),5000);server.once('exit',()=>{clearTimeout(timer);resolve();});server.kill('SIGTERM');});});
