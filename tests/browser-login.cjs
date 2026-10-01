/* Login through the real form, with useful failures for isolated browser suites. */
const assert = require('node:assert/strict');
module.exports = async function login(page, base, password) {
  const errors = [];
  const onError = error => errors.push(error.message);
  page.on('pageerror', onError);
  try {
    await page.goto(base);
    await page.locator('[name=username]').fill('tester');
    await page.locator('[name=password]').fill(password);
    const responsePromise = page.waitForResponse(response => response.url() === base + '/api/login' && response.request().method() === 'POST');
    await page.locator('button[type=submit]').click();
    const response = await responsePromise;
    // Successful login immediately navigates away; do not wait for its body after navigation.
    if (response.status() !== 200) {
      assert.fail('Isolated login rejected: ' + await response.text());
    }
    await page.waitForSelector('#main .stats').catch(async error => {
      const visible = await page.locator('body').innerText();
      throw new Error('Portal startup after login: ' + visible.slice(0, 1200) + '; JS: ' + errors.join('; '), { cause: error });
    });
  } finally {
    page.off('pageerror', onError);
  }
};
