/* Standalone choices and dependent catalogue selection against isolated Django only. */
const assert = require('node:assert/strict');
const readReferences=require('./reference-pages.cjs');

module.exports = async (page, until) => {
  await page.getByRole('button', { name: 'Додати товар' }).click();
  const form = page.getByRole('dialog', { name: 'Новий товар' });
  const combo = label => form.getByRole('combobox', { name: label, exact: true });
  await until(async () => await combo('Група').isEnabled(), 'references loaded');
  assert(await combo('Категорія').isDisabled(), 'category requires parent');
  assert.equal(await combo('Одиниця').inputValue(), 'шт');
  await form.getByRole('textbox', { name: 'Назва товару' }).fill('Контрольний товар довідників');
  await combo('Група').fill('Довільний текст пошуку');
  await page.getByRole('listbox').waitFor();await page.getByText('Нічого не знайдено',{exact:true}).waitFor();
  await combo('Група').press('Escape');await form.getByRole('textbox', { name: 'Назва товару' }).click();
  assert.equal(await combo('Група').inputValue(), '', 'search text does not become a reference');
  async function add(label, value) {
    await form.getByRole('button', { name: 'Додати запис: ' + label, exact: true }).click();
    const input = form.getByRole('textbox', { name: 'Новий запис: ' + label, exact: true });
    assert(await form.getByRole('button', { name: 'Зберегти товар', exact: true }).isDisabled(), 'product cannot submit while adding reference');
    await input.fill(value);await input.press('Enter');
    await until(async () => await input.count() === 0 && await combo(label).inputValue() === value, 'created reference selected: ' + label);
    await until(async () => await form.getByRole('button', { name: 'Додати запис: ' + label, exact: true }).evaluate(node => node === document.activeElement), 'focus returns to ' + label);
  }
  await add('Група', 'Група QA');
  await add('Категорія', 'Категорія QA');
  await add('Пакування', 'Пакування QA');
  await add('Об’єм / вага', '0,5 л QA');
  await add('Одиниця', 'уп QA');
  await add('Група', 'Друга QA');
  assert.equal(await combo('Категорія').inputValue(), '', 'changing parent clears old category');
  await combo('Категорія').click();
  assert.equal(await page.getByRole('option', { name: 'Категорія QA', exact: true }).count(), 0, 'category from another group excluded');
  await page.keyboard.press('Escape');
  await add('Категорія', 'Категорія QA');
  await combo('Група').fill('Група QA');await page.getByRole('option',{name:'Група QA',exact:true}).waitFor();await combo('Група').press('ArrowDown');await combo('Група').press('Enter');
  assert.equal(await combo('Група').inputValue(), 'Група QA', 'keyboard selection commits group');
  await combo('Категорія').click();const categoryOption=page.getByRole('listbox').getByRole('option').filter({hasText:'Категорія QA'});await categoryOption.waitFor();assert.equal(await categoryOption.count(),1);await categoryOption.click();
  await form.getByRole('button', { name: 'Додати запис: Пакування', exact: true }).click();
  await form.getByRole('textbox', { name: 'Новий запис: Пакування', exact: true }).fill('Чернетка');
  await page.keyboard.press('Escape');
  assert.equal(await form.count(), 1, 'Escape cancels only inline creation');
  await until(async () => await form.getByRole('button', { name: 'Додати запис: Пакування', exact: true }).evaluate(node => node === document.activeElement), 'cancel restores add button focus');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });await form.getByRole('button', { name: /Відкрити список: Група/ }).click();
    await page.getByRole('listbox').waitFor();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const bounds = await page.getByRole('listbox').evaluate(node => { const b = node.getBoundingClientRect(); return { left: b.left, right: b.right }; });
    assert(bounds.left >= 0 && bounds.right <= width, 'options fit at ' + width);
    const geometry = await combo('Група').evaluate(input => {
      const group = input.closest('.tk-combo-group'), button = group.querySelector('button');
      const gb = group.getBoundingClientRect(), bb = button.getBoundingClientRect();
      return { inner: getComputedStyle(input).outlineStyle, outer: getComputedStyle(group).outlineStyle, arrowInside: bb.right <= gb.right && bb.height >= 44 };
    });
    assert.equal(geometry.inner, 'none');assert.equal(geometry.outer, 'solid');assert(geometry.arrowInside);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'editor fits at ' + width);
    await page.screenshot({ path: '/tmp/tsukenya-reference-editor-' + width + '.png' });
    await page.keyboard.press('Escape');
  }
  await form.getByRole('button', { name: 'Зберегти товар', exact: true }).click();
  await until(async () => await form.count() === 0, 'save dictionary-backed product');
  const result = await page.evaluate(async () => ({

    product: (await (await fetch('/api/v1/catalog/products?q=' + encodeURIComponent('Контрольний товар довідників'))).json()).items[0],
  }));
  result.references=await readReferences(page);
  assert.equal(result.product.type, 'Група QA');assert.equal(result.product.category, 'Категорія QA');
  assert.equal(result.product.pack, 'Пакування QA');assert.equal(result.product.size, '0,5 л QA');assert.equal(result.product.unit, 'уп QA');
  assert.equal(result.references.items.filter(item => item.field === 'category' && item.value === 'Категорія QA').length, 2, 'same category label independently scoped');
  await page.getByRole('searchbox', { name: 'Пошук товару' }).fill(result.product.name);
  await until(async () => await page.locator('.tk-product-link').count() === 1, 'saved reference product search');
  await page.locator('.tk-product-link').click();
  const editor = page.getByRole('dialog', { name: 'Редагувати товар' });
  assert.equal(await editor.getByRole('combobox', { name: 'Категорія', exact: true }).inputValue(), 'Категорія QA');
  page.once('dialog', dialog => dialog.accept());await editor.getByRole('button', { name: 'Видалити товар', exact: true }).click();
  await until(async () => await editor.count() === 0, 'delete source product');
  const items = (await readReferences(page)).items;
  assert(items.some(item => item.field === 'pack' && item.value === 'Пакування QA'), 'standalone choice survives deletion');
  await page.getByRole('button', { name: 'Скинути фільтри' }).click();
  console.log('PASS: explicit reference creation/selection, dependent categories, keyboard/Enter/Escape/focus, five fields, 1440/390/320 and persistent choices after source deletion; isolated data only.');
};
