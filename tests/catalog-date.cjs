/* Calendar mutations run only against the isolated catalogue harness. */
const assert = require('node:assert/strict');

module.exports = async (page, until) => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const previous = new Date(today + 'T12:00:00Z');
  previous.setUTCDate(1); previous.setUTCMonth(previous.getUTCMonth() - 1);
  const selected = previous.toISOString().slice(0, 10);
  await page.getByRole('button', { name: 'Додати товар' }).click();
  const editor = page.getByRole('dialog', { name: 'Новий товар' });
  await editor.getByRole('textbox', { name: 'Назва товару' }).fill('Контрольна дата календаря');
  await editor.getByRole('button', { name: 'Зберегти товар' }).click();
  await until(async () => await editor.count() === 0, 'create date fixture');
  await page.getByRole('searchbox', { name: 'Пошук товару' }).fill('Контрольна дата календаря');
  await until(async () => await page.locator('.tk-product-link').count() === 1, 'date fixture search');
  await page.locator('.tk-product-link').click();
  const form = page.getByRole('dialog', { name: 'Редагувати товар' });
  const trigger = form.getByRole('button', { name: /^Вибрати дату/ });
  await form.getByRole('button', { name: 'Сьогодні', exact: true }).click();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await trigger.click();
    const calendar = page.getByRole('dialog', { name: 'Календар: Дата перевірки ціни', exact: true });
    await calendar.waitFor();
    const bounds = await calendar.evaluate(node => {
      const box = node.getBoundingClientRect();
      const table = node.querySelector('table');
      return { left: box.left, right: box.right, overflow: table.scrollWidth > table.clientWidth + 1 };
    });
    assert(bounds.left >= 0 && bounds.right <= width && !bounds.overflow, 'calendar fits at ' + width + ': ' + JSON.stringify(bounds));
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'page fits at ' + width);
    await calendar.screenshot({ path: '/tmp/tsukenya-calendar-' + width + '.png' });
    await page.keyboard.press('Escape');
    assert.equal(await calendar.count(), 0, 'Escape closes only calendar');
    await until(async () => await trigger.evaluate(button => button === document.activeElement), 'focus returns to date trigger');
  }
  await trigger.click();
  const calendar = page.getByRole('dialog', { name: 'Календар: Дата перевірки ціни', exact: true });
  assert.equal(await calendar.getByRole('button', { name: 'Наступний місяць' }).isDisabled(), true, 'future month disabled');
  assert(await calendar.locator('[data-disabled]').count() > 0, 'future days disabled');
  await calendar.getByRole('button', { name: 'Попередній місяць' }).click();
  await calendar.locator('.tk-calendar-cell:not([data-outside-month])').filter({ hasText: /^1$/ }).click();
  await form.getByRole('button', { name: 'Зберегти товар', exact: true }).click();
  await until(async () => await form.count() === 0, 'save selected calendar date');
  const getProduct = () => page.evaluate(async () => (await (await fetch('/api/v1/catalog/products?q=' + encodeURIComponent('Контрольна дата календаря'))).json()).items[0]);
  assert.equal((await getProduct()).priceAt, selected, 'selected ISO date persisted without timezone shift');
  await page.locator('.tk-product-link').click();
  assert.equal(await form.locator('.tk-date-segment[data-type=day]').innerText(), '01');
  await form.getByRole('button', { name: 'Очистити дату', exact: true }).click();
  await form.getByRole('button', { name: 'Зберегти товар', exact: true }).click();
  await until(async () => await form.count() === 0, 'save cleared date');
  assert.equal((await getProduct()).priceAt, '', 'clearing date persists');
  await page.locator('.tk-product-link').click();
  await form.getByRole('button', { name: 'Сьогодні', exact: true }).click();
  await form.getByRole('button', { name: 'Зберегти товар', exact: true }).click();
  await until(async () => await form.count() === 0, 'save today');
  assert.equal((await getProduct()).priceAt, today, 'today uses Kyiv date');
  await page.getByRole('button', { name: 'Скинути фільтри' }).click();
  console.log('PASS: calendar at 1440/390/320, future dates disabled, Escape/focus, selected ISO persistence, clear and Kyiv today; isolated data only.');
};
