import { test, expect } from 'playwright/test';
import AxeBuilder from '@axe-core/playwright';

const story = (name: string) =>
  `/iframe.html?id=${encodeURIComponent('основа-контроли--' + name)}&viewMode=story`;
for (const state of ['default', 'long-name', 'validation-error', 'disabled', 'empty']) {
  test(`${state}: layout, accessibility, visual baseline`, async ({ page }) => {
    await page.goto(story(state));
    const surface = page.locator('.tk-story');
    await expect(surface.locator('.tk-field').first()).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const result = await new AxeBuilder({ page }).include('.tk-story').analyze();
    expect(result.violations).toEqual([]);
    await expect(surface).toHaveScreenshot(`${state}.png`);
  });
}

test('combobox: search, commit, cancel, arrow placement and touch-sized targets', async ({
  page,
}) => {
  await page.goto(story('default'));
  const input = page.getByRole('combobox', { name: 'Товар для перегляду' });
  await input.click();
  await expect(page.getByRole('listbox')).toBeVisible();
  await expect(page.getByRole('option')).toHaveCount(4);
  const group = await page.locator('.tk-combo-group').boundingBox();
  const arrow = await page.locator('.tk-combo-toggle .tk-chevron').boundingBox();
  if (!group || !arrow) throw new Error('Missing combo geometry');
  expect(Math.abs(arrow.y + arrow.height / 2 - group.y - group.height / 2)).toBeLessThan(1);
  expect(group.x + group.width - arrow.x - arrow.width).toBeGreaterThanOrEqual(10);
  const toggle = await page.locator('.tk-combo-toggle').boundingBox();
  expect(toggle?.width).toBeGreaterThanOrEqual(44);
  const bounds = await page.getByRole('listbox').boundingBox();
  if (!bounds) throw new Error('Missing list');
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await expect(page).toHaveScreenshot('combo-open.png');
  await input.fill('Еспресо');
  await expect(page.getByRole('option')).toHaveCount(1);
  await input.press('ArrowDown');
  await input.press('Enter');
  await expect(page.getByText('Вибрано: Еспресо')).toBeVisible();
  await input.fill('товар, якого немає');
  await expect(page.getByText('Нічого не знайдено')).toBeVisible();
  await input.press('Escape');
  await expect(input).toHaveValue('Еспресо');
  await input.fill('невідомий');
  await input.press('Tab');
  await expect(input).toHaveValue('Еспресо');
  const errors = await new AxeBuilder({ page }).include('.tk-story').analyze();
  expect(errors.violations).toEqual([]);
});

test('select: indicator geometry, keyboard selection and focus return', async ({ page }) => {
  await page.goto(story('default'));
  const trigger = page.locator('.tk-select-trigger');
  await trigger.click();
  await expect(page.getByRole('listbox')).toBeVisible();
  const box = await trigger.boundingBox();
  const arrow = await trigger.locator('.tk-chevron').boundingBox();
  if (!box || !arrow) throw new Error('Missing select geometry');
  expect(Math.abs(arrow.y + arrow.height / 2 - box.y - box.height / 2)).toBeLessThan(1);
  expect(box.x + box.width - arrow.x - arrow.width).toBeGreaterThanOrEqual(10);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(trigger).toContainText('Із засічками');
  await expect(trigger).toBeFocused();
  await expect(page.getByRole('listbox')).toHaveCount(0);
});

test('320px, forced colors and 200% text remain usable', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(story('default'));
  await page.emulateMedia({ forcedColors: 'active' });
  await page.addStyleTag({ content: ':root { font-size: 28px; }' });
  await expect(page.getByRole('combobox')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('combobox').click();
  await expect(page.getByRole('listbox')).toBeVisible();
  await page.getByRole('option', { name: 'Еспресо', exact: true }).click();
  await expect(page.getByText('Вибрано: Еспресо')).toBeVisible();
});
