import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { ConflictComparison } from './ConflictComparison';
import type { MergeChoices } from '../merge/threeWay';

const meta = {
  title: 'Controls/Conflict Comparison',
  component: ConflictComparison,
  args: {
    rows: [
      {
        id: 'name',
        label: 'Назва товару',
        base: 'Кава',
        mine: 'Кава',
        server: 'Кава зернова зі спеціальною довгою назвою українською мовою',
        status: 'server',
      },
      {
        id: 'pack',
        label: 'Пакування',
        base: 'Пакет',
        mine: 'Коробка',
        server: 'Пакет',
        status: 'mine',
      },
      {
        id: 'pricing',
        label: 'Ціни та акція',
        base: 'Звичайна ціна: 21,99 грн\nАкційна ціна: 17,50 грн',
        mine: 'Звичайна ціна: 23,05 грн\nАкційна ціна: 17,50 грн',
        server: 'Звичайна ціна: 25,00 грн\nАкційна ціна: 19,99 грн',
        status: 'conflict',
      },
    ],
    choices: {},
    onChoice: fn(),
    onApply: fn(),
    onCancel: fn(),
  },
  render: function Render(args) {
    const [choices, setChoices] = useState<MergeChoices>(args.choices);
    return (
      <div className="tk-story">
        <ConflictComparison
          {...args}
          choices={choices}
          onChoice={(id, choice) => {
            args.onChoice(id, choice);
            setChoices((old) => ({ ...old, [id]: choice }));
          }}
        />
      </div>
    );
  },
} satisfies Meta<typeof ConflictComparison>;
export default meta;
type Story = StoryObj<typeof meta>;
export const KeyboardChoice: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement),
      apply = canvas.getByRole('button', { name: 'Застосувати узгоджені зміни' });
    await expect(apply).toBeDisabled();
    await expect(canvas.getByRole('heading', { name: 'Порівняти зміни' })).toHaveFocus();
    await userEvent.tab();
    await expect(canvas.getByRole('radio', { name: 'Залишити мої зміни' })).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    await expect(canvas.getByRole('radio', { name: 'Взяти зміни сервера' })).toBeChecked();
    await expect(apply).toBeEnabled();
    await userEvent.tab();
    await expect(canvas.getByRole('button', { name: 'Повернутися до чернетки' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(args.onCancel).toHaveBeenCalledTimes(1);
    await expect(args.onApply).not.toHaveBeenCalled();
    await userEvent.tab();
    await userEvent.keyboard('{Enter}');
    await expect(args.onApply).toHaveBeenCalledTimes(1);
  },
};
export const IndependentChanges: Story = { args: { rows: meta.args.rows.slice(0, 2) } };
export const EmptyChanges: Story = { args: { rows: [] } };
export const Disabled: Story = { args: { isDisabled: true } };
