import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { Button } from './Button';
import { TextField } from './TextField';
import { ComboBox } from './ComboBox';
import { products } from '../../features/component-lab/fixtures';

import { Controls } from '../../features/component-lab/Controls';

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
