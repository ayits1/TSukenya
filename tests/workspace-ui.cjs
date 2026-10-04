/* Isolated first-stage design review. Opens a local file and never calls CRM. */
const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {chromium} = require('playwright');
const source = pathToFileURL(path.resolve(__dirname, '../design/workspace.html')).href;

async function geometry(page, context) {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${context}: horizontal overflow`);
  assert.equal(await page.locator('#newProduct').evaluate(node => getComputedStyle(node).color), 'rgb(255, 255, 255)', `${context}: primary button text`);
  const actions = await page.locator('.w-action .ui-button:visible').evaluateAll(nodes => nodes.map(node => ({height: node.getBoundingClientRect().height, target: parseFloat(getComputedStyle(node).getPropertyValue('--ui-control-height')), fits: node.scrollWidth <= node.clientWidth + 1})));
  assert(actions.every(action => action.fits && action.height <= action.target + 1), `${context}: action label clipping/wrapping`);
  const controls = await page.locator('.ui-select:visible').evaluateAll(nodes => nodes.map(node => {
    const style = getComputedStyle(node), canvas = document.createElement('canvas').getContext('2d');
    canvas.font = style.font;
    return {name: node.name, appearance: style.appearance, position: style.backgroundPosition, padding: parseFloat(style.paddingRight), width: node.getBoundingClientRect().width, text: canvas.measureText(node.selectedOptions[0].textContent).width};
  }));
  assert(controls.length, `${context}: selects visible`);
  for (const control of controls) {
    assert.equal(control.appearance, 'none', `${context}/${control.name}: indicator`);
    assert.match(control.position, /12px.*50%/, `${context}/${control.name}: indicator inset`);
    assert.equal(control.padding, 40, `${context}/${control.name}: text gutter`);
    assert(control.text < control.width - 54, `${context}/${control.name}: short option text clipped`);
  }
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage(), errors = [], remote = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {if (/^https?:/.test(request.url())) remote.push(request.url());});
    await page.goto(source);
    for (const theme of ['light', 'dark']) for (const width of [1440, 1024, 768, 390, 320]) {
      await page.setViewportSize({width, height: 1100});
      await page.emulateMedia({colorScheme: theme});
      await geometry(page, `${theme}/${width}`);
      assert.equal(await page.locator('body').evaluate(node => getComputedStyle(node).colorScheme), 'light');
      const heights = await page.locator('#filters input,#filters select').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
      assert(heights.every(height => height === 40), `equal control heights: ${heights}`);
      await page.locator('#search').fill('вода');
      assert.equal(await page.locator('#productRows tr').count(), 1);
      await page.locator('#search').fill('');
      await page.locator('#promotion').selectOption('promo');
      assert.equal(await page.locator('#productRows tr').count(), 2);
      await page.locator('#promotion').selectOption('all');
      await page.locator('#category').selectOption('Печиво');
      assert.equal(await page.locator('#productRows tr').count(), 1);
      await page.locator('#category').selectOption('');
      await page.locator('#search').fill('неіснуючий товар');
      assert(await page.locator('#empty').isVisible());
      await page.locator('#resetFilters').click();
      assert.equal(await page.locator('#productRows tr').count(), 6);
      await page.locator('[data-edit="1"]').click();
      await geometry(page, `${theme}/${width}/dialog`);
      assert(await page.locator('#productForm [name=name]').evaluate(node => document.activeElement === node));
      await page.keyboard.press('Escape');
      assert(!(await page.locator('#editor').isVisible()));
      assert(await page.locator('[data-edit="1"]').evaluate(node => document.activeElement === node));
      if (theme === 'light' && [1440,390,320].includes(width)) await page.screenshot({path: `/tmp/tsukenya-workspace-${width}.png`, fullPage: true});
    }
    // Long data, large money, HTML escaping and focus after replacing the row.
    await page.setViewportSize({width: 1440, height: 1000});
    await page.locator('[data-edit="1"]').click();
    const longName = 'Шоколад з фундуком та карамеллю '.repeat(6) + '<b>без HTML</b>';
    await page.locator('#productForm [name=name]').fill(longName);
    await page.locator('#productForm [name=price]').fill('9999999.99');
    await page.locator('#productForm [type=submit]').click();
    await page.waitForFunction(() => document.activeElement === document.querySelector('[data-edit="1"]'));
    assert.equal(await page.locator('.w-product-name').first().textContent(), longName);
    assert.equal(await page.locator('.w-product-name b').count(), 0);
    assert(await page.locator('[data-edit="1"]').evaluate(node => document.activeElement === node));
    for (const width of [1440,1024,768,390,320]) {
      await page.setViewportSize({width, height: 1100}); await geometry(page, `stress/${width}`);
      assert(await page.locator('.w-price').first().evaluate(node => node.scrollWidth <= node.clientWidth + 1), `large price clipped at ${width}`);
    }
    await page.setViewportSize({width: 390, height: 1000});
    await page.locator('#newProduct').click();
    await page.locator('#productForm [name=name]').fill('Новий товар');
    await page.locator('#productForm [name=pack]').fill('Пакування · 1 шт');
    await page.locator('#productForm [name=cost]').fill('10');
    await page.locator('#productForm [name=price]').fill('15');
    await page.locator('#productForm [name=promo]').check();
    await page.locator('#productForm [type=submit]').click();
    assert.equal(await page.locator('#productRows tr').count(), 7);
    await page.locator('#search').focus(); await page.keyboard.press('Tab');
    assert(await page.locator('#category').evaluate(node => document.activeElement === node));
    assert.notEqual(await page.locator('#category').evaluate(node => getComputedStyle(node).outlineStyle), 'none');
    await page.emulateMedia({forcedColors: 'active'});
    assert.equal(await page.locator('#category').evaluate(node => getComputedStyle(node).appearance), 'auto');
    const touch = await browser.newContext({hasTouch: true, viewport: {width: 320, height: 1000}});
    const mobile = await touch.newPage(); await mobile.goto(source); await geometry(mobile, 'touch/320');
    const targets = await mobile.locator('#filters input,#filters select,#newProduct').evaluateAll(nodes => nodes.map(node => ({width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height})));
    assert(targets.every(target => target.height >= 44 && target.width >= 44), `touch targets: ${JSON.stringify(targets)}`);
    await touch.close();
    assert.deepEqual(errors, []); assert.deepEqual(remote, []);
    console.log('PASS: catalogue/filter/edit/create/empty, long data and large prices, selects/focus, 5 widths, fixed light theme, touch and high contrast. No remote requests.');
  } finally { await browser.close(); }
})().catch(error => {console.error(error); process.exitCode = 1;});
