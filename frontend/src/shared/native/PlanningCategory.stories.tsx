import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { NativeConflict } from './NativeConflict';
import { categoryFields } from './planningCategory';
const meta = {
  title: 'Planning/Category Recovery',
  component: NativeConflict,
  args: {
    title: 'Узгодити статтю витрат',
    base: { name: 'Оренда', active: true },
    mine: { name: 'Оренда приміщення та місця зберігання товару', active: true },
    server: { name: 'Витрати на приміщення', active: false },
    fields: categoryFields,
    onApply: fn(),
    onCancel: fn(),
  },
  render: (args) => (
    <div className="tk-story">
      <NativeConflict {...args} />
    </div>
  ),
} satisfies Meta<typeof NativeConflict>;
export default meta;
type Story = StoryObj<typeof meta>;
export const IndependentFields: Story = {
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement),
      apply = c.getByRole('button', { name: 'Застосувати узгоджені зміни' });
    await expect(apply).toBeDisabled();
    await c.getByRole('radio', { name: 'Залишити мої зміни' }).focus();
    await userEvent.keyboard(' ');
    await expect(apply).toBeEnabled();
    await userEvent.click(apply);
    await expect(args.onApply).toHaveBeenCalledWith({ ...args.mine, active: false });
  },
};
export const CancelPreservesDraft: Story = {
  play: async ({ canvasElement, args }) => {
    await userEvent.click(
      within(canvasElement).getByRole('button', { name: 'Повернутися до чернетки' }),
    );
    await expect(args.onCancel).toHaveBeenCalled();
    await expect(args.onApply).not.toHaveBeenCalled();
  },
};
