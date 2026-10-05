import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { RecoveryActions } from './RecoveryActions';
import '../catalog.css';
const meta = {
  title: 'Catalog/Durable recovery',
  component: RecoveryActions,
  args: {
    recovery: {
      private: true,
      busy: false,
      error: '',
      intent: true,
      confirmed: false,
      prepare: fn(async () => {}),
      stop: fn(),
    },
    onCurrent: fn(),
    onExact: fn(),
  },
  render: (args) => (
    <div className="tk-root" style={{ width: 280, maxWidth: '100%', padding: 8 }}>
      <form>
        <label>
          Новіша назва
          <input required defaultValue="" />
        </label>
        <RecoveryActions {...args} />
      </form>
    </div>
  ),
} satisfies Meta<typeof RecoveryActions>;
export default meta;
type Story = StoryObj<typeof meta>;
export const InvalidNewerInputExactRetry: Story = {
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement),
      button = c.getByRole('button', { name: 'Повторити саме первісну дію' });
    button.focus();
    await userEvent.keyboard('{Enter}');
    await expect(args.onExact).toHaveBeenCalledTimes(1);
    await expect(c.getByRole('textbox')).toHaveValue('');
    await expect(button).toHaveAttribute('type', 'button');
    await expect(button.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth + 1);
  },
};
export const ConfirmedGetOnly: Story = {
  args: {
    recovery: {
      ...meta.args.recovery,
      intent: false,
      confirmed: true,
      error: 'Читання актуального запису недоступне. Первісний результат підтверджено.',
    },
  },
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    await expect(c.queryByRole('button', { name: 'Повторити саме первісну дію' })).toBeNull();
    c.getByRole('button', { name: 'Прочитати підтверджений запис' }).focus();
    await userEvent.keyboard('{Enter}');
    await expect(args.onCurrent).toHaveBeenCalledTimes(1);
    await expect(args.onExact).not.toHaveBeenCalled();
  },
};
export const PrivateGateCancel: Story = {
  args: {
    recovery: {
      ...meta.args.recovery,
      private: false,
      busy: true,
      error: 'Доступ не підтверджено.',
    },
  },
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    await expect(c.getByRole('button', { name: 'Перевірити доступ до чернетки' })).toBeDisabled();
    c.getByRole('button', { name: 'Скасувати перевірку' }).focus();
    await userEvent.keyboard('{Enter}');
    await expect(args.recovery.stop).toHaveBeenCalledTimes(1);
  },
};
