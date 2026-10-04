import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { MonthPicker, currentMonth } from './MonthPicker';
import { Select } from './Select';

function Example({ initial = '2026-10', disabled = false, saved = false }) {
  const [value, setValue] = useState(initial);
  return (
    <div className="tk-stack" style={{ width: 'min(100%, 320px)' }}>
      <MonthPicker label="Місяць" value={value} onChange={setValue} isDisabled={disabled} />
      <Select
        label="Збережені місяці"
        options={saved ? [{ id: '2026-08', label: 'Серпень 2026' }] : []}
        placeholder={saved ? 'Вибрати місяць' : 'Ще немає бюджетів'}
        isDisabled={!saved || disabled}
        onSelectionChange={(key) => setValue(String(key))}
      />
      <output aria-label="Місяць для API">{value}</output>
    </div>
  );
}
const meta = { title: 'Основа/Вибір місяця', component: Example } satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;
export const EmptySaved: Story = {
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole('button', { name: /Збережені місяці/ }),
    ).toBeDisabled();
  },
};
export const Disabled: Story = { args: { disabled: true } };
export const Keyboard: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement),
      body = within(document.body),
      trigger = canvas.getByRole('button', { name: /^Місяць/ });
    await userEvent.click(trigger);
    await userEvent.keyboard('{ArrowRight}');
    await expect(canvas.getByLabelText('Місяць для API')).toHaveTextContent('2026-10');
    await userEvent.keyboard('{Enter}');
    await expect(canvas.getByLabelText('Місяць для API')).toHaveTextContent('2026-11');
    await expect(trigger).toHaveFocus();
    await userEvent.click(trigger);
    await userEvent.click(body.getByRole('button', { name: 'Наступний рік' }));
    await userEvent.keyboard('{Escape}');
    await expect(canvas.getByLabelText('Місяць для API')).toHaveTextContent('2026-11');
    await expect(trigger).toHaveFocus();
    await userEvent.click(trigger);
    await expect(body.getByRole('listbox', { name: 'Місяці 2026 року' })).toBeVisible();
    await userEvent.click(body.getByRole('button', { name: 'Наступний рік' }));
    await userEvent.click(body.getByRole('option', { name: 'Січень' }));
    await expect(canvas.getByLabelText('Місяць для API')).toHaveTextContent('2027-01');
    await userEvent.click(trigger);
    await userEvent.click(body.getByRole('button', { name: 'Цей місяць' }));
    await expect(canvas.getByLabelText('Місяць для API')).toHaveTextContent(currentMonth());
  },
};
export const Saved: Story = {
  args: { saved: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /Збережені місяці/ }));
    await userEvent.click(within(document.body).getByRole('option', { name: 'Серпень 2026' }));
    await expect(canvas.getByLabelText('Місяць для API')).toHaveTextContent('2026-08');
  },
};
