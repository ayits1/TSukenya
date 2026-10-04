import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within, waitFor } from 'storybook/test';
import { Stock, AssortmentEditor } from './Stock';
import { StockModel, type Draft } from './state';
import { fixtureApi, options, assortmentRow } from './fixtures';
const meta = {
  title: 'Trading/Stock',
  component: Integrated,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof Integrated>;
export default meta;
type Story = StoryObj<typeof meta>;
function Integrated() {
  const [model] = useState(() => new StockModel(fixtureApi()));
  useEffect(() => {
    void model.activate(options);
    return () => model.leave();
  }, [model]);
  return <Stock model={model} />;
}
export const WholeScreen: Story = {
  render: () => <Integrated />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText('Вартість усього фільтра');
    await expect(canvas.getAllByText(/1\s999\s999\s999\s998 грн/)[0]!).toBeVisible();
    const lots = canvas.getByRole('button', { name: /^Партії/ });
    lots.focus();
    await userEvent.keyboard('{Enter}');
    await canvas.findByText('LOT');
    await expect(canvas.getByRole('button', { name: '+ Інвентаризація' })).toBeEnabled();
  },
};
function Comparison() {
  const [draft, setDraft] = useState<Draft>({
    store: 1,
    base: assortmentRow,
    sold: false,
    minimum: '3.125',
    busy: false,
    error: 'Поточний стан прочитано.',
    uncertain: true,
    reading: false,
    server: { ...assortmentRow, min_stock: '4.000', minimum: '4.000', revision: 'a'.repeat(32) },
  });
  return (
    <AssortmentEditor
      warehouse={1}
      row={assortmentRow}
      draft={draft}
      disabled={false}
      onEdit={(patch) => setDraft((v) => ({ ...v, ...patch }))}
      onSave={() => setDraft((v) => ({ ...v, error: 'Збереження окремою дією.' }))}
      onReset={() => {}}
      onCompare={() => {}}
      onApply={(value) =>
        setDraft((v) => ({
          ...v,
          sold: value.sold,
          minimum: value.min_stock ?? '',
          server: null,
          uncertain: false,
          error: 'Узгоджено лише чернетку.',
        }))
      }
      onCancel={() => setDraft((v) => ({ ...v, server: null }))}
    />
  );
}
export const AtomicComparison: Story = {
  render: () => <Comparison />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const radio = await canvas.findByRole('radio', { name: 'Залишити мої зміни' });
    radio.focus();
    await userEvent.keyboard(' ');
    const apply = canvas.getByRole('button', { name: 'Застосувати узгоджені зміни' });
    await expect(apply).toBeEnabled();
    apply.focus();
    await userEvent.keyboard('{Enter}');
    await expect(canvas.getByText('Узгоджено лише чернетку.')).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Зберегти' })).toBeEnabled();
    await expect(canvas.getByRole('textbox', { name: /Мінімум:/ })).toHaveValue('3.125');
  },
};
function InvalidRecovery() {
  const [draft, setDraft] = useState<Draft>({
    store: 1,
    base: assortmentRow,
    sold: true,
    minimum: 'invalid',
    busy: false,
    error: 'Результат невідомий.',
    uncertain: true,
    reading: false,
    server: null,
  });
  return (
    <AssortmentEditor
      warehouse={1}
      row={assortmentRow}
      draft={draft}
      disabled={false}
      onEdit={(patch) => setDraft((v) => ({ ...v, ...patch }))}
      onSave={() => {}}
      onReset={() => {}}
      onCompare={() =>
        setDraft((v) => ({
          ...v,
          server: {
            ...assortmentRow,
            min_stock: '0.000',
            minimum: '0.000',
            revision: 'a'.repeat(32),
          },
        }))
      }
      onApply={() => {}}
      onCancel={() => {}}
    />
  );
}
export const InvalidNewerRecovery: Story = {
  render: () => <InvalidRecovery />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByRole('button', { name: 'Зберегти' })).toBeDisabled());
    const read = canvas.getByRole('button', { name: 'Порівняти поточний стан' });
    read.focus();
    await userEvent.keyboard('{Enter}');
    await expect(canvas.getByText(/Поточний стан прочитано. Виправте мінімум/)).toBeVisible();
    await expect(canvas.getByRole('textbox', { name: /Мінімум:/ })).toHaveValue('invalid');
  },
};
