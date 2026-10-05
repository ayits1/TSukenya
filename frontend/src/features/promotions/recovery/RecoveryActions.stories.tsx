import type { Meta, StoryObj } from '@storybook/react-vite';
import { within, userEvent, expect, fn } from 'storybook/test';
import { RecoveryActions } from './RecoveryActions';
const meta = {
  title: 'Каталог/Відновлення акції',
  component: RecoveryActions,
  args: {
    recovery: {
      error: 'Первісний результат не підтверджено.',
      private: true,
      busy: false,
      intent: true,
      confirmed: false,
      prepare: async () => {},
      stop: fn(),
    },
    onCurrent: fn(),
    onExact: fn(),
  },
  parameters: { layout: 'padded' },
} satisfies Meta<typeof RecoveryActions>;
export default meta;
type Story = StoryObj<typeof meta>;
export const InvalidNewerDraftExactRetry: Story = {
  play: async ({ canvasElement, args }) => {
    const button = within(canvasElement).getByRole('button', {
      name: 'Повторити саме первісну дію',
    });
    button.focus();
    await userEvent.keyboard('{Enter}');
    await expect(args.onExact).toHaveBeenCalledOnce();
  },
};
export const ConfirmedIndependentRead: Story = {
  args: { recovery: { ...meta.args.recovery, intent: false, confirmed: true } },
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    await expect(
      c.queryByRole('button', { name: 'Повторити саме первісну дію' }),
    ).not.toBeInTheDocument();
    await userEvent.click(c.getByRole('button', { name: 'Прочитати підтверджений запис' }));
    await expect(args.onCurrent).toHaveBeenCalledOnce();
  },
};
export const HiddenPendingCancel: Story = {
  args: { recovery: { ...meta.args.recovery, private: false, busy: true } },
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    await expect(c.getByRole('button', { name: 'Перевірити доступ до чернетки' })).toBeDisabled();
    await userEvent.click(c.getByRole('button', { name: 'Скасувати перевірку' }));
    await expect(args.recovery.stop).toHaveBeenCalledOnce();
  },
};
