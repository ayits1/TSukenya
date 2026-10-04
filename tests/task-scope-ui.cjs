/* Real task controls against a private temporary SQLite database. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tsukenya-task-scope-ui-'));
const python = process.env.PYTHON_BIN || 'python3';
const port = Number(process.env.QA_PORT || 18217);
const base = `http://localhost:${port}`;
const password = 'isolated-task-ui-password';
const hash = execFileSync(python, ['-c', 'from server.auth import hash_password;print(hash_password("isolated-task-ui-password"))'], { cwd: root, encoding: 'utf8' }).trim();
const env = { ...process.env, DATA_DIR: data, ERP_DB_PATH: path.join(data, 'crm.sqlite3'),
  PORT: String(port), HOST: '127.0.0.1', OWNER_USERNAME: 'tester', OWNER_PASSWORD_HASH: hash,
  DJANGO_SETTINGS_MODULE: 'server.settings' };
for (const key of ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD']) delete env[key];
let server, browser, lastPage;
const errors = [], results = [];
async function until(check, message) {
  for (let i = 0; i < 120; i++) {
    if (server && server.exitCode !== null) throw Error('Isolated server exited before completing checks');
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error(message);
}
async function state(page) {
  return page.evaluate(async () => (await (await fetch('/api/state')).json()).data);
}
async function login(page, username) {
  await page.goto(base);
  await page.locator('[name=username]').fill(username);
  await page.locator('[name=password]').fill(password);
  const response = page.waitForResponse(r => r.url() === base + '/api/login' && r.request().method() === 'POST');
  await page.locator('button[type=submit]').click();
  assert.equal((await response).status(), 200, 'real role login succeeds');
  await page.locator('#main').waitFor();
  await page.goto(base + '/#operations/work');
  await page.locator('[data-task-id=qa_mine]').waitFor();
}
async function nav(page, role) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const owner = role === 'owner';
  assert.equal(await page.locator('[data-workspace=development]').isVisible(), owner, role + ' development workspace navigation');
  for (const tab of ['expenses', 'tasks', 'ideas', 'devOverview']) {
    assert.equal(await page.locator(`.tab[data-tab=${tab}]`).evaluate(el => !el.hidden), owner, role + ' hidden flag for ' + tab);
  }
  for (const route of ['tasks', 'ideas', 'devOverview']) {
    await page.goto(base + '/#development/' + route);
    await page.waitForFunction(() => window.TSUKENYA_ROLE !== undefined);
    if (owner) {
      await page.locator(route === 'tasks' ? '#newTask' : route === 'ideas' ? '#newIdea' : '#main .stats').waitFor();
    } else {
      await page.getByText('План розвитку доступний власнику мережі.', { exact: true }).waitFor();
      assert.equal(await page.locator('#newTask,#newIdea,#newWork').count(), 0, 'guard contains no development inputs');
      assert.equal(await page.locator('[data-workspace=development]').isVisible(), false);
      assert.equal(await page.locator('#developmentPath').isVisible(), false, 'guard does not show owner development roadmap');
    }
  }
}
(async () => {
  // A occupied port must never redirect fixture mutations into another session.
  try { await fetch(base + '/health'); throw Error('QA port already in use: ' + port); }
  catch (error) { if (!error.cause) throw error; }
  server = spawn(python, ['-m', 'server.main'], { cwd: root, env, stdio: 'ignore' });
  await until(async () => { try { return (await fetch(base + '/health')).ok; } catch { return false; } }, 'isolated server startup');
  execFileSync(python, ['-c', `
import django
django.setup()
from django.contrib.auth.models import User
from server.erp.models import Document, Profile, Store
a=Store.objects.first()
b=Store.objects.create(name='Ізольований магазин B')
for role in ['manager','cashier']:
    u=User.objects.create(username='task-'+role)
    u.set_password('isolated-task-ui-password');u.save()
    Profile.objects.create(user=u,role=role,store=a)
Document.objects.filter(path__startswith='tasks/').delete()
rows=[('qa_mine',{'title':'Своя операційна задача','scope':'operations','store':a.pk}),
      ('qa_foreign',{'title':'Чужа операційна задача','scope':'operations','store':b.pk}),
      ('qa_network',{'title':'Мережева операційна задача','scope':'operations'}),
      ('qa_dev',{'title':'Розвиток тільки власнику','scope':'development','stage':1}),
      ('qa_legacy',{'title':'Старий план тільки власнику','stage':1}),
      ('auto_qa',{'title':'Автоматично перевірити залишок','scope':'operations','store':a.pk,
                  '_alertActive':True,'_alertKey':'low:synthetic','createdAt':'2026-10-03T10:00:00+03:00'})]
for i,(key,value) in enumerate(rows):
    Document.objects.create(path='tasks/'+key,data={**value,'status':'todo','order':i})
Document.objects.update_or_create(path='project/state',defaults={'data':{'stage':1,'nextStep':'Приватний наступний крок'}})
`], { cwd: root, env, stdio: 'pipe' });
  browser = await chromium.launch({ headless: true });
  for (const role of (process.env.QA_ROLE ? process.env.QA_ROLE.split(',') : ['owner', 'manager', 'cashier'])) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = lastPage = await context.newPage();
    page.on('pageerror', error => errors.push(role + ': ' + error.message));
    await page.route('https://fonts.googleapis.com/**', route => route.abort());
    await page.route('https://fonts.gstatic.com/**', route => route.abort());
    await login(page, role === 'owner' ? 'tester' : 'task-' + role);
    const row = id => page.locator(`[data-task-id=${id}]`);
    const checkControls = !process.env.QA_NAV_ONLY && (!process.env.QA_CONTROLS_ROLES || process.env.QA_CONTROLS_ROLES.split(',').includes(role));
    if (checkControls) {
      assert.equal(await row('qa_foreign').count(), role === 'owner' ? 1 : 0);
      assert.equal(await row('qa_dev').count(), 0);
      assert.equal(await row('qa_legacy').count(), 0);
      assert.equal(await row('qa_mine').locator('[data-cycle]').count(), role === 'cashier' ? 0 : 1);
      assert.equal(await row('qa_mine').locator('[data-del-task]').count(), role === 'cashier' ? 0 : 1);
      assert.equal(await row('qa_network').locator('[data-cycle]').count(), role === 'owner' ? 1 : 0);
      assert.equal(await row('qa_network').locator('[data-del-task]').count(), role === 'owner' ? 1 : 0);
      assert.equal(await row('auto_qa').locator('[data-cycle]').count(), role === 'cashier' ? 0 : 1);
      assert.equal(await row('auto_qa').locator('[data-del-task]').count(), 0);
      assert.equal(await page.locator('#newWork').count(), role === 'cashier' ? 0 : 1);
      if (role === 'manager') assert.match(await row('qa_network').innerText(), /Задача мережі · лише перегляд/);
      if (role === 'cashier') assert.match(await row('auto_qa').innerText(), /Системне нагадування · лише перегляд/);
      if (role !== 'cashier') {
        const before = await state(page), prior = before.tasks.find(t => t.id === 'auto_qa').data;
        await row('auto_qa').locator('[data-cycle]').click();
        await until(async () => (await state(page)).tasks.find(t => t.id === 'auto_qa').data.status !== prior.status, 'allowed alert status persisted');
        const after = (await state(page)).tasks.find(t => t.id === 'auto_qa').data;
        const { status: previousStatus, ...previousIdentity } = prior;
        const { status: updatedStatus, ...updatedIdentity } = after;
        assert.notEqual(previousStatus, updatedStatus);
        assert.deepEqual(updatedIdentity, previousIdentity, 'status action never modifies alert identity');
      }
      if (role === 'manager') {
        await page.locator('#newWork').fill('Додано менеджером свого магазину');
        await page.locator('[data-act=addWork]').click();
        await until(async () => (await state(page)).tasks.some(t => t.data.title === 'Додано менеджером свого магазину'), 'manager task persisted');
        const task = (await state(page)).tasks.find(t => t.data.title === 'Додано менеджером свого магазину');
        assert.equal(task.data.scope, 'operations');
        assert.equal(task.data.store, (await state(page)).tasks.find(t => t.id === 'qa_mine').data.store);
        await page.locator(`[data-task-id="${task.id}"]`).waitFor();
        page.once('dialog', dialog => dialog.accept());
        await page.locator(`[data-del-task="${task.id}"]`).click();
        await until(async () => !(await state(page)).tasks.some(t => t.id === task.id), 'manager own manual task deletion persisted');
      }
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), role + ' tasks fit width ' + width);
        await page.screenshot({ path: path.join(os.tmpdir(), `tsukenya-tasks-${role}-${width}.png`), fullPage: true });
      }
    }
    await nav(page, role);
    if (role === 'owner') {
      await page.goto(base + '/#development/tasks');
      await row('qa_dev').waitFor();
      assert.equal(await row('qa_legacy').count(), 1, 'owner sees legacy tasks without scope');
    }
    results.push(role + (checkControls ? ':controls+navigation' : ':navigation'));
    await context.close();
  }
  assert.deepEqual(errors, [], 'no browser runtime errors');
  console.log('TASK SCOPE UI PASS:', results.join(', '), process.env.QA_NAV_ONLY ? '(navigation only)' : '(controls, persistence, 1440/390 layout, direct routes)');
})().catch(async error => {
  console.error(error);
  await lastPage?.screenshot({ path: path.join(os.tmpdir(), 'tsukenya-task-scope-failure.png'), fullPage: true }).catch(() => {});
  process.exitCode = 1;
}).finally(async () => {
  await browser?.close();
  if (server) {
    server.kill('SIGTERM');
    if (server.exitCode === null) await new Promise(resolve => server.once('exit', resolve));
  }
  fs.rmSync(data, { recursive: true, force: true });
});
