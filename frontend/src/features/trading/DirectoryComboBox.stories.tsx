import { useMemo, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { DirectoryComboBox } from './DirectoryComboBox';
import type { DirectoryItem, TradingApi } from './api';
const items: DirectoryItem[] = Array.from({ length: 67 }, (_, i) => ({
  id: String(i + 1),
  name: `Довідник ${String(i).padStart(3, '0')} · довга українська назва для вибору магазину`,
  active: i !== 66,
}));
function Fixture({
  failure = false,
  empty = false,
  required = false,
}: {
  failure?: boolean;
  empty?: boolean;
  required?: boolean;
}) {
  const [selected, setSelected] = useState<DirectoryItem | null>(empty ? null : items[66] || null),
    [store, setStore] = useState(1);
  const api = useMemo(() => {
    const fail = new Set(failure ? [true] : []);
    return {
      async list(_type, query, signal) {
        await new Promise((resolve) => setTimeout(resolve, query?.q?.includes('000') ? 160 : 20));
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
        if (fail.delete(true)) {
          throw Error('Ізольована помилка читання.');
        }
        const matches = (
            query?.q ? items.filter((item) => item.name.includes(query.q || '')) : items
          ).filter((item) => query?.store !== 2 || item.id === '2'),
          total = matches.length,
          pages = Math.max(1, Math.ceil(total / 30)),
          page = Math.min(query?.page || 1, pages);
        return { items: matches.slice((page - 1) * 30, page * 30), page, pages, total, limit: 30 };
      },
      bootstrap: async () => {
        throw Error('Unused synthetic bootstrap');
      },
      details: async () => {
        throw Error('Unused synthetic details');
      },
      lookup: async () => {
        throw Error('Unused synthetic lookup');
      },
    } satisfies TradingApi;
  }, [failure]);
  return (
    <section style={{ maxWidth: 440 }}>
      <button onClick={() => setStore(store === 1 ? 2 : 1)}>Інший магазин</button>
      <DirectoryComboBox
        api={api}
        type="stores"
        query={{ store, purpose: 'filter' }}
        label="Магазин"
        emptyLabel="Усі магазини"
        required={required}
        value={selected?.id || ''}
        selected={selected}
        onCommit={setSelected}
      />
      <output>Обрано: {selected?.id || '—'}</output>
      <input aria-label="Інше поле чернетки" defaultValue="Незбережений текст" />
    </section>
  );
}
const meta = { title: 'Торгівля/Довідник із сервера', component: Fixture } satisfies Meta<
  typeof Fixture
>;
export default meta;
type Story = StoryObj<typeof meta>;
export const PagingAndKeyboard: Story = {
  render: () => <Fixture />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement),
      body = within(document.body),
      input = canvas.getByRole('combobox', { name: 'Магазин' });
    await userEvent.click(input);
    await userEvent.clear(input);
    await waitFor(() => expect(body.getByText('67 записів · 1 / 3')).toBeVisible());
    await userEvent.tab();
    await expect(body.getByRole('button', { name: 'Далі' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(input).toHaveFocus());
    await userEvent.keyboard('{Alt>}{PageUp}{/Alt}');
    await waitFor(() => expect(body.getByText('67 записів · 1 / 3')).toBeVisible());
    await userEvent.keyboard('{Alt>}{PageDown}{/Alt}');
    await waitFor(() => expect(body.getByText('67 записів · 2 / 3')).toBeVisible());
    await userEvent.click(body.getByRole('button', { name: 'Далі' }));
    await waitFor(() => expect(body.getByText('67 записів · 3 / 3')).toBeVisible());
    await userEvent.click(body.getByRole('option', { name: /Довідник 065/ }));
    await expect(canvas.getByText('Обрано: 66')).toBeVisible();
    await userEvent.click(input);
    await userEvent.clear(input);
    await userEvent.type(input, 'Відсутній');
    await waitFor(() => expect(body.getByText('Нічого не знайдено')).toBeVisible());
    await userEvent.keyboard('{Escape}');
    await expect(canvas.getByText('Обрано: 66')).toBeVisible();
    await expect(canvas.getByRole('textbox', { name: 'Інше поле чернетки' })).toHaveValue(
      'Незбережений текст',
    );
  },
};
export const RaceAndParent: Story = {
  render: () => <Fixture />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement),
      body = within(document.body),
      input = canvas.getByRole('combobox', { name: 'Магазин' });
    await userEvent.click(input);
    await userEvent.clear(input);
    await userEvent.type(input, '000');
    await userEvent.clear(input);
    await userEvent.type(input, '001');
    await waitFor(() => expect(body.getByRole('option', { name: /Довідник 001/ })).toBeVisible());
    await new Promise((resolve) => setTimeout(resolve, 220));
    await expect(body.queryByRole('option', { name: /Довідник 000/ })).not.toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(input).toHaveAttribute('aria-expanded', 'false'));
    await userEvent.click(canvas.getByRole('button', { name: 'Інший магазин' }));
    await userEvent.click(input);
    await userEvent.clear(input);
    await waitFor(() => {
      expect(body.getAllByRole('option')).toHaveLength(1);
      expect(body.queryByText('Шукаємо…')).not.toBeInTheDocument();
    });
    await expect(body.queryByRole('option', { name: /Довідник 000/ })).not.toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(input).toHaveAttribute('aria-expanded', 'false'));
  },
};
export const ErrorRetry: Story = {
  render: () => <Fixture failure />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement),
      body = within(document.body);
    await userEvent.click(canvas.getByRole('combobox', { name: 'Магазин' }));
    await waitFor(() => expect(body.getByText('Ізольована помилка читання.')).toBeVisible());
    await userEvent.click(body.getByRole('button', { name: 'Повторити' }));
    await waitFor(() => expect(body.getByText('67 записів · 1 / 3')).toBeVisible());
    await userEvent.click(canvas.getByRole('combobox', { name: 'Магазин' }));
    await userEvent.keyboard('{Escape}');
  },
};
export const NarrowPinnedInactive: Story = {
  render: () => (
    <div style={{ maxWidth: 288 }}>
      <Fixture />
    </div>
  ),
};

export const OptionalEmpty: Story = {
  render: () => <Fixture empty />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement),
      body = within(document.body);
    const input = canvas.getByRole('combobox', { name: 'Магазин' });
    await expect(input).toHaveValue('');
    await expect(input).toHaveAttribute('placeholder', 'Усі магазини');
    await userEvent.click(input);
    await waitFor(() => expect(body.getByText('67 записів · 1 / 3')).toBeVisible());
    await userEvent.type(input, '001');
    await waitFor(() => expect(body.getByRole('option', { name: /Довідник 001/ })).toBeVisible());
    await userEvent.keyboard('{Escape}');
    await expect(input).toHaveValue('');
    await expect(canvas.getByText('Обрано: —')).toBeVisible();
    await expect(input).toHaveAttribute('placeholder', 'Усі магазини');
    await userEvent.click(input);
    await userEvent.type(input, '001');
    await waitFor(() => expect(body.getByRole('option', { name: /Довідник 001/ })).toBeVisible());
    await waitFor(() => {
      expect(body.getAllByRole('option')).toHaveLength(1);
      expect(body.queryByText('Шукаємо…')).not.toBeInTheDocument();
    });
    await userEvent.keyboard('{ArrowDown}{Enter}');
    await expect(canvas.getByText('Обрано: 2')).toBeVisible();
    await userEvent.click(input);
    await userEvent.clear(input);
    await expect(input).toHaveAttribute('placeholder', 'Знайдіть запис…');
    await userEvent.type(input, 'невідомий');
    await userEvent.keyboard('{Escape}');
    await expect(input).toHaveValue(items[1]!.name);
    await userEvent.tab();
    const clear = canvas.getByRole('button', { name: 'Очистити вибір: Магазин' });
    clear.focus();
    await userEvent.keyboard('{Enter}');
    await expect(canvas.getByText('Обрано: —')).toBeVisible();
    await expect(input).toHaveValue('');
    await expect(input).toHaveAttribute('placeholder', 'Усі магазини');
  },
};
export const RequiredEmpty: Story = {
  render: () => <Fixture empty required />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement),
      input = canvas.getByRole('combobox', { name: 'Магазин' });
    await expect(input).toHaveAttribute('placeholder', 'Оберіть або знайдіть запис…');
    await expect(input).toHaveValue('');
    await expect(
      canvas.getByText('Оберіть запис зі списку. Введений текст ще не є вибором.'),
    ).toBeVisible();
    await expect(
      canvas.queryByRole('button', { name: 'Очистити вибір: Магазин' }),
    ).not.toBeInTheDocument();
  },
};

export const CompactTriggerPagination: Story = {
  render: () => (
    <div style={{ width: 88 }}>
      <Fixture empty />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement),
      body = within(document.body);
    const input = canvas.getByRole('combobox', { name: 'Магазин' });
    await userEvent.click(input);
    await waitFor(() => expect(body.getByText('67 записів · 1 / 3')).toBeVisible());
    const popover = body.getByRole('listbox').closest('.tk-popover')!;
    const bounds = popover.getBoundingClientRect();
    const minimum = Math.min(
      20 * parseFloat(getComputedStyle(document.documentElement).fontSize),
      innerWidth - 64,
    );
    await expect(bounds.width).toBeGreaterThanOrEqual(minimum - 1);
    await expect(bounds.left).toBeGreaterThanOrEqual(0);
    await expect(bounds.right).toBeLessThanOrEqual(innerWidth);
    const paging = popover.querySelector<HTMLElement>('.tk-directory-paging')!;
    for (const button of within(paging).getAllByRole('button')) {
      const rect = button.getBoundingClientRect();
      await expect(rect.left).toBeGreaterThanOrEqual(bounds.left);
      await expect(rect.right).toBeLessThanOrEqual(bounds.right);
      await expect(rect.width).toBeGreaterThanOrEqual(44);
      await expect(rect.height).toBeGreaterThanOrEqual(44);
    }
    await userEvent.tab();
    await expect(body.getByRole('button', { name: 'Далі' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(body.getByText('67 записів · 2 / 3')).toBeVisible());
    await waitFor(() => expect(input).toHaveFocus());
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(input).toHaveAttribute('aria-expanded', 'false'));
    await expect(canvas.getByText('Обрано: —')).toBeVisible();
  },
};

function CompactEmployees() {
  const [dialog, setDialog] = useState<HTMLDialogElement | null>(null);
  const [selected, setSelected] = useState<DirectoryItem | null>(null);
  const api = useMemo(
    () =>
      ({
        list: async () => ({
          items: [
            { id: '11', name: 'Марія Коваленко', store_id: 1, active: true },
            { id: '12', name: 'Марія Коваленко', store_id: 2, active: true },
          ],
          total: 2,
          pages: 1,
          page: 1,
          limit: 30,
        }),
        bootstrap: async () => {
          throw Error('Unused synthetic bootstrap');
        },
        details: async () => {
          throw Error('Unused synthetic details');
        },
        lookup: async () => {
          throw Error('Unused synthetic lookup');
        },
      }) satisfies TradingApi,
    [],
  );
  return (
    <>
      <button onClick={() => dialog?.showModal()}>Відкрити зміну</button>
      <dialog
        ref={setDialog}
        style={{
          width: 'min(600px, calc(100vw - 32px))',
          padding: 24,
          height: 300,
          overflow: 'auto',
        }}
      >
        <h2>Відкриття касової зміни</h2>
        <DirectoryComboBox
          api={api}
          type="employees"
          query={{ purpose: 'shift_open' }}
          label="Працівник"
          emptyLabel="Без працівника"
          value={selected?.id || ''}
          selected={selected}
          {...(dialog ? { portalContainer: dialog } : {})}
          onCommit={setSelected}
        />
        <button onClick={() => dialog?.close()}>Закрити</button>
        <output>Працівник: {selected?.id || '—'}</output>
      </dialog>
    </>
  );
}
export const CompactEmployeesInDialog: Story = {
  render: () => <CompactEmployees />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement),
      body = within(document.body);
    await userEvent.click(canvas.getByRole('button', { name: 'Відкрити зміну' }));
    const input = body.getByRole('combobox', { name: 'Працівник' });
    await userEvent.click(input);
    await waitFor(() => expect(body.getAllByRole('option')).toHaveLength(2));
    await expect(body.queryByRole('button', { name: 'Далі' })).not.toBeInTheDocument();
    const options = body.getAllByRole('option');
    await expect(options[0]).toHaveTextContent('магазин №1 · №11');
    await expect(options[1]).toHaveTextContent('магазин №2 · №12');
    const bounds = body.getByRole('listbox').closest('.tk-popover')!.getBoundingClientRect();
    const dialog = input.closest('dialog')!.getBoundingClientRect();
    await expect(bounds.bottom).toBeLessThanOrEqual(dialog.bottom);
    await expect(bounds.top).toBeGreaterThanOrEqual(dialog.top);
    await userEvent.keyboard('{ArrowDown}{Enter}');
    await expect(body.getByText('Працівник: 11')).toBeVisible();
    await userEvent.click(input);
    await userEvent.keyboard('{Escape}');
    await expect(input.closest('dialog')).toHaveAttribute('open');
    await userEvent.click(body.getByRole('button', { name: 'Закрити' }));
  },
};
