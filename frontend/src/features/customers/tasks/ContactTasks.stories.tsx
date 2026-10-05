import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { NativeConflict } from '../../../shared/native/NativeConflict';
import { taskFields } from './TaskEditor';
const base = {
  title: 'Передзвонити клієнту',
  note: 'Уточнити час',
  due_on: '2026-10-06',
  assignee: '1',
  status: 'todo',
  archived: false,
};
const meta = {
  title: 'CRM/Contact Task Recovery',
  component: NativeConflict,
  args: {
    title: 'Порівняти задачу контакту',
    fields: taskFields,
    base,
    mine: { ...base, note: 'Моя примітка', status: 'doing' },
    server: { ...base, note: 'Інша примітка', archived: true },
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
export const AtomicStateAndIndependentNote: Story = {
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    const apply = c.getByRole('button', { name: 'Застосувати узгоджені зміни' });
    await expect(apply).toBeDisabled();
    const radios = c.getAllByRole('radio', { name: 'Залишити мої зміни' });
    for (const radio of radios) {
      radio.focus();
      await userEvent.keyboard(' ');
    }
    await expect(apply).toBeEnabled();
    apply.focus();
    await userEvent.keyboard('{Enter}');
    await expect(args.onApply).toHaveBeenCalledWith(args.mine);
  },
};
export const CancelKeepsLocalTask: Story = {
  play: async ({ canvasElement, args }) => {
    const button = within(canvasElement).getByRole('button', { name: 'Повернутися до чернетки' });
    button.focus();
    await userEvent.keyboard('{Enter}');
    await expect(args.onCancel).toHaveBeenCalled();
    await expect(args.onApply).not.toHaveBeenCalled();
  },
};
