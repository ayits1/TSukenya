import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { DatePicker, ukraineToday } from './DatePicker';

function Example({ initial = '2026-09-29', disabled = false }) {
  const [value, setValue] = useState(initial);
  return (
    <div className="tk-stack">
      <DatePicker
        label="Дата перевірки ціни"
        value={value}
        onChange={setValue}
        maxValue={ukraineToday()}
        isDisabled={disabled}
      />
      <output aria-label="Дата для API">{value}</output>
    </div>
  );
}
const meta = { title: 'Основа/Календар', component: Example } satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Empty: Story = { args: { initial: '' } };
export const Disabled: Story = { args: { disabled: true } };
export const CalendarOpen: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: /^Вибрати дату/ }));
    await userEvent.keyboard('{ArrowLeft}{Enter}');
    await expect(within(canvasElement).getByLabelText('Дата для API')).toHaveTextContent(
      '2026-09-28',
    );
    await userEvent.click(within(canvasElement).getByRole('button', { name: /^Вибрати дату/ }));
  },
};
export const CalendarSelection: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole('button', { name: /^Вибрати дату/ });
    await userEvent.click(trigger);
    const calendar = within(document.body);
    await expect(calendar.getByRole('button', { name: 'Попередній місяць' })).toBeVisible();
    await userEvent.click(calendar.getByText('30', { exact: true }));
    await expect(canvas.getByLabelText('Дата для API')).toHaveTextContent('2026-09-30');
    await expect(trigger).toHaveFocus();
    await userEvent.click(trigger);
    await userEvent.keyboard('{Escape}');
    await expect(trigger).toHaveFocus();
    await userEvent.click(canvas.getByRole('button', { name: 'Сьогодні' }));
    await expect(canvas.getByLabelText('Дата для API')).toHaveTextContent(ukraineToday());
    await userEvent.click(canvas.getByRole('button', { name: 'Очистити дату' }));
    await expect(canvas.getByLabelText('Дата для API')).toBeEmptyDOMElement();
  },
};
export const FutureDate: Story = { args: { initial: '2099-01-01' } };
