import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { NativeConflict } from './NativeConflict';
import { budgetTemplateFields } from './budgetTemplate';
const meta = {
  title: 'Controls/Budget Template Conflict',
  component: NativeConflict,
  args: {
    base: { budgetStores: 2 },
    mine: { budgetStores: 3 },
    server: { budgetStores: 4 },
    fields: budgetTemplateFields(),
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
export const KeyboardExplicitApply: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement),
      apply = canvas.getByRole('button', { name: 'Застосувати узгоджені зміни' });
    await expect(apply).toBeDisabled();
    await userEvent.tab();
    await expect(canvas.getByRole('radio', { name: 'Залишити мої зміни' })).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    await userEvent.tab();
    await userEvent.tab();
    await userEvent.keyboard('{Enter}');
    await expect(args.onApply).toHaveBeenCalledWith({ budgetStores: 4 });
  },
};
