import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { ReferencePicker } from './ReferencePicker';
import { fixtureReferenceDirectory } from './referenceDirectoryFixtures';
import { referenceQuery, type ManagedReference } from './referenceDirectoryApi';
import './catalog.css';
const records = Array.from({ length: 65 }, (_, i) => ({
  id: 'pack_' + i,
  field: 'pack' as const,
  value: `Пакування ${String(i).padStart(2, '0')} — довга українська назва`,
  parentType: '',
}));
const api = fixtureReferenceDirectory(async () => ({ items: records, canEdit: true }));
const meta = {
  title: 'Catalogue/Bounded Reference Picker',
  component: ReferencePicker,
  args: {
    api,
    label: 'Пакування',
    query: referenceQuery('pack'),
    selected: null,
    value: '',
    onCommit: fn(),
  },
  render: function Render(args) {
    const [selected, setSelected] = useState<ManagedReference | null>(args.selected);
    return (
      <div className="tk-root" style={{ maxWidth: 320 }}>
        <ReferencePicker
          {...args}
          selected={selected}
          value={selected?.value || args.value}
          onCommit={(item) => {
            setSelected(item);
            args.onCommit(item);
          }}
        />
      </div>
    );
  },
} satisfies Meta<typeof ReferencePicker>;
export default meta;
type Story = StoryObj<typeof meta>;
export const UnselectedCancel: Story = {
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement),
      b = within(document.body);
    const input = c.getByRole('combobox', { name: 'Пакування' });
    await userEvent.click(input);
    await userEvent.type(input, 'неіснуючий');
    await b.findByText('Нічого не знайдено');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(b.queryByRole('listbox')).not.toBeInTheDocument());
    await expect(input).toHaveValue('');
    await expect(args.onCommit).not.toHaveBeenCalled();
  },
};
export const PagesKeyboard: Story = {
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement),
      b = within(document.body),
      input = c.getByRole('combobox', { name: 'Пакування' });
    await userEvent.click(input);
    await waitFor(() => expect(b.getByRole('status')).toHaveTextContent('65 записів · 1 / 3'));
    input.focus();
    await userEvent.keyboard('{Alt>}{PageDown}{/Alt}');
    await waitFor(() => expect(b.getByRole('status')).toHaveTextContent('65 записів · 2 / 3'));
    await userEvent.click(b.getByRole('option', { name: records[31]!.value }));
    await expect(args.onCommit).toHaveBeenCalledWith(expect.objectContaining({ id: 'pack_31' }));
    await userEvent.click(input);
    await userEvent.clear(input);
    await userEvent.type(input, 'неіснуючий');
    await waitFor(() => expect(b.queryAllByRole('option')).toHaveLength(1));
    await userEvent.keyboard('{Escape}');
    await expect(input).toHaveValue(records[31]!.value);
    const box = input.getBoundingClientRect();
    await expect(box.left).toBeGreaterThanOrEqual(0);
    await expect(box.right).toBeLessThanOrEqual(window.innerWidth);
  },
};
export const ArchivedPinned: Story = {
  args: {
    selected: {
      ...records[0]!,
      parentId: null,
      mergedInto: null,
      state: 'archived',
      revision: 'a'.repeat(64),
    },
    value: records[0]!.value,
  },
  play: async ({ canvasElement }) => {
    const input = within(canvasElement).getByRole('combobox', { name: 'Пакування' });
    await expect(input).toHaveValue(records[0]!.value + ' · Архівований');
    await userEvent.click(input);
    await userEvent.keyboard('{Escape}');
    await expect(input).toHaveValue(records[0]!.value + ' · Архівований');
  },
};
