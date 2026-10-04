/* Public controls for the five React finance tabs. No native action dispatch or hidden IDs. */
const assert = require("node:assert/strict");
const tabs = {
  accounts: "Рахунки",
  debts: "Борги",
  advances: "Аванси",
  ledger: "Рух коштів",
  documents: "Документи",
};
const regions = {
  accounts: "Грошові рахунки",
  debts: "Заборгованість",
  advances: "Невикористані аванси",
  ledger: "Рух коштів",
  documents: "Фінансові документи",
};
const kinds = {
  payment: "Платіж / аванс",
  advance_allocation: "Використання авансу",
  payment_refund: "Повернення авансу",
  expense: "Витрата",
  cash_opening: "Початкові кошти",
  debt_opening: "Початкова заборгованість",
  cash_transfer: "Переміщення коштів",
  cash_difference: "Касове розходження",
};
const workspace = (page) => page.locator("[data-react-finance]");
const pager = (page) => workspace(page).locator("[data-finance-pager]");
const status = (page) => pager(page).locator("[data-page-status]");
const region = (page, view) =>
  workspace(page).getByRole("region", { name: regions[view], exact: true });
const create = (page, kind) => {
  assert(kinds[kind], `Unknown finance kind: ${kind}`);
  return workspace(page).getByRole("button", {
    name: "+ " + kinds[kind],
    exact: true,
  });
};
const number = (id) => {
  assert(/^\d+$/.test(String(id)), "Expected document ID");
  return String(id).padStart(6, "0");
};
const debt = (page, id) =>
  workspace(page).getByRole("button", {
    name: "Оплатити борг № " + number(id),
    exact: true,
  });
const advance = (page, action, id) => {
  assert(["allocate", "refund"].includes(action));
  const prefix =
    action === "allocate" ? "Використати аванс № " : "Повернути аванс № ";
  return workspace(page).getByRole(
    "button",
    id === undefined
      ? { name: new RegExp("^" + prefix + "\\d+$") }
      : { name: prefix + number(id), exact: true },
  );
};
async function ready(page, { allowError = false } = {}) {
  await workspace(page).waitFor();
  await page.waitForFunction(() => {
    const host = document.querySelector("[data-react-finance]");
    if (!host) return false;
    const button = [...host.querySelectorAll("button")].find(
      (b) => b.textContent.trim() === "Оновити",
    );
    return (
      button &&
      !button.disabled &&
      ![...host.querySelectorAll("[role=status]")].some((e) =>
        e.textContent.includes("Завантаження фінансів"),
      )
    );
  });
  if (!allowError)
    assert.equal(
      await workspace(page).getByRole("alert").count(),
      0,
      "Finance must load successfully: " + (await workspace(page).innerText()),
    );
}
async function tab(page, view) {
  assert(tabs[view], `Unknown finance tab: ${view}`);
  await ready(page);
  const target = workspace(page).getByRole("tab", {
    name: tabs[view],
    exact: true,
  });
  if ((await target.getAttribute("aria-selected")) !== "true")
    await target.click();
  await ready(page);
  await region(page, view).waitFor();
  return region(page, view);
}
async function search(page, text) {
  await workspace(page)
    .getByRole("textbox", { name: "Пошук", exact: true })
    .fill(text);
  await workspace(page)
    .getByRole("button", { name: "Знайти", exact: true })
    .click();
  await ready(page);
}
async function directory(page, label, query, option) {
  const combo = workspace(page).getByRole("combobox", {
    name: label,
    exact: true,
  });
  await combo.fill(query);
  await page
    .getByRole("option", { name: option, exact: typeof option === "string" })
    .click();
  await ready(page);
}
async function move(page, direction, options) {
  assert(["next", "previous"].includes(direction));
  await pager(page).locator(`[data-page=${direction}]`).click();
  await ready(page, options);
}
async function assertPage(page, current, total) {
  assert.equal(
    await status(page).innerText(),
    `${current} / ${Math.max(1, Math.ceil(total / 30))} · записів ${total}`,
  );
}
module.exports = {
  tabs,
  kinds,
  workspace,
  region,
  pager,
  status,
  create,
  debt,
  advance,
  ready,
  tab,
  search,
  directory,
  move,
  assertPage,
};
