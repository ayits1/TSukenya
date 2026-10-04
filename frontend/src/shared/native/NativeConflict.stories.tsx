import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { NativeConflict } from './NativeConflict';

const base = {
  title: 'Пілот',
  hypothesis: 'Початкова гіпотеза',
  metric: 'Кількість продажів',
  unit: 'шт',
  target: '10',
};
const meta = {
  title: 'Controls/Native Conflict Bridge',
  component: NativeConflict,
  args: {
    base,
    mine: { ...base, title: 'Моя довга назва перевірки бізнесового процесу', target: '12' },
    server: {
      ...base,
      title: 'Назва іншого редактора',
      hypothesis: 'Нова серверна гіпотеза',
      unit: 'кг',
    },
    fields: [
      { id: 'title', label: 'Назва проєкту', keys: ['title'] },
      { id: 'hypothesis', label: 'Гіпотеза', keys: ['hypothesis'] },
      {
        id: 'metric',
        label: 'Показник, одиниця та ціль',
        keys: ['metric', 'unit', 'target'],
        decimals: ['target'],
        labels: { metric: 'Показник', unit: 'Одиниця', target: 'Ціль' },
      },
    ],
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

export const KeyboardApply: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement),
      apply = canvas.getByRole('button', { name: 'Застосувати узгоджені зміни' });
    await expect(apply).toBeDisabled();
    await userEvent.tab();
    await expect(canvas.getAllByRole('radio', { name: 'Залишити мої зміни' })[0]).toHaveFocus();
    await userEvent.keyboard(' ');
    await expect(apply).toBeDisabled();
    await userEvent.tab();
    await expect(canvas.getAllByRole('radio', { name: 'Залишити мої зміни' })[1]).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    await expect(apply).toBeEnabled();
    await userEvent.tab();
    await userEvent.tab();
    await userEvent.keyboard('{Enter}');
    await expect(args.onApply).toHaveBeenCalledWith({ ...args.server, title: args.mine.title });
    await expect(args.onCancel).not.toHaveBeenCalled();
  },
};
export const CancelUnresolved: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Повернутися до чернетки' }));
    await expect(args.onCancel).toHaveBeenCalledTimes(1);
    await expect(args.onApply).not.toHaveBeenCalled();
  },
};

export const ResponsibleNames: Story = {
  args: {
    base: { responsible: 1 },
    mine: { responsible: 2 },
    server: { responsible: 3 },
    fields: [
      {
        id: 'responsible',
        label: 'Відповідальний',
        keys: ['responsible'],
        valueLabels: {
          '1': 'Олена',
          '2': 'Тарас',
          '3': 'Збережений працівник із довгим ім’ям · неактивний',
        },
      },
    ],
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Олена')).toBeVisible();
    await expect(canvas.getByText('Тарас')).toBeVisible();
    await expect(
      canvas.getByText('Збережений працівник із довгим ім’ям · неактивний'),
    ).toBeVisible();
    await userEvent.click(canvas.getByRole('radio', { name: 'Залишити мої зміни' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Застосувати узгоджені зміни' }));
    await expect(args.onApply).toHaveBeenCalledWith({ responsible: 2 });
  },
};

export const EmployeePayTerms: Story = {
  args: {
    base: { name: 'Олена', shift_rate: '100.00', bonus_percent: '2.000', bonus_basis: 'store' },
    mine: { name: 'Олена', shift_rate: '125.00', bonus_percent: '2.000', bonus_basis: 'store' },
    server: {
      name: 'Нове ім’я іншого редактора',
      shift_rate: '100.00',
      bonus_percent: '3.000',
      bonus_basis: 'profit',
    },
    fields: [
      { id: 'name', label: 'Назва / ім’я', keys: ['name'] },
      {
        id: 'payTerms',
        label: 'Умови оплати праці',
        keys: ['shift_rate', 'bonus_percent', 'bonus_basis'],
        decimals: ['shift_rate', 'bonus_percent'],
        labels: {
          shift_rate: 'Оплата за зміну, грн',
          bonus_percent: 'Відсоток, %',
          bonus_basis: 'База відсотка',
        },
        valueLabels: {
          store: 'Виторг магазину за касову зміну',
          profit: 'Валовий прибуток за зміну',
        },
      },
    ],
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole('button', { name: 'Застосувати узгоджені зміни' }),
    ).toBeDisabled();
    await userEvent.tab();
    await userEvent.keyboard(' ');
    await userEvent.click(canvas.getByRole('button', { name: 'Застосувати узгоджені зміни' }));
    await expect(args.onApply).toHaveBeenCalledWith({ ...args.mine, name: args.server.name });
  },
};
