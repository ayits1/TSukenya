/* Invoked by catalog-ui.cjs against its own temporary database and local server. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

module.exports = async (page, until) => {
  const artifacts = path.join(os.tmpdir(), 'tsukenya-editor-next-proof');
  fs.mkdirSync(artifacts, { recursive: true });
  const editor = page.getByRole('dialog');
  const preview = editor.locator('.tk-editor-price-preview');
  const save = editor.getByRole('button', { name: 'Зберегти товар', exact: true });
  const requests = [];
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (['POST', 'PATCH', 'DELETE'].includes(request.method()) && /^\/api\/v1\/catalog\/products(?:\/[A-Za-z0-9_-]+)?$/.test(pathname) && !pathname.endsWith('/price-preview')) requests.push({ method: request.method(), path: pathname, body: request.postDataJSON() });
  });
  const ready = () => until(async () => await save.isEnabled(), 'current price preview');
  const read = (id) => page.evaluate(async (key) => (await (await fetch('/api/v1/catalog/products/' + key)).json()), id);
  const competing = (id, changes) => page.evaluate(async ({ key, fields }) => {
    const csrf = (await (await fetch('/api/v1/session')).json()).csrf;
    const current = await (await fetch('/api/v1/catalog/products/' + key)).json();
    const response = await fetch('/api/v1/catalog/products/' + key, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ ...fields, revision: current.revision }) });
    if (!response.ok) throw new Error('Isolated competing edit: ' + await response.text());
  }, { key: id, fields: changes });
  const geometry = async (label) => {
    const measurements = [];
    for (const width of [1440, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      const scope = await editor.locator('.tk-conflict').count() ? editor.locator('.tk-conflict') : preview;
      await scope.scrollIntoViewIfNeeded();
      const result = await editor.evaluate((element) => ({ document: document.documentElement.scrollWidth <= innerWidth + 1, dialog: element.scrollWidth <= element.clientWidth + 1, targets: [...element.querySelectorAll('.tk-conflict-actions button,.tk-conflict-choices label')].map((el) => el.getBoundingClientRect().height) }));
      assert(result.document && result.dialog, label + ' fits at ' + width);
      assert(result.targets.every((height) => height >= 44), label + ' touch targets at ' + width);
      measurements.push({ width, ...result });
      await scope.screenshot({ path: path.join(artifacts, `${label}-${width}.png`) });
    }
    return measurements;
  };

  await page.getByRole('button', { name: 'Додати товар' }).click();
  await editor.getByRole('textbox', { name: 'Назва товару' }).fill('B28 B29 контрольний ізольований товар');
  await editor.getByRole('textbox', { name: 'Закупівля: гривні', exact: true }).fill('10');
  await editor.getByRole('textbox', { name: 'Закупівля: копійки', exact: true }).fill('01');
  await ready();
  assert.match(await preview.innerText(), /13,50 грн/);
  let release, delayedStarted = false;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route('**/api/v1/catalog/products/price-preview', async (route) => {
    if (route.request().postDataJSON().markup === '40') {
      delayedStarted = true;
      const response = await route.fetch();
      await gate;
      await route.fulfill({ response }).catch(() => {}); // Aborted reads must not revive an older preview.
    } else await route.continue();
  });
  const markup = editor.getByRole('textbox', { name: 'Націнка, %' });
  await markup.fill('40');
  await until(async () => delayedStarted, 'delayed preview request');
  assert(!await save.isEnabled());
  assert.equal(await preview.locator('strong').count(), 0, 'pending preview hides previous result');
  await markup.fill('50'); await ready();
  assert.match(await preview.innerText(), /15,50 грн/);
  release(); await page.unroute('**/api/v1/catalog/products/price-preview');
  await page.waitForTimeout(50);
  assert.match(await preview.innerText(), /15,50 грн/);
  const manual = editor.getByRole('checkbox', { name: 'Задати ціну продажу вручну' });
  await manual.focus(); await page.keyboard.press('Space');
  assert.equal(await editor.getByRole('textbox', { name: 'Звичайна ціна: копійки', exact: true }).inputValue(), '50', 'first manual price uses current preview');
  await editor.getByRole('textbox', { name: 'Звичайна ціна: копійки', exact: true }).fill('05');
  await manual.focus(); await page.keyboard.press('Space'); await ready(); await manual.focus(); await page.keyboard.press('Space');
  assert.equal(await editor.getByRole('textbox', { name: 'Звичайна ціна: копійки', exact: true }).inputValue(), '05', 'manual draft retains kopecks');
  await editor.getByRole('checkbox', { name: 'Акція — окрема ціна та позначка на ціннику' }).focus(); await page.keyboard.press('Space');
  await editor.getByRole('textbox', { name: 'Акційна ціна: гривні', exact: true }).fill('12');
  await editor.getByRole('textbox', { name: 'Акційна ціна: копійки', exact: true }).fill('05'); await ready();
  assert.match(await preview.innerText(), /15,05 грн/); assert.match(await preview.innerText(), /12,05 грн/);
  assert.equal(requests.length, 0, 'preview and editing create no product writes');
  const previewGeometry = await geometry('price-preview');
  await save.click(); await until(async () => await editor.count() === 0, 'price save');
  const product = await page.evaluate(async () => (await (await fetch('/api/v1/catalog/products?q=' + encodeURIComponent('B28 B29 контрольний ізольований товар'))).json()).items[0]);
  assert.deepEqual([product.cost, product.price, product.regularPrice, product.promotionPrice, product.salePrice], ['10.01', '15.05', '15.05', '12.05', '12.05']);
  assert.equal(typeof requests[0].body.pricingRevision, 'string');
  await page.getByRole('searchbox', { name: 'Пошук товару' }).fill(product.name);
  await until(async () => await page.locator('.tk-product-link').count() === 1, 'created product');
  await page.locator('.tk-product-link').click(); await ready();
  const chosenPack = (await require('./reference-pages.cjs')(page)).items.find(item=>item.field==='pack' && item.value).value;
  const pack = editor.getByRole('combobox', { name: 'Пакування', exact: true });
  await pack.fill(chosenPack); await page.getByRole('option', { name: chosenPack, exact: true }).click();
  await competing(product.id, { name: 'B29 змінено на сервері' }); await save.click();
  await page.getByRole('button', { name: 'Порівняти зміни', exact: true }).click();
  await page.getByRole('heading', { name: 'Порівняти зміни', exact: true }).waitFor();
  const beforeApply = requests.length;
  const mergeGeometry = await geometry('independent-merge');
  await page.getByRole('button', { name: 'Застосувати узгоджені зміни' }).click();
  assert.equal(requests.length, beforeApply, 'comparison apply makes no server mutation');
  assert.equal(await pack.inputValue(), chosenPack); assert.equal(await editor.getByRole('textbox', { name: 'Назва товару' }).inputValue(), 'B29 змінено на сервері');
  await ready(); await save.click(); await until(async () => await editor.count() === 0, 'merged product save');
  const merged = await read(product.id); assert.equal(merged.pack, chosenPack); assert.equal(merged.name, 'B29 змінено на сервері');
  await page.getByRole('searchbox', { name: 'Пошук товару' }).fill(merged.name);
  await until(async () => await page.locator('.tk-product-link').count() === 1, 'renamed product search');
  await page.locator('.tk-product-link').click(); await ready();
  await editor.getByRole('textbox', { name: 'Звичайна ціна: копійки', exact: true }).fill('07'); await ready();
  await competing(product.id, { price: '16.09' }); await save.click();
  await page.getByRole('button', { name: 'Порівняти зміни', exact: true }).click();
  const apply = page.getByRole('button', { name: 'Застосувати узгоджені зміни' });
  await apply.waitFor(); assert(!await apply.isEnabled(), 'same price conflict requires explicit choice');
  const conflictGeometry = await geometry('price-conflict');
  await page.getByRole('button', { name: 'Повернутися до чернетки' }).click();
  await until(async () => await page.getByRole('button', { name: 'Порівняти зміни', exact: true }).evaluate((button) => button === document.activeElement), 'cancel focus return');
  assert.equal(await editor.getByRole('textbox', { name: 'Звичайна ціна: копійки', exact: true }).inputValue(), '07');
  await page.keyboard.press('Enter'); await apply.waitFor();
  await page.getByRole('radio', { name: 'Залишити мої зміни' }).focus(); await page.keyboard.press('Space');
  assert(await apply.isEnabled()); const beforeChoice = requests.length; await apply.click();
  assert.equal(requests.length, beforeChoice); await ready();
  await competing(product.id, { barcode: 'B29-SECOND-CONFLICT' }); await save.click();
  await page.getByRole('button', { name: 'Порівняти зміни', exact: true }).waitFor();
  assert.equal(await editor.getByRole('textbox', { name: 'Звичайна ціна: копійки', exact: true }).inputValue(), '07', 'repeated 409 retains chosen local price');
  await page.getByRole('button', { name: 'Порівняти зміни', exact: true }).click(); await apply.waitFor(); await apply.click(); await ready(); await save.click();
  await until(async () => await editor.count() === 0, 'save after repeated conflict');
  const final = await read(product.id); assert.equal(final.price, '15.07'); assert.equal(final.barcode, 'B29-SECOND-CONFLICT');
  fs.writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify({ previewGeometry, mergeGeometry, conflictGeometry, previewSaveParity: true, firstManualFromPreview: true, manualKopecksPreserved: true, stalePreviewIgnored: true, independentMerge: true, explicitPriceChoice: true, cancelFocus: true, repeatedConflict: true, noMutationOnPreviewOrApply: true }, null, 2));
  console.log('PASS: authoritative price preview/save, async freshness, kopecks, catalogue conflict comparison, repeated 409, keyboard/focus and 1440/320 geometry. Artifacts: ' + artifacts);
};
