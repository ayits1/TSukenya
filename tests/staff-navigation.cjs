/* Public React staff tabs/actions; native editors remain real consumers. */
const assert = require("node:assert/strict");
const tabs = {
  employees: "Працівники",
  work: "Табель",
  documents: "Документи",
};
const host = (page) => page.locator("[data-react-staff]");
const status = (page) => host(page).locator("[data-page-status]");
async function ready(page) {
  await host(page).waitFor();
  await page.waitForFunction(() => {
    const h = document.querySelector("[data-react-staff]");
    return (
      h &&
      ![...h.querySelectorAll("[role=status]")].some((x) =>
        x.textContent.includes("Завантаження команди"),
      ) &&
      [...h.querySelectorAll("button")].some(
        (x) => x.textContent.trim() === "Оновити" && !x.disabled,
      )
    );
  });
  assert.equal(
    await host(page).getByRole("alert").count(),
    0,
    "Staff read succeeded: " + (await host(page).innerText()),
  );
}
async function tab(page, view) {
  assert(tabs[view]);
  await ready(page);
  const target = host(page).getByRole("tab", { name: tabs[view], exact: true });
  if ((await target.getAttribute("aria-selected")) !== "true")
    await target.press("Enter");
  await ready(page);
  return host(page);
}
const create = (page) =>
  host(page).getByRole("button", { name: "Відмітити зміну", exact: true });
const edit = (page, id) =>
  host(page).getByRole("button", {
    name: new RegExp("^Редагувати табель № " + id + " "),
  });
const employee = (page, name) =>
  host(page).getByRole("button", {
    name: "Редагувати працівника: " + name,
    exact: true,
  });
const addEmployee = (page) =>
  host(page).getByRole("button", { name: "Додати працівника", exact: true });
const payroll = (page, kind = "payroll") =>
  host(page).getByRole("button", {
    name:
      "+ " +
      {
        payroll: "Нарахування зарплати",
        payroll_payment: "Виплата зарплати / аванс",
      }[kind],
    exact: true,
  });
async function openCreate(page) {
  await tab(page, "work");
  await create(page).click();
}
async function openEdit(page, id) {
  await tab(page, "work");
  await edit(page, id).click();
}
async function openEmployee(page, name) {
  await tab(page, "employees");
  await employee(page, name).click();
}
async function assertPage(page, current, total) {
  assert.equal(
    await status(page).innerText(),
    `${current} / ${Math.max(1, Math.ceil(total / 30))} · записів ${total}`,
  );
}
const dateField = (page, label) =>
  host(page)
    .locator(".tk-date")
    .filter({ has: page.getByText(label, { exact: true }) });
async function setDate(page, label, iso) {
  const [year, month, day] = iso.split("-");
  for (const [type, value] of [
    ["year", year],
    ["month", month],
    ["day", day],
  ]) {
    const segment = dateField(page, label).locator(
      '.tk-date-segment[data-type="' + type + '"]',
    );
    await segment.focus();
    await segment.press("ControlOrMeta+A");
    await segment.pressSequentially(value);
  }
  await dateField(page, label)
    .locator(".tk-date-segment[data-type=day]")
    .press("Tab");
}
async function assertDate(page, label, iso) {
  const [year, month, day] = iso.split("-");
  for (const [type, value] of [
    ["year", year],
    ["month", month],
    ["day", day],
  ])
    assert.equal(
      Number(
        await dateField(page, label)
          .locator('.tk-date-segment[data-type="' + type + '"]')
          .innerText(),
      ),
      Number(value),
      label + " committed ISO " + type,
    );
}
async function nativeEmployee(page, id, name) {
  const dialog = page.locator(".trade-dialog[open]");
  const input = dialog.getByRole("combobox", {
    name: "Працівник",
    exact: true,
  });
  await input.fill(name);
  const option = page.getByRole("option", {
    name: new RegExp(" · №" + id + "$"),
  });
  await option.waitFor();
  await option.click();
  assert.equal(
    await dialog.locator("select[name=employee]").inputValue(),
    String(id),
    "Committed employee ID enters native FormData",
  );
}
module.exports = {
  nativeEmployee,
  dateField,
  setDate,
  assertDate,
  host,
  status,
  ready,
  tab,
  create,
  edit,
  employee,
  addEmployee,
  payroll,
  openCreate,
  openEdit,
  openEmployee,
  assertPage,
};
