/* Isolated Storybook only: verifies native inert and cancellation with a real Studio draft. */
const assert = require('node:assert/strict');
const {chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 try {
  const page=await browser.newPage({viewport:{width:320,height:900}});
  const url=process.env.PROMOTION_STORYBOOK_URL||'http://127.0.0.1:61117';
  await page.goto(`${url}/iframe.html?id=${encodeURIComponent('цінники-підтверджений-контекст-магазину--interactive-store-recovery')}&viewMode=story`);
  const font=page.getByLabel('Розмір, pt');await font.fill('18');await font.press('Tab');
  await page.getByRole('tab',{name:/Товари для друку/}).click();
  await page.getByLabel('Копій: Кава Американо').fill('7');await page.getByLabel('Копій: Кава Американо').press('Tab');
  await page.getByRole('tab',{name:'Макет',exact:true}).click();
  const heldFont=await font.elementHandle();
  const area=page.locator('.tk-pricing-workspace');
  const choose=async()=>{const select=page.getByRole('button',{name:/Ціни та друк для/});await select.focus();await select.press('Enter');await page.getByRole('listbox').waitFor();await page.keyboard.press('End');await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelector('.tk-pricing-workspace')?.inert===true);};
  const kept=async(store)=>{
   assert(await heldFont.evaluate(el=>el.isConnected&&el.value==='18'),'Studio draft node/font changed');
   assert((await area.textContent()).includes(`Поточний контекст Studio: Обліковий магазин ${store}`),'Unconfirmed context relabelled Studio');
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Horizontal overflow at320px');
  };
  await choose();await kept(1);
  assert(await heldFont.evaluate(el=>{el.focus();return document.activeElement!==el;}),'Native inert allows editor keyboard focus');
  await page.getByRole('button',{name:'Відповісти помилкою магазину'}).click();
  await page.getByRole('alert').filter({hasText:'Магазини тимчасово недоступні'}).waitFor();await kept(1);
  assert(await area.evaluate(el=>el.inert),'Error unblocks editor/print');
  await page.screenshot({path:'/tmp/tsukenya-pricing-context-error-320.png',fullPage:true});
  await page.getByRole('button',{name:'Скасувати зміну магазину'}).click();
  await page.waitForFunction(()=>document.querySelector('.tk-pricing-workspace')?.inert===false);await kept(1);
  await choose();await page.getByRole('button',{name:'Підтвердити магазин 2'}).click();
  await page.waitForFunction(()=>document.querySelector('.tk-pricing-workspace')?.inert===false);await kept(2);
  await page.getByRole('tab',{name:/Товари для друку/}).click();
  assert.equal(await page.getByLabel('Копій: Кава Американо').inputValue(),'7');
  console.log('PASS: confirmed context, 503 native inert/focus, cancel and later successful switch preserve Studio font/layout/selection/copies at320px');
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
