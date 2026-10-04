import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { NativeConflict } from './NativeConflict';
import { workShiftFields } from './workShift';
const base = {
  cash_shift: '1',
  units: '1.00',
  shift_rate: '100.00',
  bonus_percent: '10.000',
  bonus_basis: 'store',
  note: 'Початкова примітка',
};
const meta = {
  title: 'Trading/Work Shift Conflict',
  component: NativeConflict,
  args: {
    base,
    mine: { ...base, units: '2', note: 'Нова незалежна примітка' },
    server: { ...base, shift_rate: '150.00' },
    fields: workShiftFields({ '1': 'Зміна № 1 · Каса магазину з довгою українською назвою' }),
    onApply: fn(),
    onCancel: fn(),
    title: 'Узгодити зміни табеля',
  },
  render: (args) => (
    <div className="tk-story">
      <NativeConflict {...args} />
    </div>
  ),
} satisfies Meta<typeof NativeConflict>;
export default meta;
type Story = StoryObj<typeof meta>;
export const AtomicTermsKeyboard: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement),
      apply = canvas.getByRole('button', { name: 'Застосувати узгоджені зміни' });
    await expect(apply).toBeDisabled();
    await expect(
      canvas.getAllByText(/Кількість змін: 1.00/, { exact: false })[0]?.textContent,
    ).toContain('Ставка, грн: 100.00');
    await userEvent.tab();
    await userEvent.keyboard(' ');
    await expect(apply).toBeEnabled();
    await userEvent.tab();
    await userEvent.tab();
    await userEvent.keyboard('{Enter}');
    await expect(args.onApply).toHaveBeenCalledWith(args.mine);
  },
};
