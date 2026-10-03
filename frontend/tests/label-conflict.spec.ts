import { expect, test } from 'playwright/test';

test.use({ viewport: { width: 320, height: 844 } });

test('label comparison keeps long values and keyboard choices usable at 320px', async ({
  page,
}) => {
  await page.goto(
    '/iframe.html?id=' +
      encodeURIComponent('цінники-порівняння-конфлікту--failed-read-and-cancel-preserve-draft') +
      '&viewMode=story',
  );
  // The synthetic story first proves a failed GET and cancellation retain the draft.
  const compare = page.getByRole('button', { name: 'Порівняти зміни', exact: true });
  await expect(compare).toBeFocused();
  await compare.click();
  const heading = page.getByRole('heading', { name: 'Порівняння макетів цінника' });
  await expect(heading).toBeFocused();
  const panel = page.locator('.tk-conflict');
  await expect(panel).toContainText(
    'Магазин з дуже довгою українською назвою на центральній площі',
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(
    await panel
      .locator('dl')
      .first()
      .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length),
  ).toBe(1);
  const bounds = await heading.boundingBox();
  const tabs = await page.locator('.tk-studio-tabs').boundingBox();
  expect(bounds!.y).toBeGreaterThanOrEqual(tabs!.y + tabs!.height);
  for (const choice of await panel.locator('.react-aria-Radio').all())
    expect((await choice.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  const apply = page.getByRole('button', { name: 'Застосувати узгоджені зміни' });
  await expect(apply).toBeDisabled();
  await page.keyboard.press('Tab');
  await expect(panel.getByRole('radio', { name: 'Залишити мої зміни' })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(panel.getByRole('radio', { name: 'Взяти зміни сервера' })).toBeChecked();
  await expect(apply).toBeEnabled();
  await page.getByRole('button', { name: 'Повернутися до чернетки' }).click();
  await expect(compare).toBeFocused();
  await expect(page.getByLabel('Розмір, pt')).toHaveValue('18');
});
