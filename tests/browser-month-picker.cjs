/* Drive the real month grid; legacy hidden form values remain the API boundary. */
module.exports = async (page, value) => {
  const names = ['Січень','Лютий','Березень','Квітень','Травень','Червень','Липень','Серпень','Вересень','Жовтень','Листопад','Грудень'];
  const form = page.locator('#monthlyBudgetFilters');
  await form.getByRole('button', { name: /^Місяць / }).click();
  const popup = page.getByRole('dialog', { name: 'Вибір місяця: Місяць' });
  let year = Number(await popup.locator('.tk-month-year strong').innerText());
  const target = Number(value.slice(0, 4));
  if (!Number.isInteger(target) || Math.abs(target - year) > 100) throw Error('Invalid fixture month');
  while (year !== target) {
    await popup.getByRole('button', { name: year < target ? 'Наступний рік' : 'Попередній рік' }).click();
    year += year < target ? 1 : -1;
  }
  await popup.getByRole('option', { name: names[Number(value.slice(5)) - 1], exact: true }).click();
  await popup.waitFor({ state: 'hidden' });
};
