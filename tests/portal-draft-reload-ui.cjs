/* Ordinary task/idea and delete persistence: isolated data, actual portal controls. */
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { spawn, execFileSync } = require("node:child_process"),
  { chromium } = require("playwright");
const root = path.resolve(__dirname, ".."),
  data = fs.mkdtempSync(path.join(os.tmpdir(), "tsukenya-portal-drafts-")),
  out = process.env.QA_PORTAL_DRAFT_OUTPUT || data,
  python = process.env.PYTHON_BIN || "/tmp/tsukenya-review-venv/bin/python",
  port = 18624,
  base = `http://localhost:${port}`,
  password = "isolated-portal-draft-password",
  from = process.env.QA_PORTAL_DRAFT_FROM || "raw";
assert(
  [
    "raw",
    "create",
    "edit",
    "delete",
    "privacy",
    "layout",
    "later",
    "inline",
    "expense-delete",
    "raw-tail",
    "edit-unknown",
    "delete-conflict",
    "opening",
  ].includes(from),
);
fs.mkdirSync(out, { recursive: true });
const env = {
  ...process.env,
  HOST: "127.0.0.1",
  PORT: String(port),
  DATA_DIR: data,
  ERP_DB_PATH: path.join(data, "qa.sqlite3"),
  DJANGO_SETTINGS_MODULE: "server.settings",
  OWNER_USERNAME: "tester",
  DJANGO_SECRET_KEY:
    "isolated-portal-drafts-only-secret-with-at-least-fifty-characters",
};
for (const key of Object.keys(env))
  if (
    key === "DATABASE_URL" ||
    key === "POSTGRES_URL" ||
    key === "TSUKENYA_REQUIRE_POSTGRES" ||
    key.startsWith("DB_") ||
    key.startsWith("PG") ||
    key.startsWith("OWNER_PASSWORD")
  )
    delete env[key];
env.OWNER_PASSWORD_HASH = execFileSync(
  python,
  [
    "-c",
    `from server.auth import hash_password;print(hash_password('${password}'))`,
  ],
  { cwd: root, env, encoding: "utf8" },
).trim();
const log = fs.openSync(path.join(out, "server.log"), "w"),
  server = spawn(python, ["-m", "server.main"], {
    cwd: root,
    env,
    stdio: ["ignore", log, log],
  });
let browser, page;
const scopes = [],
  errors = [],
  writes = [];
const wait = async (fn, label = "condition") => {
  for (let i = 0; i < 200; i++) {
    if (server.exitCode !== null || server.signalCode !== null)
      throw Error("QA server exited");
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("Timed out " + label);
};
const entries = () =>
  page.evaluate(() =>
    Object.keys(sessionStorage)
      .filter((k) => k.startsWith("tsukenya:draft:v1:"))
      .map((k) => JSON.parse(sessionStorage.getItem(k)))
      .filter((r) => r.codec.startsWith("native-portal-")),
  );
const dialog = () => page.locator("dialog.trade-dialog:has(#legacyRecordForm)");
async function restore(index = 0) {
  await page
    .getByRole("button", { name: "Локальні чернетки", exact: true })
    .click();
  const recovery = page.getByRole("dialog", {
    name: "Відновлення локальних чернеток",
  });
  await recovery
    .getByRole("button", { name: "Відновити введення", exact: true })
    .nth(index)
    .click();
  await dialog().waitFor();
  await recovery.waitFor({ state: "detached" });
}
const py = (code) =>
  execFileSync(
    python,
    [
      "-c",
      "import os;os.environ.setdefault('DJANGO_SETTINGS_MODULE','server.settings');import django;django.setup();" +
        code,
    ],
    { cwd: root, env, encoding: "utf8" },
  ).trim();
const api = (endpoint, method = "GET", body) =>
  page.evaluate(
    async ({ endpoint, method, body }) => {
      const s = await window.PortalApi.session();
      const r = await fetch(endpoint, {
        method,
        headers: { "Content-Type": "application/json", "X-CSRF-Token": s.csrf },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: r.status, body: await r.json() };
    },
    { endpoint, method, body },
  );
const post = async (collection, body) => {
  const r = await api("/api/" + collection, "POST", body);
  assert.equal(r.status, 200, JSON.stringify(r));
  return r.body;
};
async function work() {
  await page.goto(base + "/#operations/work");
  await page.locator("#newWork").waitFor();
  await wait(
    () => page.locator("#newWork").isVisible(),
    "authorized inline work",
  );
}
(async () => {
  await wait(async () => {
    try {
      return (await fetch(base + "/health")).ok;
    } catch {
      return false;
    }
  }, "health");
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  page.on("request", (r) => {
    if (
      ["POST", "PATCH", "DELETE"].includes(r.method()) &&
      /\/api\/(tasks|ideas|docs\/(tasks|ideas|expenses))/.test(r.url())
    )
      writes.push({
        method: r.method(),
        url: r.url(),
        body: r.postDataJSON(),
        key: r.headers()["idempotency-key"],
      });
  });
  await require("./browser-login.cjs")(page, base, password);
  if (from === "opening") {
    const idea = await post("ideas", {
      title: "Private opening",
      text: "Existing text",
      reaction: null,
    });
    await page.goto(base + "/#development/ideas");
    await page.evaluate((id) => {
      const real = window.fetch;
      window.qaEntered = false;
      window.fetch = async (url, options) => {
        if (
          String(url).includes("/records/recovery-context?") &&
          String(url).includes("id=" + id)
        ) {
          window.qaEntered = true;
          await new Promise((resolve) => (window.qaRelease = resolve));
          return new Response(
            JSON.stringify({ error: "Old ignored-abort 401" }),
            { status: 401, headers: { "Content-Type": "application/json" } },
          );
        }
        return real(url, options);
      };
    }, idea.id);
    await page
      .locator('[data-legacy-edit=ideas][data-id="' + idea.id + '"]')
      .click();
    await wait(
      () => page.evaluate(() => window.qaEntered),
      "delayed opening context",
    );
    await page.evaluate(() => (location.hash = "#operations/work"));
    await page.locator("#newWork").waitFor({ state: "visible" });
    await page.evaluate(() => window.qaRelease());
    await page.waitForTimeout(100);
    assert.equal(await dialog().count(), 0);
    assert.equal(
      (await page.request.get(base + "/api/v1/session")).status(),
      200,
    );
    assert.equal(writes.filter((w) => w.method !== "POST").length, 0);
    scopes.push(
      "obsolete opening context ignores late401 before decode/private modal insertion; current route and session retained, zero editor writes",
    );
  } else if (from === "raw") {
    await work();
    await page.locator("#newWork").fill("");
    await page.locator("#newWorkDue").fill("2026-11-30");
    await wait(async () => (await entries()).length === 1, "raw persisted");
    const saved = (await entries())[0];
    assert.equal(saved.payload.draft.title, "");
    assert.equal(saved.payload.draft.dueDate, "2026-11-30");
    await page.reload();
    await restore();
    assert.equal(await dialog().locator("[name=title]").inputValue(), "");
    assert.equal(
      await dialog().locator("[name=dueDate]").inputValue(),
      "2026-11-30",
    );
    assert.equal(writes.length, 0);
    scopes.push(
      "invalid empty title/date raw cold restore, zero business writes",
    );
  } else if (from === "create") {
    await work();
    await page.locator("#newWork").fill("Frozen task");
    let posted;
    await page.route("**/api/tasks", async (route) => {
      const r = await route.fetch();
      posted = await r.json();
      assert.equal(r.status(), 200);
      await route.abort("failed");
    });
    await page.locator("[data-act=addWork]").click();
    await wait(
      async () => (await entries())[0]?.payload.firstIntent?.method === "POST",
      "unknown frozen CREATE",
    );
    await wait(
      () => page.locator("[data-portal-exact=addWork]").isVisible(),
      "exact typebutton",
    );
    await page.locator("#newWork").fill("");
    const original = (await entries())[0].payload.firstIntent;
    await page.unroute("**/api/tasks");
    await page.reload();
    await restore();
    assert.equal(await dialog().locator("[name=title]").inputValue(), "");
    let gets = 0;
    await page.route("**/api/v1/portal/records/tasks/" + posted.id, (route) => {
      gets++;
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: "{}",
      });
    });
    await dialog().locator("[data-read]").click();
    await wait(
      async () => !!(await entries())[0]?.payload.confirmation,
      "confirmed identity persisted",
    );
    await wait(
      () => dialog().locator("[data-error]").innerText().then(Boolean),
      "current503",
    );
    assert.equal((await entries())[0].payload.firstIntent, null);
    assert.equal((await entries())[0].payload.confirmation.id, posted.id);
    assert.equal((await entries())[0].payload.baseline.id, null);
    assert.equal(await dialog().locator("[data-exact]").isVisible(), false);
    await page.reload();
    await restore();
    assert.equal(await dialog().locator("[data-exact]").isVisible(), false);
    assert.equal(await dialog().locator("[name=title]").inputValue(), "");
    assert.equal(writes.filter((x) => x.url.endsWith("/api/tasks")).length, 1);
    assert.equal(original.body.title, "Frozen task");
    assert(gets > 0);
    scopes.push(
      "lostACK CREATE frozen key/body, invalid newer raw, identity-before-current503/reload, no repeat CREATE",
    );
  } else if (from === "edit") {
    const created = await post("ideas", {
      title: "Idea",
      text: "Base text",
      reaction: null,
    });
    await page.goto(base + "/#development/ideas");
    await page
      .locator('[data-legacy-edit=ideas][data-id="' + created.id + '"]')
      .waitFor();
    await page
      .locator('[data-legacy-edit=ideas][data-id="' + created.id + '"]')
      .click();
    await dialog().waitFor();
    await dialog().locator("[name=title]").fill("Mine");
    const first = await api("/api/v1/portal/records/ideas/" + created.id);
    await page.evaluate(
      async ({ id, revision }) => {
        const s = await window.PortalApi.session();
        await fetch("/api/docs/ideas/" + id, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "If-Match": revision,
            "X-CSRF-Token": s.csrf,
          },
          body: JSON.stringify({ text: "Server text" }),
        });
      },
      { id: created.id, revision: first.body.revision },
    );
    await dialog().locator("[type=submit]").click();
    await wait(
      async () => !!(await entries())[0]?.payload.firstIntent,
      "UPDATE409",
    );
    await page.reload();
    await restore();
    assert.equal(await dialog().locator("[name=title]").inputValue(), "Mine");
    const before = writes.length;
    await dialog().locator("[data-read]").click();
    await dialog()
      .getByRole("heading", { name: "Узгодити зміни запису" })
      .waitFor();
    await dialog()
      .getByRole("button", { name: "Застосувати узгоджені зміни" })
      .click();
    assert.equal(writes.length, before);
    assert.equal(await dialog().locator("[name=title]").inputValue(), "Mine");
    assert.equal(
      await dialog().locator("[name=text]").inputValue(),
      "Server text",
    );
    await dialog().locator("[type=submit]").click();
    await dialog().waitFor({ state: "detached" });
    assert.equal(
      (await api("/api/v1/portal/records/ideas/" + created.id)).body.data.title,
      "Mine",
    );
    scopes.push(
      "UPDATE409 raw reload, independent shared Apply zero PATCH, separate Save",
    );
  } else if (from === "delete") {
    const task = await post("tasks", {
      title: "Delete task",
      scope: "operations",
      status: "todo",
    });
    await work();
    await page.locator('[data-del-task="' + task.id + '"]').waitFor();
    await page.route("**/api/docs/tasks/" + task.id, async (route) => {
      if (route.request().method() !== "DELETE") return route.continue();
      const r = await route.fetch();
      assert.equal(r.status(), 200);
      await route.abort("failed");
    });
    await page.locator('[data-del-task="' + task.id + '"]').click();
    await dialog().waitFor();
    await wait(
      async () =>
        (await entries())[0]?.payload.firstIntent?.method === "DELETE",
      "unknown DELETE",
    );
    await page.unroute("**/api/docs/tasks/" + task.id);
    await page.reload();
    await restore();
    const before = writes.length;
    await dialog().locator("[data-read]").click();
    await wait(
      async () => (await entries())[0]?.payload.confirmation?.missing === true,
      "readonly absence",
    );
    assert.equal(writes.length, before);
    assert.equal(await dialog().locator("[data-delete]").isDisabled(), true);
    assert.equal(
      (await api("/api/v1/portal/records/tasks/" + task.id)).status,
      409,
    );
    scopes.push(
      "committed DELETE/lostACK/reload→readonly absence, no repeat/no resurrection",
    );
  } else if (from === "raw-tail") {
    await work();
    await page.locator("#newWork").fill("Маршрутна чернетка");
    await page.locator("#newWorkDue").fill("2026-12-31");
    await page.goto(base + "/#development/tasks");
    await page.locator("#newTask").waitFor({ state: "visible" });
    await page.locator("#newTask").fill("");
    await page.locator("#newTaskStage").selectOption("4");
    await wait(async () => (await entries()).length === 2, "development raw");
    await page.goto(base + "/#development/ideas");
    await page.locator("#newIdea").waitFor({ state: "visible" });
    await page.locator("#newIdea").fill("Incomplete idea");
    await page.locator("#newIdea").fill("");
    await wait(async () => (await entries()).length === 3, "idea raw");
    await page.reload();
    const all = await entries();
    assert.equal(
      all.find((e) => e.payload.baseline.entry === "addTask").payload.draft
        .stage,
      "4",
    );
    assert.equal(
      all.find((e) => e.payload.baseline.entry === "addIdea").payload.draft
        .title,
      "",
    );
    for (const entry of ["addIdea", "addTask", "addWork"]) {
      const rows = await entries(),
        index = rows.findIndex((e) => e.payload.baseline.entry === entry);
      await restore(index);
      assert.equal(
        await dialog().locator("[name=title]").inputValue(),
        entry === "addWork" ? "Маршрутна чернетка" : "",
      );
      if (entry === "addTask")
        assert.equal(await dialog().locator("[name=stage]").inputValue(), "4");
      await dialog().locator("[data-close]").click();
      await dialog().waitFor({ state: "detached" });
    }
    await work();
    await wait(
      () =>
        page
          .locator("#newWork")
          .inputValue()
          .then((v) => v === "Маршрутна чернетка"),
      "route preserved inline raw",
    );
    assert.equal(await page.locator("#newWorkDue").inputValue(), "2026-12-31");
    assert.equal(writes.length, 0);
    scopes.push(
      "ordinary development task+idea invalid-title raw reload/explicit Restore; operation inline title/date survive route redraw, zero writes",
    );
  } else if (from === "edit-unknown") {
    const idea = await post("ideas", {
      title: "Unknown update",
      text: "Base",
      reaction: null,
    });
    await page.goto(base + "/#development/ideas");
    await page
      .locator('[data-legacy-edit=ideas][data-id="' + idea.id + '"]')
      .click();
    await dialog().waitFor();
    await dialog().locator("[name=text]").fill("First committed text");
    let lost = false;
    await page.route("**/api/docs/ideas/" + idea.id, async (r) => {
      if (r.request().method() !== "PATCH") return r.continue();
      const response = await r.fetch();
      assert.equal(response.status(), 200);
      await r.abort("failed");
      lost = true;
    });
    await dialog().locator("[type=submit]").click();
    await wait(() => lost, "committed lost update acknowledgement");
    await wait(
      async () => (await entries())[0]?.payload.firstIntent?.method === "PATCH",
      "unknown update",
    );
    await page.unroute("**/api/docs/ideas/" + idea.id);
    await dialog().locator("[name=text]").fill("Newer local text");
    await page.reload();
    await restore();
    const before = writes.length;
    assert.equal(await dialog().locator("[data-exact]").isVisible(), false);
    await dialog().locator("[data-read]").click();
    await dialog()
      .getByRole("heading", { name: "Узгодити зміни запису" })
      .waitFor();
    for (const radio of await dialog()
      .getByRole("radio", { name: "Залишити мої зміни", exact: true })
      .all())
      await radio.press("Space");
    await dialog()
      .getByRole("button", { name: "Застосувати узгоджені зміни" })
      .click();
    assert.equal(writes.length, before);
    assert.equal(
      await dialog().locator("[name=text]").inputValue(),
      "Newer local text",
    );
    await dialog().locator("[type=submit]").click();
    await dialog().waitFor({ state: "detached" });
    assert.equal(
      (await api("/api/v1/portal/records/ideas/" + idea.id)).body.data.text,
      "Newer local text",
    );
    assert.equal(writes.filter((w) => w.method === "PATCH").length, 2);
    scopes.push(
      "committed unknown PATCH+newer raw+reload does not replay; shared explicit mine/Apply zero write; separate fresh-revision Save",
    );
  } else if (from === "delete-conflict") {
    const task = await post("tasks", {
      title: "Observed old delete",
      scope: "operations",
      status: "todo",
    });
    await work();
    await page.locator('[data-del-task="' + task.id + '"]').waitFor();
    py(
      "from server.erp.models import Document;d=Document.objects.get(pk='tasks/" +
        task.id +
        "');d.data['title']='Changed current task';d.save()",
    );
    await page.locator('[data-del-task="' + task.id + '"]').click();
    await dialog().waitFor();
    await wait(
      async () =>
        (await entries())[0]?.payload.firstIntent?.method === "DELETE",
      "delete409",
    );
    await page.reload();
    await restore();
    const before = writes.length;
    await dialog().locator("[data-read]").click();
    await dialog()
      .getByRole("button", { name: "Застосувати узгоджені зміни" })
      .click();
    assert.equal(writes.length, before);
    assert.equal(await dialog().locator("[data-delete]").isEnabled(), true);
    assert.equal(
      (await api("/api/v1/portal/records/tasks/" + task.id)).status,
      200,
    );
    await dialog().locator("[data-delete]").press("Enter");
    await dialog().waitFor({ state: "detached" });
    assert.equal((await entries()).length, 0);
    assert.equal(writes.length, before + 1);
    assert.equal(
      (await api("/api/v1/portal/records/tasks/" + task.id)).status,
      409,
    );
    scopes.push(
      "DELETE409 raw observed revision/reload→current shared comparison; Apply no DELETE; separate explicit fresh-version confirmation only",
    );
  } else if (from === "later") {
    await work();
    await page.locator("#newWork").fill("Frozen first request");
    let original, posted;
    await page.route("**/api/tasks", async (r) => {
      original = r.request().postDataJSON();
      const response = await r.fetch();
      posted = await response.json();
      assert.equal(response.status(), 200);
      await r.abort("failed");
    });
    await page.locator("[data-act=addWork]").click();
    await page.locator("[data-portal-exact=addWork]").waitFor();
    await page.unroute("**/api/tasks");
    await page.locator("#newWork").fill("");
    await page.route("**/api/v1/portal/create-identity?*", (r) =>
      r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          collection: "tasks",
          createKey: r.request().url().split("createKey=")[1],
          confirmed: false,
        }),
      }),
    );
    let retried;
    await page.route("**/api/tasks", (r) => {
      retried = r.request().postDataJSON();
      return r.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: "Isolated later validation refusal" }),
      });
    });
    await page.locator("[data-portal-exact=addWork]").press("Enter");
    await wait(() => !!retried, "later exact retry");
    assert.deepEqual(retried, original);
    await wait(
      async () => !!(await entries())[0]?.payload.firstIntent,
      "original survives later400",
    );
    assert.equal(
      (await entries())[0].payload.firstIntent.key,
      (await entries())[0].payload.baseline.key,
    );
    assert.equal((await entries())[0].payload.draft.title, "");
    assert.equal(await page.locator("[data-act=addWork]").isDisabled(), true);
    await page.unroute("**/api/tasks");
    await page.unroute("**/api/v1/portal/create-identity?*");
    await page.reload();
    await restore();
    await dialog().locator("[data-read]").click();
    await wait(
      async () => !!(await entries())[0]?.payload.confirmation,
      "positive identity",
    );
    assert.equal((await entries())[0].payload.confirmation.id, posted.id);
    assert.equal(writes.filter((w) => w.url.endsWith("/api/tasks")).length, 2);
    scopes.push(
      "lostACK then later400 preserves first UUID/body; exact keyboard retry ignores invalid newer title; readonly identity confirms one created task",
    );
  } else if (from === "privacy") {
    const idea = await post("ideas", {
      title: "Private idea",
      text: "Base",
      reaction: null,
    });
    await page.goto(base + "/#development/ideas");
    await page
      .locator('[data-legacy-edit=ideas][data-id="' + idea.id + '"]')
      .click();
    await dialog().waitFor();
    await dialog().locator("[name=text]").fill("Private raw");
    const before = writes.length;
    await page.evaluate(() => {
      window.__setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k, v) {
        if (k.startsWith("tsukenya:draft:v1:"))
          throw new DOMException("Quota", "QuotaExceededError");
        return window.__setItem.call(this, k, v);
      };
    });
    await dialog().locator("[type=submit]").click();
    await dialog()
      .locator("[data-error]")
      .filter({ hasText: /зберегти чернетку/ })
      .waitFor();
    assert.equal(writes.length, before);
    await page.evaluate(() => (Storage.prototype.setItem = window.__setItem));
    await dialog().locator("[name=text]").fill("Private raw retained");
    const raw = (await entries())[0].payload;
    await page.route("**/api/v1/portal/records/recovery-context?*", (r) =>
      r.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Unavailable current grant" }),
      }),
    );
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await wait(
      () =>
        dialog()
          .locator(".trade-dialog-body")
          .first()
          .evaluate((e) => e.hidden),
      "warm private hide",
    );
    assert.equal(
      await dialog().getByRole("heading").innerText(),
      "Локальна чернетка призупинена",
    );
    assert.deepEqual((await entries())[0].payload, raw);
    await page.unroute("**/api/v1/portal/records/recovery-context?*");
    await dialog().locator("[data-access-retry]").press("Enter");
    await wait(
      () =>
        dialog()
          .locator(".trade-dialog-body")
          .first()
          .evaluate((e) => !e.hidden),
      "public GET retry",
    );
    assert.equal(
      await dialog().locator("[name=text]").inputValue(),
      "Private raw retained",
    );
    assert.equal(writes.length, before);
    // Require an actual fresh role change during the current resource read.
    py(
      "from server.erp.models import Document;d=Document.objects.get(pk='ideas/" +
        idea.id +
        "');d.data['text']='Remote';d.save()",
    );
    await dialog().locator("[type=submit]").click();
    await wait(
      async () => !!(await entries())[0]?.payload.firstIntent,
      "current409",
    );
    await page.route("**/api/v1/portal/records/ideas/" + idea.id, async (r) => {
      py(
        "from django.contrib.auth.models import User;u=User.objects.get(username='tester');u.profile.role='manager';u.profile.save()",
      );
      const response = await r.fetch();
      assert.equal(response.status(), 403);
      await r.fulfill({ response });
    });
    await dialog().locator("[data-read]").click();
    await wait(
      () =>
        dialog()
          .locator(".trade-dialog-body")
          .first()
          .evaluate((e) => e.hidden),
      "actual current403 hide",
    );
    await wait(
      async () => (await entries()).length === 0,
      "changed identity erased",
    );
    scopes.push(
      "quota-before-fetch zero write; same-session warm503 private hide/raw retained/public GET-only retry; actual current role403 hides and clears same-session private draft",
    );
  } else if (from === "layout") {
    const idea = await post("ideas", {
      title: "Ідея з довгою українською назвою для клавіатурного відновлення",
      text: "Первісний опис",
      reaction: null,
    });
    await page.goto(base + "/#development/ideas");
    await page
      .locator('[data-legacy-edit=ideas][data-id="' + idea.id + '"]')
      .press("Enter");
    await dialog().waitFor();
    await dialog().locator("[name=text]").fill("Мій локальний опис");
    py(
      "from server.erp.models import Document;d=Document.objects.get(pk='ideas/" +
        idea.id +
        "');d.data['text']='Чужий довгий опис із поясненням поточного рішення';d.save()",
    );
    await dialog().locator("[type=submit]").press("Enter");
    await wait(
      async () => !!(await entries())[0]?.payload.firstIntent,
      "conflict",
    );
    await page.reload();
    await restore();
    await page.evaluate((id) => {
      const real = window.fetch;
      window.__releaseOld = null;
      window.fetch = (url, init) =>
        String(url).endsWith("/api/v1/portal/records/ideas/" + id)
          ? new Promise((resolve) => {
              window.__releaseOld = () =>
                resolve(
                  new Response(JSON.stringify({ error: "Late old denied" }), {
                    status: 401,
                    headers: { "Content-Type": "application/json" },
                  }),
                );
            })
          : real(url, init);
      window.__restoreFetch = () => (window.fetch = real);
    }, idea.id);
    await dialog().locator("[data-read]").click();
    await wait(
      () => page.evaluate(() => typeof window.__releaseOld === "function"),
      "ignored-abort transport",
    );
    await dialog().locator("[data-close]").click();
    await dialog().waitFor({ state: "detached" });
    await page.evaluate(() => {
      window.__releaseOld();
      window.__restoreFetch();
    });
    await page.waitForTimeout(100);
    assert.equal((await api("/api/v1/session")).status, 200);
    assert.equal((await entries()).length, 1);
    assert.equal(await dialog().count(), 0);
    await restore();
    await dialog().locator("[data-read]").press("Enter");
    await dialog()
      .getByRole("radio", { name: "Залишити мої зміни", exact: true })
      .waitFor();
    const count = writes.length;
    for (const width of [1440, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await dialog()
        .getByRole("heading", { name: "Узгодити зміни запису" })
        .evaluate((e) => e.scrollIntoView({ block: "center" }));
      assert.equal(
        await dialog().evaluate((d) => d.scrollWidth <= d.clientWidth + 1),
        true,
      );
      await page.screenshot({
        path: path.join(out, "comparison-" + width + ".png"),
        fullPage: false,
      });
    }
    await dialog()
      .getByRole("radio", { name: "Залишити мої зміни", exact: true })
      .press("Space");
    await dialog()
      .getByRole("button", { name: "Застосувати узгоджені зміни" })
      .press("Enter");
    assert.equal(writes.length, count);
    assert.equal(
      await dialog().locator("[name=text]").inputValue(),
      "Мій локальний опис",
    );
    py(
      "from server.erp.models import Document;d=Document.objects.get(pk='ideas/" +
        idea.id +
        "');d.data['text']='Second remote edit';d.save()",
    );
    await dialog().locator("[type=submit]").press("Enter");
    await wait(
      async () => !!(await entries())[0]?.payload.firstIntent,
      "second conflict",
    );
    assert.equal(await dialog().locator("[type=submit]").isDisabled(), true);
    assert.equal(
      await dialog().locator("[name=text]").inputValue(),
      "Мій локальний опис",
    );
    scopes.push(
      "late ignored-abort401 after Close cannot invalidate current session/draft; keyboard Restore/atomic field choice/Apply1440+320 no overflow/no PATCH; second409 keeps raw and blocks Save",
    );
  } else if (from === "inline") {
    const task = await post("tasks", {
      title: "Inline task",
      scope: "operations",
      status: "todo",
    });
    await work();
    await page.locator('[data-cycle="' + task.id + '"]').click();
    await wait(
      async () =>
        (await api("/api/v1/portal/records/tasks/" + task.id)).body.data
          .status === "doing",
      "actual inline status PATCH",
    );
    await dialog().waitFor({ state: "detached" });
    const idea = await post("ideas", {
      title: "Inline idea",
      text: "Original",
      reaction: null,
    });
    await page.goto(base + "/#development/ideas");
    await page.locator('[data-react="' + idea.id + '"][data-v=yes]').click();
    await wait(
      async () =>
        (await api("/api/v1/portal/records/ideas/" + idea.id)).body.data
          .reaction === "yes",
      "actual reaction PATCH",
    );
    await dialog().waitFor({ state: "detached" });
    await page.locator('[data-idea-task="' + idea.id + '"]').waitFor();
    await page.locator('[data-idea-task="' + idea.id + '"]').click();
    await wait(
      () =>
        py(
          "from server.erp.models import Document;print(Document.objects.filter(path__startswith='tasks/',data__ideaId='" +
            idea.id +
            "').count())",
        ) === "1",
      "idea→task persisted",
    );
    await wait(
      () =>
        page
          .locator('[data-idea-task="' + idea.id + '"]')
          .count()
          .then((n) => n === 0),
      "linked ordinary task observed",
    );
    const row = writes.find(
      (e) => e.method === "POST" && e.body?.ideaId === idea.id,
    );
    assert.equal(row.body.title, "Inline idea");
    assert.match(row.key, /^[a-f0-9-]{36}$/);
    await dialog().waitFor({ state: "detached" });
    scopes.push(
      "actual task status/idea reaction use enrolled inline PATCH; ordinary idea→task frozen CREATE preserves sourceidea lineage, no managed/initiative bypass",
    );
  } else if (from === "expense-delete") {
    const expense = await post("expenses", {
      name: "Expense delete",
      group: "fixed",
      category: "Інше",
      amount: 42.07,
    });
    await page.goto(base + "/#operations/expenses");
    await page.locator("[data-budget-mode=catalog]").click();
    await page.locator('[data-del-exp="' + expense.id + '"]').waitFor();
    await page.route("**/api/docs/expenses/" + expense.id, async (r) => {
      if (r.request().method() !== "DELETE") return r.continue();
      const response = await r.fetch();
      assert.equal(response.status(), 200);
      await r.abort("failed");
    });
    await page.locator('[data-del-exp="' + expense.id + '"]').click();
    await dialog().waitFor();
    await wait(
      async () =>
        (await entries())[0]?.payload.firstIntent?.method === "DELETE",
      "expense delete intent",
    );
    await page.unroute("**/api/docs/expenses/" + expense.id);
    await page.reload();
    await restore();
    const count = writes.length;
    await dialog().locator("[data-read]").click();
    await wait(
      async () => (await entries())[0]?.payload.confirmation?.missing === true,
      "expense absence",
    );
    assert.equal(writes.length, count);
    assert.equal(
      (await entries())[0].payload.baseline.original.amount,
      "42.07",
    );
    scopes.push(
      "actual expense DELETE/lostACK/raw decimal baseline/reload→readonly absence without repeat, editable expense codec untouched",
    );
  }
  assert.deepEqual(errors, []);
  await page.screenshot({
    path: path.join(out, from + "-1440.png"),
    fullPage: false,
  });
  console.log("PORTAL DRAFT " + from + " PASS " + JSON.stringify(scopes));
  fs.writeFileSync(
    path.join(out, from + "-report.json"),
    JSON.stringify(
      {
        status: "PASS",
        stage: from,
        scopes,
        writes: writes.map((x) => ({ method: x.method, key: x.key })),
        errors,
        browser: "Playwright bundled Chromium headless",
        base: execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: root,
          encoding: "utf8",
        }).trim(),
        inputs: Object.fromEntries(
          [
            "app/portal-draft-recovery.js",
            "app/portal.js",
            "app/legacy-record-editor.js",
            "frontend/src/shared/native/portalPersistence.ts",
            "frontend/dist/.vite/manifest.json",
          ].map((file) => [
            file,
            require("node:crypto")
              .createHash("sha256")
              .update(fs.readFileSync(path.join(root, file)))
              .digest("hex"),
          ]),
        ),
      },
      null,
      2,
    ),
  );
})()
  .catch(async (e) => {
    console.error(e);
    process.exitCode = 1;
    fs.writeFileSync(
      path.join(out, from + "-report.json"),
      JSON.stringify(
        { status: "FAIL", stage: from, scopes, error: e.message },
        null,
        2,
      ),
    );
    if (page) {
      fs.writeFileSync(
        path.join(out, from + "-dom.txt"),
        await page
          .locator("body")
          .innerText()
          .catch(() => ""),
      );
      await page
        .screenshot({
          path: path.join(out, from + "-failure.png"),
          fullPage: false,
        })
        .catch(() => {});
    }
  })
  .finally(async () => {
    await browser?.close();
    if (server.exitCode === null && server.signalCode === null) {
      server.kill("SIGTERM");
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          server.kill("SIGKILL");
          resolve();
        }, 5000);
        server.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    fs.closeSync(log);
    fs.rmSync(data, { recursive: true, force: true });
  });
