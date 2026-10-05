import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { CatalogFacet } from './CatalogFacet';
import type { FacetApi, Filters } from './api';

const loadFacets: FacetApi = async (_filters, field, q, page, signal) => {
  await new Promise((resolve) => setTimeout(resolve, 10));
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (q === 'помилка') throw new Error('Контрольна помилка читання');
  const matches = values.filter((v) =>
    v.toLocaleLowerCase('uk-UA').includes(q.toLocaleLowerCase('uk-UA')),
  );
  const pages = Math.max(1, Math.ceil(matches.length / 30));
  const actual = Math.min(page, pages);
  return {
    contract: 'catalog-facets-v1',
    field,
    q,
    items: matches.slice((actual - 1) * 30, actual * 30),
    total: matches.length,
    page: actual,
    pages,
    limit: 30,
  };
};

const values = Array.from({ length: 65 }, (_, n) => `Група ${String(n).padStart(3, '0')}`);
function PagedFacet() {
  const [value, setValue] = useState('Група 064');
  const [filters, setFilters] = useState<Filters>({
    q: '',
    type: value,
    category: '',
    pack: '',
    promotion: '',
    page: 1,
    limit: 20,
  });
  return (
    <div style={{ width: 'min(100%, 380px)' }}>
      <CatalogFacet
        label="Група"
        allLabel="Усі групи"
        field="type"
        filters={filters}
        value={value}
        load={loadFacets}
        onChange={(next) => {
          setValue(next);
          setFilters({ ...filters, type: next });
        }}
      />
      <p>Підтверджено: {value || 'усі групи'}</p>
    </div>
  );
}
const meta = {
  title: 'Catalogue/Посторінковий фільтр',
  component: PagedFacet,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof PagedFacet>;
export default meta;
type Story = StoryObj<typeof meta>;
export const SearchPagingCancelAndCommit: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement),
      page = within(document.body);
    const input = canvas.getByRole('combobox', { name: 'Група' });
    await expect(input).toHaveValue('Група 064');
    await userEvent.click(canvas.getByRole('button', { name: /^Відкрити список: Група/ }));
    await page.findByRole('option', { name: 'Група 000' });
    // The shared control may pin the committed caption outside this server page;
    // it is not an extra matching server result or a replacement for paging.
    await expect(input).toHaveValue('Група 064');
    await expect(page.getByRole('status')).toHaveTextContent('Сторінка 1 із 3 · знайдено 65');
    await userEvent.click(page.getByRole('button', { name: 'Наступні значення: Група' }));
    await page.findByRole('option', { name: 'Група 030' });
    await expect(input).toHaveFocus();
    await userEvent.click(page.getByRole('button', { name: 'Наступні значення: Група' }));
    await page.findByRole('option', { name: 'Група 060' });
    await userEvent.clear(input);
    await userEvent.type(input, '062');
    await page.findByRole('option', { name: 'Група 062' });
    await userEvent.keyboard('{Escape}');
    await expect(input).toHaveValue('Група 064');
    await expect(canvas.getByText('Підтверджено: Група 064')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: /^Відкрити список: Група/ }));
    await userEvent.clear(input);
    await userEvent.type(input, '062');
    await page.findByRole('option', { name: 'Група 062' });
    await userEvent.keyboard('{ArrowDown}{Enter}');
    await waitFor(() => expect(input).toHaveValue('Група 062'));
    await expect(canvas.getByText('Підтверджено: Група 062')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: /^Відкрити список: Група/ }));
    await userEvent.click(page.getByRole('button', { name: 'Усі групи' }));
    await waitFor(() => expect(canvas.getByText('Підтверджено: усі групи')).toBeVisible());
    await expect(input).toHaveAttribute('placeholder', 'Усі групи');
    await expect(input).toHaveValue('');
    await userEvent.clear(input);
    await userEvent.type(input, 'помилка');
    await page.findByText('Контрольна помилка читання');
    await expect(page.getByRole('button', { name: 'Повторити читання' })).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await expect(input).toHaveValue('');
  },
};
