/* Targeted synthetic Storybook layout proof. Requires the local Storybook dev server. */
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const url = process.env.PROMOTION_STORYBOOK_URL || 'http://127.0.0.1:61117';
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  try {
    const page = await browser.newPage({ viewport: { width: 320, height: 900 } });
    const story = async (id) => page.goto(`${url}/iframe.html?id=${encodeURIComponent(id)}&viewMode=story`);
    const noOverflow = async () => assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Horizontal page overflow');
    await story('каталог-акції-з-періодом--revision-conflict-preserves-draft');
    await page.getByText('Актуальні умови недоступні. Чернетку збережено.').waitFor();
    const combo = page.getByRole('combobox', { name: 'Додати товар акції' });
    await combo.fill('Шоколад');
    await page.getByRole('option').first().waitFor();
    await combo.press('ArrowDown'); await combo.press('Enter');
    await page.getByRole('button', { name: 'Додати вибраний товар' }).click();
    await noOverflow();
    const date = page.getByRole('button', { name: /Вибрати дату/ }).first();
    await date.focus(); await date.press('Enter');
    await page.getByRole('dialog', { name: 'Календар: Початок акції' }).waitFor();
    await noOverflow();
    await page.keyboard.press('Escape');
    await page.waitForFunction(el => el === document.activeElement, await date.elementHandle());
    const select = page.getByRole('button', { name: /Де діє акція/ });
    await select.focus(); await select.press('Enter'); await page.getByRole('listbox').waitFor(); await page.keyboard.press('Escape');
    await page.waitForFunction(el => el === document.activeElement, await select.elementHandle());
    assert(await select.evaluate(el => { const r=el.getBoundingClientRect(), c=el.querySelector('.tk-chevron').getBoundingClientRect(); return Math.abs((r.top+r.bottom)/2-(c.top+c.bottom)/2)<=1 && c.right<=r.right-8; }), 'Select arrow is outside reserved centered space');
    await page.screenshot({ path: '/tmp/tsukenya-promotions-320.png', fullPage: true });
    await page.setViewportSize({width:1280,height:900}); await noOverflow();
    await page.setViewportSize({width:320,height:900});
    await story('цінники-контекст-ціни-магазину--late-proof-cannot-cross-stores');
    await page.locator('.tk-studio-proof-pages').waitFor();
    await page.waitForFunction(() => document.querySelector('.tk-studio-proof-pages')?.textContent.includes('Обліковий магазин 2'));
    assert(!(await page.locator('.tk-studio-proof-pages').textContent()).includes('Обліковий магазин 1'));
    await noOverflow();
    await page.screenshot({path:'/tmp/tsukenya-label-context-320.png',fullPage:true});
    console.log('PASS: 320/1280 layout, long product/store labels, calendar/select keyboard focus and arrow geometry, late proof store isolation');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
