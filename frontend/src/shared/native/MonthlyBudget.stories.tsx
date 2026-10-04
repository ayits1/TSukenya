import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { NativeConflict } from './NativeConflict';
import { comparison, type BudgetTerms } from './monthlyBudget';
const row = {
  id: '22222222-2222-4222-8222-222222222222',
  category: '33333333-3333-4333-8333-333333333333',
  mode: 'fixed_amount' as const,
  amount: '10.00',
  rate: '0.000',
  base: 'revenue' as const,
};
const base: BudgetTerms = { planned_revenue: '100.00', lines: [row] },
  mine = { ...base, planned_revenue: '200.00', lines: [] },
  server = { ...base, lines: [{ ...row, amount: '15.00' }] },
  projection = comparison([base, mine, server], {
    [row.category]: 'Оренда приміщення магазину на центральній площі',
  });
const meta = {
  title: 'Controls/Monthly Budget Recovery',
  component: NativeConflict,
  args: {
    title: 'Узгодити план місяця',
    base: projection.snapshots[0]!,
    mine: projection.snapshots[1]!,
    server: projection.snapshots[2]!,
    fields: projection.fields,
    onApply: fn(),
    onCancel: fn(),
  },
  render: (args) => (
    <div className="tk-story">
      <p>Склад змінився: оберіть весь список. Застосування змінює лише чернетку.</p>
      <NativeConflict {...args} />
    </div>
  ),
} satisfies Meta<typeof NativeConflict>;
export default meta;
type Story = StoryObj<typeof meta>;
export const RemoveVersusChangeKeyboard: Story = {
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement),
      apply = c.getByRole('button', { name: 'Застосувати узгоджені зміни' });
    await expect(apply).toBeDisabled();
    await c.getByRole('radio', { name: 'Залишити мої зміни' }).focus();
    await userEvent.keyboard(' ');
    await expect(apply).toBeEnabled();
    await userEvent.tab();
    await userEvent.tab();
    await userEvent.keyboard('{Enter}');
    await expect(args.onApply).toHaveBeenCalledWith(args.mine);
  },
};
export const CancelWholeList: Story = {
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole('button', { name: 'Повернутися до чернетки' }));
    await expect(args.onCancel).toHaveBeenCalledOnce();
    await expect(args.onApply).not.toHaveBeenCalled();
  },
};
