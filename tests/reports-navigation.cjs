/* Public React Reports controls. Business requests stay in the actual mounted workspace. */
const assert = require("node:assert/strict");
const modes = {
  period: "Обороти періоду",
  balances: "Залишки на дату",
  abc: "ABC товарів",
};
const titles = {
  products: "Товари",
  by_store: "Магазини",
  expenses_by_category: "Статті витрат",
  cashiers: "Касири",
  stock: "Товарні залишки",
  cash: "Кошти",
  debts: "Історичні борги",
  advances: "Аванси",
  payroll_debts: "Борги із зарплати",
};
const host = (page) => page.locator("[data-react-reports]");
const form = (page) => host(page).locator("[data-report-form]");
const rows = (page) =>
  host(page).locator(
    ".reports-table-wrap:not(.reports-debts .reports-table-wrap)",
  );
const currentDebts = (page) =>
  host(page).locator("[data-report-current-debts]");
const sectionRegion = (page, key) =>
  host(page).getByRole("region", { name: titles[key], exact: true });
const dateField = (page, label) =>
  form(page)
    .locator(".tk-date")
    .filter({ has: page.getByText(label, { exact: true }) });
async function ready(page, { allowError = false } = {}) {
  await host(page).waitFor();
  await form(page).waitFor();
  await page.waitForFunction(
    () =>
      document
        .querySelector("[data-report-form]")
        ?.getAttribute("aria-busy") === "false",
  );
  if (!allowError)
    assert.equal(
      await host(page).locator("[data-report-error]").count(),
      0,
      "Reports read succeeded: " + (await host(page).innerText()),
    );
}
async function mode(page, key) {
  assert(modes[key]);
  const target = host(page).getByRole("tab", { name: modes[key], exact: true });
  if ((await target.getAttribute("aria-selected")) !== "true")
    await target.click();
  if (key !== "abc") await ready(page);
  return host(page);
}
async function section(page, key) {
  assert(titles[key]);
  await ready(page);
  const target = host(page).locator("[data-report-section=" + key + "]");
  if ((await target.getAttribute("aria-selected")) !== "true")
    await target.click();
  await ready(page);
  return sectionRegion(page, key);
}
async function date(page, label, iso) {
  assert(/^\d{4}-\d{2}-\d{2}$/.test(iso), "Expected ISO date");
  const [year, month, day] = iso.split("-");
  for (const [type, value] of [
    ["year", year],
    ["month", month],
    ["day", day],
  ]) {
    const segment = dateField(page, label).locator(
      ".tk-date-segment[data-type=" + type + "]",
    );
    await segment.focus();
    await segment.press("ControlOrMeta+A");
    await segment.pressSequentially(value);
  }
  await dateField(page, label)
    .locator(".tk-date-segment[data-type=day]")
    .press("Tab");
}
async function iso(page, label) {
  const values = [];
  for (const type of ["year", "month", "day"])
    values.push(
      (
        await dateField(page, label)
          .locator(".tk-date-segment[data-type=" + type + "]")
          .innerText()
      ).trim(),
    );
  return (
    values[0].padStart(4, "0") +
    "-" +
    values[1].padStart(2, "0") +
    "-" +
    values[2].padStart(2, "0")
  );
}
async function assertDate(page, label, value) {
  assert.equal(
    await iso(page, label),
    value,
    label + " keeps committed ISO date",
  );
}
async function apply(page) {
  await form(page)
    .getByRole("button", { name: "Показати", exact: true })
    .click();
  await ready(page);
}
const csv = (page, section = false) =>
  host(page).getByRole("link", {
    name: section ? "CSV усієї секції" : /^(CSV підсумків|CSV усіх залишків)$/,
  });
const pager = (page) => host(page).locator("[data-report-pager]");
async function move(page, direction, { allowError = false } = {}) {
  assert(["next", "previous"].includes(direction));
  await pager(page)
    .getByRole("button", {
      name: direction === "next" ? "Наступна" : "Попередня",
      exact: true,
    })
    .click();
  await ready(page, { allowError });
}
async function debtsReady(page) {
  await currentDebts(page).waitFor();
  await page.waitForFunction(() => {
    const h = document.querySelector("[data-report-current-debts]");
    return (
      h &&
      ![...h.querySelectorAll("[role=status]")].some((e) =>
        e.textContent.includes("Завантаження боргів"),
      )
    );
  });
}
async function captureOptions(page) {
  await ready(page);
  await page.evaluate(() => {
    const original = window.ReactReports.mount;
    window.ReactReports.mount = function (host, options) {
      window.__reportsCompatOptions = options;
      return original.call(this, host, options);
    };
    window.Trade.mount("reports", true);
  });
  await ready(page);
  await page.waitForFunction(() => !!window.__reportsCompatOptions);
}
module.exports = {
  captureOptions,
  modes,
  titles,
  host,
  form,
  rows,
  currentDebts,
  sectionRegion,
  dateField,
  ready,
  mode,
  section,
  date,
  iso,
  assertDate,
  apply,
  csv,
  pager,
  move,
  debtsReady,
};
