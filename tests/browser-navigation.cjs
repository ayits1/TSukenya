/* Explicit real sidebar navigation. Does not change login state or assume a route succeeds. */
const assert = require('node:assert/strict');

module.exports = async function navigateSidebar(page, tab) {
  assert.match(tab, /^[A-Za-z][A-Za-z0-9]*$/, 'Known sidebar tab identifier');
  const sidebar = page.locator('#portalSidebar');
  const link = sidebar.locator(`a.tab[data-tab="${tab}"]`);
  assert.equal(await link.count(), 1, 'Exactly one actual sidebar link: ' + tab);
  // A collapsed group is distinct from a link denied by the current role.
  assert.equal(await link.evaluate(element => element.hidden), false, 'Role permits sidebar link: ' + tab);
  if (!(await sidebar.isVisible())) {
    const toggle = page.locator('#navToggle');
    assert(await toggle.isVisible(), 'Mobile navigation opener is available');
    await toggle.click();
    await sidebar.waitFor({ state: 'visible' });
  }
  const group = await link.evaluate(element => element.closest('[data-nav-group]')?.dataset.navGroup);
  assert(['operations', 'trade', 'development'].includes(group), 'Actual sidebar group: ' + tab);
  const disclosure = sidebar.locator(`[data-nav-toggle="${group}"]`);
  assert(await disclosure.isVisible(), 'Current role permits sidebar group: ' + group);
  if (await disclosure.getAttribute('aria-expanded') !== 'true') await disclosure.click();
  await link.waitFor({ state: 'visible' });
  // Dirty route guards may cancel this click; callers assert their own expected outcome.
  await link.click();
};
