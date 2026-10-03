import { useEffect, useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { Button } from './Button';
import { TextField } from './TextField';
import { ComboBox } from './ComboBox';
import type { Choice } from './Select';
import { products, searchableProducts } from '../../features/component-lab/fixtures';

import { Controls } from '../../features/component-lab/Controls';

/** Synthetic stand-in for catalogue search: every word may match the name, or a barcode prefix. */
function serverMatches(text: string): Choice[] {
  const words = text.toLocaleLowerCase('uk-UA').split(/\s+/).filter(Boolean);
  return searchableProducts
    .filter((product) =>
      words.every(
        (word) =>
          product.label.toLocaleLowerCase('uk-UA').includes(word) ||
          product.barcode.startsWith(word),
      ),
    )
    .map(({ id, label }) => ({ id, label }));
}
function ServerSearch() {
  const [selected, setSelected] = useState<Choice | null>(null);
  const [results, setResults] = useState(() => serverMatches(''));
  const [loading, setLoading] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <section className="tk-stack" aria-label="Пошук на сервері">
      <ComboBox
        search="server"
        label="Товар для перегляду"
        options={results}
        selectedOption={selected}
        isLoading={loading}
        selectedKey={selected?.id ?? null}
        onSelectionChange={(key) =>
          setSelected(serverMatches('').find((product) => product.id === key) ?? null)
        }
        onInputChange={(text) => {
          // The committed label is not a query; the latest response wins, as with a debounced request.
          const query = text === selected?.label ? '' : text;
          setLoading(true);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => {
            setResults(serverMatches(query));
            setLoading(false);
          }, 30);
        }}
        placeholder="Назва або штрихкод"
      />
      <output aria-live="polite">Вибрано: {selected?.label ?? '—'}</output>
    </section>
  );
}

const meta = { title: 'Основа/Контроли', component: Controls } satisfies Meta<typeof Controls>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const LongName: Story = {
  render: () => (
    <ComboBox label="Товар для перегляду" options={products} defaultSelectedKey="long" />
  ),
};
export const ValidationError: Story = {
  render: () => (
    <TextField
      label="Закупівельна ціна"
      defaultValue="-20"
      error="Ціна повинна бути більшою за нуль."
    />
  ),
};
export const Disabled: Story = {
  render: () => (
    <div className="tk-stack">
      <ComboBox
        label="Товар для перегляду"
        options={products}
        defaultSelectedKey="americano"
        isDisabled
      />
      <Button isDisabled>Зберегти макет</Button>
    </div>
  ),
};
export const Empty: Story = {
  render: () => (
    <ComboBox label="Товар для перегляду" options={[]} placeholder="Каталог порожній" />
  ),
};
export const KeyboardSelection: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByRole('combobox', { name: 'Товар для перегляду' });
    await userEvent.click(input);
    await userEvent.clear(input);
    await userEvent.type(input, 'Еспресо');
    await userEvent.keyboard('{ArrowDown}{Enter}');
    await expect(input).toHaveValue('Еспресо');
    await expect(canvas.getByText('Вибрано: Еспресо')).toBeVisible();
    await userEvent.clear(input);
    await userEvent.type(input, 'невідомий товар');
    await expect(within(document.body).getByText('Нічого не знайдено')).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await expect(input).toHaveValue('Еспресо');
  },
};
export const ServerSearchResults: Story = {
  render: () => <ServerSearch />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const page = within(document.body);
    const input = canvas.getByRole('combobox', { name: 'Товар для перегляду' });
    const listed = () => page.queryAllByRole('option').map((option) => option.textContent);
    const milk = 'Шоколад Солодкий край молочний 90 г';
    const water = 'Вода мінеральна негазована 0,5 л';
    // Words are not contiguous in the name: the server's match is not hidden again.
    await userEvent.click(input);
    await userEvent.type(input, 'шоколад молочний');
    await waitFor(() => expect(listed()).toEqual([milk]));
    await expect(page.getByRole('option', { name: milk })).toBeVisible();
    await expect(page.queryByText('Нічого не знайдено')).not.toBeInTheDocument();
    await userEvent.keyboard('{ArrowDown}{Enter}');
    await expect(input).toHaveValue(milk);
    await expect(canvas.getByText(`Вибрано: ${milk}`)).toBeVisible();
    // A barcode is not part of the label, yet the server result is offered and committed by keyboard.
    // The committed chocolate is not listed for this query, so ArrowDown reaches the match first.
    await userEvent.clear(input);
    await userEvent.type(input, '4820000000031');
    await waitFor(() => expect(listed()).toEqual([water]));
    await userEvent.keyboard('{ArrowDown}{Enter}');
    await expect(input).toHaveValue(water);
    await expect(canvas.getByText(`Вибрано: ${water}`)).toBeVisible();
    await userEvent.clear(input);
    await userEvent.type(input, 'невідомий товар');
    await expect(await page.findByText('Нічого не знайдено')).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await expect(input).toHaveValue(water);
  },
};
export const ServerSearchLoading: Story = {
  render: () => <ComboBox search="server" label="Товар для перегляду" options={[]} isLoading />,
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('combobox'));
    await expect(within(document.body).getByText('Шукаємо…')).toBeVisible();
    await expect(within(document.body).queryByText('Нічого не знайдено')).not.toBeInTheDocument();
  },
};
