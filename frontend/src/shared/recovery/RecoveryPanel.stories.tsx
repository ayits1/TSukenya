import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { RecoveryPanel } from './RecoveryPanel';
const meta = {
  title: 'Recovery/Reload Foundation',
  component: RecoveryPanel,
  args: {
    view: {
      state: 'ready',
      entries: [
        {
          id: 'synthetic',
          label: 'Документ торговельного обліку з довгою українською назвою',
          state: 'unknown',
          updatedAt: null,
        },
      ],
      error: '',
    },
    onRestore: fn(),
    onDiscard: fn(),
    onRetry: fn(),
    onClose: fn(),
  },
} satisfies Meta<typeof RecoveryPanel>;
export default meta;
type Story = StoryObj<typeof meta>;
export const UnknownFirstIntent: Story = {
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    await c.getByRole('button', { name: 'Відновити введення' }).focus();
    await userEvent.keyboard('{Enter}');
    await expect(args.onRestore).toHaveBeenCalledWith('synthetic');
    await expect(args.onDiscard).not.toHaveBeenCalled();
  },
};
export const ExplicitDiscard: Story = {
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole('button', { name: 'Відкинути…' }));
    await expect(args.onDiscard).not.toHaveBeenCalled();
    await userEvent.click(c.getByRole('button', { name: 'Залишити чернетку' }));
    await expect(args.onDiscard).not.toHaveBeenCalled();
    await userEvent.click(c.getByRole('button', { name: 'Відкинути…' }));
    await c.getByRole('button', { name: 'Відкинути локальну чернетку' }).focus();
    await userEvent.keyboard('{Enter}');
    await expect(args.onDiscard).toHaveBeenCalledWith('synthetic');
  },
};
export const SessionChecking: Story = {
  args: { view: { state: 'checking', entries: [], error: '' } },
};
export const SessionError: Story = {
  args: {
    view: { state: 'error', entries: [], error: 'Не вдалося підтвердити доступ до чернеток.' },
  },
  play: async ({ canvasElement, args }) => {
    await userEvent.click(
      within(canvasElement).getByRole('button', { name: 'Повторити перевірку' }),
    );
    await expect(args.onRetry).toHaveBeenCalled();
  },
};
export const Unreadable: Story = {
  args: {
    view: {
      state: 'ready',
      entries: [
        {
          id: 'broken',
          label: 'Недоступна локальна чернетка',
          state: 'unreadable',
          updatedAt: null,
        },
      ],
      error: '',
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole('button', { name: 'Відновити введення' }),
    ).toBeDisabled();
  },
};

export const EntityFrozenCreate: Story = {
  args: {
    view: {
      state: 'ready',
      entries: [
        { id: 'entity_synthetic', label: 'Запис довідника', state: 'unknown', updatedAt: null },
      ],
      error: '',
    },
  },
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    await expect(c.queryByText('Приватна ставка')).not.toBeInTheDocument();
    await c.getByRole('button', { name: 'Відновити введення' }).focus();
    await userEvent.keyboard('{Enter}');
    await expect(args.onRestore).toHaveBeenCalledWith('entity_synthetic');
    await expect(args.onDiscard).not.toHaveBeenCalled();
  },
};
