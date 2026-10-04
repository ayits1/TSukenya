import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { within, userEvent, expect, waitFor } from 'storybook/test';
import { ReceiptPricing } from './ReceiptPricing';
import { fixtureCurrent, fixturePreview, fixtureReceipt } from './fixtures';
import type { Commit, ReceiptPricingApi } from './api';
import { createTradingApi, type DirectoryType, type DirectoryQuery } from '../trading/api';
import { ApiError } from '../../shared/api/client';
const directoryApi = {
  ...createTradingApi(async () => {
    throw Error('Synthetic story has no network access');
  }),
  list: async (_type: DirectoryType, query: DirectoryQuery = {}) => {
    const items = [
      { id: '1', name: 'QA магазин' },
      { id: '2', name: 'QA інший магазин' },
    ].filter(
      (s) => !query.q || s.name.toLocaleLowerCase('uk').includes(query.q.toLocaleLowerCase('uk')),
    );
    return {
      resource: 'stores' as const,
      items,
      total: items.length,
      page: 1,
      pages: 1,
      limit: 30 as const,
    };
  },
};
function Recovery() {
  const [services] = useState(() => {
    let original: Commit | undefined,
      attempts = 0;
    const api: ReceiptPricingApi = {
      current: async () => fixtureCurrent(),
      preview: async (_id, body) => fixturePreview(body),
      commit: async (_id, body) => {
        if (!original) original = structuredClone(body);
        else expect(body).toEqual(original);
        attempts++;
        if (attempts === 1) throw new ApiError(0, 'QA втрачена відповідь');
        throw new ApiError(403, 'QA поточна роль забороняє повтор');
      },
      result: async (_id, body) => fixtureReceipt(body),
    };
    return api;
  });
  return (
    <ReceiptPricing
      id={1}
      api={services}
      directoryApi={directoryApi}
      onClose={() => {}}
      onOpenLabels={() => {}}
    />
  );
}
const meta = {
  title: 'Receipt pricing/Explicit catalogue review',
  component: ReceiptPricing,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof ReceiptPricing>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ExactRecovery: Story = {
  args: {
    id: 1,
    directoryApi,
    api: {
      current: async () => fixtureCurrent(),
      preview: async (_id, body) => fixturePreview(body),
      commit: async (_id, body) => fixtureReceipt(body),
      result: async (_id, body) => fixtureReceipt(body),
    },
    onClose: () => {},
    onOpenLabels: () => {},
  },
  render: () => <Recovery />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await c.findByRole('checkbox', { name: 'Включити «Кава Американо» у перегляд' });
    await userEvent.click(
      c.getByRole('checkbox', { name: 'Включити «Кава Американо» у перегляд' }),
    );
    await userEvent.type(c.getByLabelText('Причина перегляду цін'), 'Після надходження');
    await userEvent.click(c.getByRole('button', { name: 'Переглянути зміни перед записом' }));
    await userEvent.click(
      await c.findByRole('button', { name: 'Підтвердити запис перевіреного плану' }),
    );
    await c.findByText('QA втрачена відповідь');
    await userEvent.clear(c.getByLabelText('Закупівля Кава Американо: гривні'));
    await userEvent.click(c.getByRole('button', { name: 'Повторити початковий запис точно' }));
    await c.findByText('QA поточна роль забороняє повтор');
    await userEvent.click(c.getByRole('button', { name: 'Прочитати результат без запису' }));
    await c.findByRole('heading', { name: 'Операцію підтверджено' });
    await expect(c.getByLabelText('Закупівля Кава Американо: гривні')).toHaveValue('');
    await expect(c.getByRole('button', { name: 'Переглянути зміни перед записом' })).toBeDisabled();
  },
};
export const FractionalCentAndKeyboard: Story = {
  args: {
    id: 1,
    directoryApi,
    api: {
      current: async () => fixtureCurrent(),
      preview: async (_id, body) => fixturePreview(body),
      commit: async (_id, body) => fixtureReceipt(body),
      result: async (_id, body) => fixtureReceipt(body),
    },
    onClose: () => {},
    onOpenLabels: () => {},
  },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(
      await c.findByRole('checkbox', { name: 'Включити «Кава Американо» у перегляд' }),
    );
    const combo = c.getByRole('button', { name: /Джерельний рядок для Кава Американо/ });
    combo.focus();
    await userEvent.keyboard('{Enter}{End}{Enter}');
    await userEvent.click(c.getByRole('button', { name: 'Використати вибраний рядок' }));
    await waitFor(() => expect(c.getByText(/Ціна 13.1234 грн має частки копійки/)).toBeVisible());
    await expect(c.getByLabelText('Закупівля Кава Американо: гривні')).toHaveValue('10');
    await expect(c.queryByRole('heading', { name: 'Перевірений план' })).toBeNull();
  },
};

export const UnitMismatchNeedsExplicitInput: Story = {
  args: {
    id: 1,
    directoryApi,
    api: {
      current: async () => {
        const data = fixtureCurrent();
        data.source.lines[0]!.unit = 'кг';
        return data;
      },
      preview: async (_id, body) => fixturePreview(body),
      commit: async (_id, body) => fixtureReceipt(body),
      result: async (_id, body) => fixtureReceipt(body),
    },
    onClose: () => {},
    onOpenLabels: () => {},
  },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(
      await c.findByRole('checkbox', { name: 'Включити «Кава Американо» у перегляд' }),
    );
    c.getByRole('button', { name: /Джерельний рядок для Кава Американо/ }).focus();
    await userEvent.keyboard('{Enter}{Home}{Enter}');
    await userEvent.click(c.getByRole('button', { name: 'Використати вибраний рядок' }));
    await c.findByText(/Одиниця джерела «кг» відрізняється від каталогу «шт»/);
    await expect(c.getByLabelText('Закупівля Кава Американо: гривні')).toHaveValue('10');
    await userEvent.clear(c.getByLabelText('Закупівля Кава Американо: гривні'));
    await userEvent.type(c.getByLabelText('Закупівля Кава Американо: гривні'), '14');
    await expect(c.getByText(/Закупівля задається явно/)).toBeVisible();
  },
};

export const BoundedStoreAndExplicitNetwork: Story = {
  args: {
    ...FractionalCentAndKeyboard.args,
    api: {
      ...FractionalCentAndKeyboard.args!.api!,
      current: async (_id, store) => {
        const value = fixtureCurrent();
        const storeId = store === undefined ? 1 : store;
        value.priceContext = {
          storeId,
          storeName: storeId === null ? null : storeId === 2 ? 'QA інший магазин' : 'QA магазин',
        };
        value.products = value.products.map((p) => ({ ...p, priceContext: value.priceContext }));
        return value;
      },
      commit: async () => {
        throw Error('Local context apply must not write');
      },
    },
  },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const input = await c.findByRole('combobox', { name: 'Магазин для перегляду цін' });
    await userEvent.clear(input);
    await userEvent.type(input, 'QA інший');
    await within(document.body).findByRole('option', { name: 'QA інший магазин' });
    await waitFor(() => expect(within(document.body).getByText('1 записів · 1 / 1')).toBeVisible());
    await userEvent.keyboard('{ArrowDown}{Enter}');
    await c.findByRole('heading', { name: 'Порівняти зміни' });
    await expect(c.getByText(/Підтверджений контекст цін:/)).toHaveTextContent('QA магазин');
    await userEvent.click(c.getByRole('button', { name: 'Застосувати узгоджені зміни' }));
    await expect(c.getByText(/Підтверджений контекст цін:/)).toHaveTextContent('QA інший магазин');
    await userEvent.click(c.getByRole('button', { name: 'Порівняти ціни у контексті мережі' }));
    await c.findByRole('heading', { name: 'Порівняти зміни' });
    await userEvent.click(c.getByRole('button', { name: 'Застосувати узгоджені зміни' }));
    await expect(c.getByText(/Підтверджений контекст цін:/)).toHaveTextContent('мережа');
    await expect(input).toHaveValue('');
  },
};
