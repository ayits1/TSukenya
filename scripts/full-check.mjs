// Explicit full regression entrypoint. Ordinary development uses targeted checks.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stages = [
  'React: types, lint, format, API tests, synchronization, builds, Storybook, Linux visual comparison',
  'Django: all server tests on disposable PostgreSQL, including concurrency',
  'Current portal: React catalogue conflicts, Label Studio and printing',
  'Current CRM: trading workflows, payroll, document and shift browsing',
  'Current layout: Chromium, including browser zoom',
  'Current layout: WebKit',
  'Standalone workspace prototype',
];
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--plan') || args.length > 1) {
  console.error('Usage: npm run test:full [-- --plan]');
  process.exit(2);
}
stages.forEach((stage, index) => console.log(`${index + 1}. ${stage}`));
if (args.includes('--plan')) {
  console.log('Plan only: no tests, containers, downloads or database connections.');
  process.exit(0);
}

// Never inherit a database connection, data directory or owner account from a deployment shell.
const isolatedEnv = { ...process.env };
for (const key of ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD',
  'DATABASE_URL', 'DATA_DIR', 'ERP_DB_PATH', 'OWNER_USERNAME', 'OWNER_PASSWORD_HASH',
  'DJANGO_SETTINGS_MODULE', 'DJANGO_SECRET_KEY', 'QA_CUSTOMERS_ARTIFACT_DIR', 'QA_BROWSER', 'QA_ZOOM_ONLY', 'QA_LAYOUT_ONLY', 'QA_FILTERS_ONLY',
  'QA_PORT', 'QA_BUSINESS_AUDIT_ONLY', 'QA_ORDER_RESERVES_ONLY', 'QA_INITIATIVES_ONLY', 'QA_REFERENCE_MANAGEMENT_ONLY', 'QA_EDITOR_NEXT_ONLY', 'QA_REFERENCES_ONLY', 'QA_DATE_ONLY', 'QA_PRICE_ONLY', 'QA_NATIVE_ONLY', 'QA_BROWSE_ONLY', 'QA_SHIFT_BROWSE_ONLY', 'QA_FINANCE_ONLY', 'QA_FINANCE_FROM', 'QA_AUTH_ONLY', 'QA_TRADE_ONLY', 'QA_UX_ONLY',
  'QA_LINE_LAYOUT_ONLY', 'QA_LINE_LAYOUT_WIDTHS', 'QA_LINE_LAYOUT_PORT', 'LINE_LAYOUT_PROOF_DIR',
  'QA_BUDGET_PERIOD_ONLY', 'QA_BUDGET_PERIOD_FROM', 'QA_BUDGET_PERIOD_PORT', 'BUDGET_PERIOD_PROOF_DIR',
  'QA_DIRECTORY_TOOLBAR_FROM', 'QA_DIRECTORY_TOOLBAR_ONLY', 'QA_DIRECTORY_TOOLBAR_PORT', 'DIRECTORY_TOOLBAR_PROOF_DIR', 'QA_DOCUMENT_LAYOUT_PORT', 'QA_RUNTIME_FROM', 'QA_DRAFT_FROM', 'QA_NATIVE_DRAFT_FROM', 'QA_WORK_DRAFT_FROM', 'QA_RECIPE_DRAFT_FROM', 'QA_CATEGORY_DRAFT_FROM', 'QA_MONTHLY_DRAFT_FROM', 'QA_TEMPLATE_DRAFT_FROM', 'QA_SALES_FROM', 'QA_SALES_PORT', 'SALES_PROOF_DIR', 'QA_PURCHASES_FROM', 'QA_PURCHASES_PORT', 'PURCHASES_PROOF_DIR', 'QA_REACT_STOCK_FROM', 'QA_REACT_STOCK_PORT', 'REACT_STOCK_PROOF_DIR', 'QA_ALERTS_FROM', 'QA_COLLECTIONS_FROM', 'QA_SCHEMA_SETTINGS', 'QA_SCHEMA_FROM', 'QA_RANGE_TAIL', 'QA_RANGE_ENLARGED', 'QA_PRICING_FROM', 'QA_SETTINGS_FROM', 'QA_SETTINGS_PORT', 'QA_IMPORT_FROM', 'QA_OUTPUT_FROM', 'QA_RECIPES_FROM', 'QA_PRODUCTION_FROM', 'QA_AUDIT_DETAILS_FROM', 'QA_ROLE', 'QA_NAV_ONLY', 'QA_CONTROLS_ROLES', 'QA_RECOVERY_FROM', 'QA_TRADE_FROM', 'QA_BROWSE_FROM', 'QA_CAPTURE_FROM', 'QA_CAPTURE_RESUME', 'QA_ENTITY_OPEN_ONLY', 'QA_CONFLICT_LAYOUT_ONLY',
  'DIRECTORIES_FROM', 'DIRECTORIES_PROOF_DIR', 'QA_ARTIFACTS', 'QA_OUTPUT_DIR', 'QA_PORT', 'WORK_CONFLICT_FROM', 'WORK_SHIFTS_PROOF_DIR', 'QA_REPORT_FROM', 'QA_ABC_FROM', 'QA_ABC_PORT', 'QA_REPORT_DATE_TAIL', 'REPORT_QA_OUTPUT', 'QA_LEGACY_MAIN_ONLY', 'QA_LEGACY_INLINE_ONLY', 'QA_LEGACY_INPUT_ONLY', 'QA_LEGACY_ACK_ONLY', 'QA_LEGACY_LAYOUT_ONLY', 'QA_RECIPE_READ_ONLY', 'QA_RECIPE_VALIDATION_ONLY', 'QA_RECIPE_LAYOUT_ONLY', 'QA_RECIPE_ACK_ONLY', 'QA_RECIPE_ROLE_ACK_ONLY', 'QA_RECIPE_COMPAT_ONLY', 'QA_RECIPE_COMPAT_FROM', 'QA_RECIPE_PAGING_ONLY', 'TEMPLATE_STAGE', 'TEMPLATE_PROOF_DIR', 'TEMPLATE_QA_PORT', 'ENTITY_CREATE_STAGE', 'LEGACY_CREATE_STAGE', 'LEGACY_CREATE_FROM', 'QA_HIDDEN_STAGE', 'QA_OUTPUT', 'MONTHLY_PLAN_STAGE', 'MONTHLY_PLAN_PROOF_DIR', 'VOUCHER_QA_FROM', 'VOUCHER_NORMALIZATION_FROM', 'VOUCHER_PROOF_DIR', 'CHROME_PATH']) {
  delete isolatedEnv[key];
}
isolatedEnv.DJANGO_SECRET_KEY = 'isolated-full-check-only-secret-with-more-than-fifty-characters';
const python = process.env.PYTHON_BIN || (existsSync(join(root, '.venv/bin/python')) ? join(root, '.venv/bin/python') : 'python3');
let current;
let interrupted = false;
const report = { startedAt: new Date().toISOString(), status: 'running', stages: [] };

function stopChild(child, signal = 'SIGTERM') {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) { if (error.code !== 'ESRCH') throw error; }
}

function run(command, commandArgs, { env = isolatedEnv, capture = false, timeout = 30 * 60_000 } = {}) {
  return new Promise((accept, reject) => {
    if (interrupted) return reject(new Error('Interrupted; no further stages will run.'));
    const child = spawn(command, commandArgs, { cwd: root, env, detached: process.platform !== 'win32', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    current = child;
    let output = '', errors = '';
    if (capture) {
      child.stdout.on('data', data => { output += data; });
      child.stderr.on('data', data => { errors += data; });
    }
    let killTimer;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      stopChild(child);
      killTimer = setTimeout(() => stopChild(child, 'SIGKILL'), 5000);
    }, timeout);
    child.once('error', error => { clearTimeout(timer); clearTimeout(killTimer); current = undefined; reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer); clearTimeout(killTimer); current = undefined;
      if (code === 0 && !timedOut && !interrupted) accept(output.trim());
      else reject(new Error(`${command} failed (${timedOut ? 'timeout' : signal || code}). ${errors.trim()}`));
    });
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  interrupted = true;
  const child = current;
  stopChild(child);
  if (child) {
    const timer = setTimeout(() => stopChild(child, 'SIGKILL'), 5000);
    child.once('close', () => clearTimeout(timer));
  }
});

async function stage(index, action) {
  console.log(`\n=== ${stages[index]} ===`);
  const entry = { name: stages[index], status: 'running' };
  report.stages.push(entry);
  try { await action(); entry.status = 'passed'; }
  catch (error) { entry.status = 'failed'; throw error; }
}

let data;
const postgresName = `tsukenya-full-check-${randomUUID()}`;
let postgresStarted = false;
async function removePostgres() {
  if (!postgresStarted) return;
  try { await run('docker', ['rm', '-f', '-v', postgresName], { capture: true, timeout: 15_000 }); }
  catch (error) {
    // A failed/interrupted docker run may not have created its named container.
    if (!error.message.includes('No such container')) throw error;
  }
  postgresStarted = false;
}
try {
  // Fail before the expensive run when a prerequisite is missing.
  await run('docker', ['info', '--format', '{{.ServerVersion}}'], { capture: true, timeout: 15_000 });
  await run(python, ['-c', 'import django, psycopg'], { capture: true, timeout: 15_000 });
  const { chromium, webkit } = await import('playwright');
  if (!existsSync(chromium.executablePath()) || !existsSync(webkit.executablePath())) {
    throw new Error('Install local browsers first: npm exec -- playwright install chromium webkit');
  }
  data = mkdtempSync(join(tmpdir(), 'tsukenya-full-check-'));
  const browserEnv = { ...isolatedEnv, PYTHON_BIN: python };
  await stage(0, () => run('bash', ['scripts/frontend-qa.sh', 'check']));
  await stage(1, async () => {
    postgresStarted = true;
    await run('docker', ['run', '-d', '--rm', '--name', postgresName,
      '-p', '127.0.0.1::5432', '-e', 'POSTGRES_DB=tsukenya_test',
      '-e', 'POSTGRES_USER=tsukenya_test', '-e', 'POSTGRES_PASSWORD=isolated-full-check',
      'postgres:18-alpine'], { capture: true });
    const binding = await run('docker', ['port', postgresName, '5432/tcp'], { capture: true });
    const match = /^127\.0\.0\.1:(\d+)$/.exec(binding);
    if (!match) throw new Error('Unexpected PostgreSQL binding; refused to connect.');
    let ready = false;
    for (let attempt = 0; attempt < 60 && !interrupted; attempt++) {
      try {
        await run('docker', ['exec', postgresName, 'pg_isready', '-U', 'tsukenya_test'], { capture: true, timeout: 5_000 });
        ready = true; break;
      } catch {
        if (interrupted) break;
        await new Promise(accept => setTimeout(accept, 1000));
      }
    }
    if (!ready) throw new Error('Disposable PostgreSQL did not become ready.');
    const databaseEnv={ ...isolatedEnv, DATA_DIR: data, ERP_DB_PATH: join(data, 'unused.sqlite3'),
      DB_HOST: '127.0.0.1', DB_PORT: match[1], DB_NAME: 'tsukenya_test',
      DB_USER: 'tsukenya_test', DB_PASSWORD: 'isolated-full-check' };
    // pg_isready may see the image's temporary initialization server before the TCP server is ready.
    await run(python, ['-c', `import os,time,psycopg
for attempt in range(100):
 try:
  with psycopg.connect(host=os.environ['DB_HOST'],port=os.environ['DB_PORT'],dbname=os.environ['DB_NAME'],user=os.environ['DB_USER'],password=os.environ['DB_PASSWORD'],connect_timeout=2) as c:
   with c.cursor() as cur:cur.execute('SELECT 1');cur.fetchone()
  break
 except psycopg.OperationalError:time.sleep(.3)
else:raise RuntimeError('Disposable PostgreSQL TCP startup failed')`], { env: databaseEnv, timeout: 45_000 });
    await run(python, ['manage.py', 'test', 'tests', '--noinput'], { env: databaseEnv });
  });
  await removePostgres();
  await stage(2, async () => {
    await run('node', ['tests/promotion-legacy.cjs']);
    await run('node', ['tests/monthly-budget-decimal.cjs']);
    await run('node', ['tests/financial-scope-ui.cjs']);
    await run('node', ['tests/reconciliation-contract.cjs']);
    await run('node', ['tests/bounded-reports-contract.cjs']);
    await run('node', ['tests/settlement-reads.cjs']);
    await run('node', ['tests/cashier-csv.cjs'], { env: browserEnv });
    await run('node', ['tests/catalog-import-parser.cjs']);
    await run('node', ['scripts/generate-catalog-schema.mjs', '--check']);
    await run('node', ['tests/catalog-schema.cjs']);
    await run('node', ['tests/catalog-schema-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/catalog-import-jobs.cjs']);
    await run('node', ['tests/catalog-import-recovery.cjs']);
    await run('node', ['tests/catalog-pricing-read-cancel.cjs']);
    await run('node', ['tests/csv-format.cjs']);
    await run('node', ['tests/csv-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/catalog-pricing-contract.cjs']);
    await run('node', ['tests/catalog-pricing-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/portal-metadata-contract.cjs']);
    await run('node', ['tests/portal-validator.cjs']);
    await run('node', ['tests/portal-collections.cjs']);
    await run('node', ['tests/managed-alerts-bounded.cjs']);
    await run('node', ['tests/portal-collections-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/portal-collections-ui.cjs'], { env: { ...browserEnv, QA_COLLECTIONS_FROM: 'tail' } });
    await run('node', ['tests/portal-collections-ui.cjs'], { env: { ...browserEnv, QA_COLLECTIONS_FROM: 'managed' } });
    await run('node', ['tests/portal-collections-ui.cjs'], { env: { ...browserEnv, QA_COLLECTIONS_FROM: 'summary' } });
    await run('node', ['tests/portal-collections-ui.cjs'], { env: { ...browserEnv, QA_COLLECTIONS_FROM: 'development' } });
    await run('node', ['tests/runtime-recovery.cjs']);
    await run('node', ['tests/runtime-create-key.cjs']);
    await run('node', ['tests/legacy-create-identity.cjs']);
    await run('node', ['tests/runtime-managed-refresh.cjs']);
    await run('node', ['tests/runtime-conditional.cjs']);
    await run('node', ['tests/runtime-recovery-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/runtime-create-key-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/runtime-conditional-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/managed-alerts-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/managed-alerts-ui.cjs'], { env: { ...browserEnv, QA_ALERTS_FROM: 'read' } });
    await run('node', ['tests/managed-alerts-ui.cjs'], { env: { ...browserEnv, QA_ALERTS_FROM: 'uncertain' } });
    await run('node', ['tests/catalog-import-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/catalog-import-ui.cjs'], { env: { ...browserEnv, QA_IMPORT_FROM: 'cancel' } });
    await run('node', ['tests/catalog-import-ui.cjs'], { env: { ...browserEnv, QA_IMPORT_FROM: 'contract' } });
    await run('node', ['tests/catalog-import-jobs-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/catalog-import-jobs-ui.cjs'], { env: { ...browserEnv, QA_IMPORT_FROM: 'read-recovery' } });
    await run('node', ['tests/import-worker-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/catalog-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/catalog-ui.cjs'], { env: { ...browserEnv, QA_EDITOR_NEXT_ONLY: '1' } });
    await run('node', ['tests/catalog-ui.cjs'], { env: { ...browserEnv, QA_REFERENCE_MANAGEMENT_ONLY: '1' } });
    await run('node', ['tests/catalog-facets-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/catalog-hidden-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/catalog-hidden-ui.cjs'], { env: { ...browserEnv, QA_HIDDEN_STAGE: 'tail' } });
    await run('node', ['tests/catalog-hidden-ui.cjs'], { env: { ...browserEnv, QA_HIDDEN_STAGE: 'layout' } });
    await run('node', ['tests/labels-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/labels-ui.cjs'], { env: { ...browserEnv, QA_NAV_ONLY: '1' } });
    await run('node', ['tests/price-label-handoff-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/receipt-catalog-review-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/receipt-catalog-recovery-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/receipt-catalog-context-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/price-label-handoff-tail-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/price-label-context-race-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/labels-output-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/portal-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/portal-metadata-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/legacy-records-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/catalogue-range-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/budget-break-even-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/budget-template-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/monthly-budget-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/monthly-budget-recovery-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/monthly-budget-conflict-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/template-draft-reload-ui.cjs'], { env: browserEnv });
    for (const templateStage of ['privacy', 'guard', 'recovery', 'cancel', 'review', 'review-resource', 'review-opening']) {
      await run('node', ['tests/template-draft-reload-ui.cjs'], { env: { ...browserEnv, QA_TEMPLATE_DRAFT_FROM: templateStage } });
    }
    await run('node', ['tests/monthly-draft-reload-ui.cjs'], { env: browserEnv });
    for (const monthlyStage of ['update', 'privacy', 'validation', 'policy', 'session', 'existing', 'preflight', 'send', 'response', 'write403']) {
      await run('node', ['tests/monthly-draft-reload-ui.cjs'], { env: { ...browserEnv, QA_MONTHLY_DRAFT_FROM: monthlyStage } });
    }
    await run('node', ['tests/category-draft-reload-ui.cjs'], { env: browserEnv });
    for (const categoryStage of ['policy', 'privacy', 'validation', 'identityBarrier', 'reviewFence', 'preflightIdentity']) {
      await run('node', ['tests/category-draft-reload-ui.cjs'], { env: { ...browserEnv, QA_CATEGORY_DRAFT_FROM: categoryStage } });
    }
    await run('node', ['tests/planning-category-recovery-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/planning-category-recovery-ui.cjs', '--scope-only'], { env: browserEnv });
    await run('node', ['tests/planning-category-recovery-ui.cjs', '--ack-repeat-only'], { env: browserEnv });
  });
  await stage(3, async () => {
    await run('node', ['tests/crm-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/voucher-conflict-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/entity-create-recovery-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/customers-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/bounded-stock-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/react-stock-ui.cjs'], { env: browserEnv });
    for (const stockStage of ['scope', 'control-late', 'comparison-policy']) {
      await run('node', ['tests/react-stock-ui.cjs'], { env: { ...browserEnv, QA_REACT_STOCK_FROM: stockStage } });
    }
    await run('node', ['tests/bounded-directories-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/directory-empty-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/directory-toolbar-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/bounded-reports-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/abc-reports-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/abc-reports-ui.cjs'], { env: { ...browserEnv, QA_ABC_FROM: 'layout' } });
    await run('node', ['tests/reconciliation-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/work-shift-conflict-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/workshift-draft-reload-ui.cjs'], { env: browserEnv });
    for (const workShiftStage of ['policy', 'conflict']) {
      await run('node', ['tests/workshift-draft-reload-ui.cjs'], { env: { ...browserEnv, QA_WORK_DRAFT_FROM: workShiftStage } });
    }
    await run('node', ['tests/ui-audit.cjs'], { env: { ...browserEnv, QA_ORDER_RESERVES_ONLY: '1' } });
    await run('node', ['tests/ui-audit.cjs'], { env: { ...browserEnv, QA_INITIATIVES_ONLY: '1' } });
    await run('node', ['tests/initiative-conflict-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/entity-conflict-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/production-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/payments-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/payments-ui.cjs', '--failure-only'], { env: browserEnv });
    await run('node', ['tests/ui-audit.cjs'], { env: { ...browserEnv, QA_BROWSE_ONLY: '1' } });
    await run('node', ['tests/ui-audit.cjs'], { env: { ...browserEnv, QA_SHIFT_BROWSE_ONLY: '1' } });
    await run('node', ['tests/ui-audit.cjs'], { env: { ...browserEnv, QA_FINANCE_ONLY: '1' } });
    await run('node', ['tests/label-toolbar-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/expense-layout-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/expenses-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/task-scope-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/erp-recovery-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/draft-revision-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/draft-persistence-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/draft-persistence-ui.cjs'], { env: { ...browserEnv, QA_DRAFT_FROM: 'dismiss' } });
    await run('node', ['tests/native-draft-reload-ui.cjs'], { env: browserEnv });
    for (const draftStage of ['barriers', 'cold', 'production', 'validation', 'postDraft', 'opening']) {
      await run('node', ['tests/native-draft-reload-ui.cjs'], { env: { ...browserEnv, QA_NATIVE_DRAFT_FROM: draftStage } });
    }
    // Includes both actual recipe editors and explicit reload/receipt/privacy scopes.
    await run('node', ['tests/recipes-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/replenish-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/react-purchases-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/react-sales-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/assortment-drafts-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/erp-settings-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/erp-date-boundary-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/reports-date-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/multilot-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/multilot-ui.cjs', '--origins-only'], { env: browserEnv });
    await run('node', ['tests/audit-details-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/ui-audit.cjs'], { env: { ...browserEnv, QA_BUSINESS_AUDIT_ONLY: '1' } });
  });
  await stage(4, async () => {
    await run('node', ['tests/layout-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/erp-document-layout-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/erp-line-layout-ui.cjs'], { env: browserEnv });
    await run('node', ['tests/budget-period-ui.cjs'], { env: browserEnv });
  });
  await stage(5, () => run('node', ['tests/layout-ui.cjs'], { env: { ...browserEnv, QA_BROWSER: 'webkit' } }));
  await stage(6, () => run('node', ['tests/workspace-ui.cjs'], { env: browserEnv }));
  report.status = 'passed';
  console.log('\nFull check passed. Each stage ran once.');
} catch (error) {
  report.status = interrupted ? 'interrupted' : 'failed';
  console.error(error.message);
  process.exitCode = 1;
} finally {
  // Permit cleanup even after an interrupt. Remove only this invocation's container.
  interrupted = false;
  if (postgresStarted) {
    try { await removePostgres(); }
    catch { console.error(`Cleanup failed; remove the test container: ${postgresName}`); process.exitCode = 1; report.status = 'failed'; }
  }
  if (data) rmSync(data, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  mkdirSync(join(root, 'test-results'), { recursive: true });
  writeFileSync(join(root, 'test-results/full-check.json'), JSON.stringify(report, null, 2) + '\n');
}
