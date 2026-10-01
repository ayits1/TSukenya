/* Called only by the isolated catalogue harness. */
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

module.exports = async (page, until) => {
  await page.getByRole('button', { name: 'Додати товар' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Назва товару' }).fill('Контрольна ціна гривні копійки');
  await dialog.getByText('Задати ціну продажу вручну', { exact: true }).click();
  const hryvnias = dialog.getByRole('textbox', { name: 'Звичайна ціна: гривні', exact: true });
  const kopecks = dialog.getByRole('textbox', { name: 'Звичайна ціна: копійки', exact: true });
  await hryvnias.fill('21');
  await hryvnias.press(',');
  assert(await kopecks.evaluate(input => input === document.activeElement), 'comma moves to kopecks');
  await kopecks.fill('9');
  await kopecks.press('Tab');
  assert.equal(await kopecks.inputValue(), '09', 'single kopeck digit means nine kopecks');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await hryvnias.scrollIntoViewIfNeeded();
    await hryvnias.focus();
    await hryvnias.press('ArrowRight');
    const geometry = await dialog.locator('.tk-money').evaluate(field => {
      const group = field.querySelector('.tk-money-group');
      return {
        overflow: group.scrollWidth > group.clientWidth + 1,
        right: group.getBoundingClientRect().right,
        heights: [...field.querySelectorAll('input')].map(input => input.getBoundingClientRect().height),
        innerOutline: getComputedStyle(field.querySelector('input')).outlineStyle,
        groupOutline: getComputedStyle(group).outlineStyle,
      };
    });
    assert(!geometry.overflow && geometry.right <= width + 1, 'money group fits at ' + width);
    assert(geometry.heights.every(height => height >= 44), 'money inputs retain touch height');
    assert.equal(geometry.innerOutline, 'none');
    assert.equal(geometry.groupOutline, 'solid');
    await dialog.locator('.tk-money').screenshot({ path: path.join(os.tmpdir(), `tsukenya-money-${width}.png`) });
  }
  await dialog.getByText('Акція — окрема ціна та позначка на ціннику', { exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Акційна ціна: гривні', exact: true }).fill('19');
  await dialog.getByRole('textbox', { name: 'Акційна ціна: копійки', exact: true }).fill('99');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    const prices = dialog.locator('fieldset').nth(1);
    await prices.scrollIntoViewIfNeeded();
    const bounds = await prices.locator('.tk-money-group').evaluateAll(groups => groups.map(group => ({ right: group.getBoundingClientRect().right, overflow: group.scrollWidth > group.clientWidth + 1 })));
    assert(bounds.every(group => !group.overflow && group.right <= width + 1), 'both prices fit at ' + width);
    await prices.screenshot({ path: path.join(os.tmpdir(), `tsukenya-promotion-editor-${width}.png`) });
  }

  await dialog.getByRole('button', { name: 'Зберегти товар', exact: true }).click();
  await until(async () => await page.getByRole('dialog').count() === 0, 'split-price save');
  const product = await page.evaluate(async () => {
    const response = await fetch('/api/v1/catalog/products?q=' + encodeURIComponent('Контрольна ціна гривні копійки'));
    return (await response.json()).items[0];
  });
  assert.equal(product.price, '21.09', 'exact decimal persisted by Django');
  assert.equal(product.regularPrice, '21.09', 'server regular price preserved');
  assert.equal(product.promotionPrice, '19.99', 'separate promotional decimal persisted');
  assert.equal(product.salePrice, '19.99', 'promotion is effective sale price');
  await page.getByRole('searchbox', { name: 'Пошук товару' }).fill(product.name);
  await until(async () => await page.locator('.tk-product-link').count() === 1, 'split-price product search');
  assert.match(await page.locator('.tk-product-table del').innerText(), /21,09/, 'regular price stays visible');
  await page.locator('.tk-product-link').click();
  assert.equal(await hryvnias.inputValue(), '21');
  assert.equal(await kopecks.inputValue(), '09');
  assert.equal(await dialog.getByRole('textbox', { name: 'Акційна ціна: гривні', exact: true }).inputValue(), '19');
  assert.equal(await dialog.getByRole('textbox', { name: 'Акційна ціна: копійки', exact: true }).inputValue(), '99');
  await dialog.getByRole('button', { name: 'Закрити редактор' }).click();
  const promotion = page.getByRole('button', { name: 'Акція для ' + product.name, exact: true });
  await promotion.click();
  await until(async () => await promotion.getAttribute('aria-pressed') === 'false', 'promotion disabled');
  const inactive = await page.evaluate(async id => (await (await fetch('/api/v1/catalog/products/' + id)).json()), product.id);
  assert.equal(inactive.salePrice, '21.09', 'disabling promotion restores regular price');
  assert.equal(inactive.promotionPrice, '19.99', 'previous promotion price is retained');
  await promotion.click();
  await dialog.waitFor();
  assert.equal(await dialog.getByRole('textbox', { name: 'Акційна ціна: гривні', exact: true }).inputValue(), '19', 'enabling opens price editor');
  await dialog.getByRole('button', { name: 'Зберегти товар', exact: true }).click();
  await until(async () => await page.getByRole('dialog').count() === 0, 'reviewed promotion re-enabled');
  await page.getByRole('button', { name: 'Скинути фільтри' }).click();
  console.log('PASS: split hryvnias/kopecks, keyboard, one focus ring, 1440/390/320 layout, exact regular 21.09/promotion 19.99 save, reopening, two visible prices and disable/re-enable.');
};
