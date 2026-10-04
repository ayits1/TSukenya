import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within, waitFor } from 'storybook/test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CampaignManager } from './CampaignManager';
import { ApiError } from '../../shared/api/client';
import {
  catalogPage,
  catalogProducts,
  catalogReferences,
  fixturePricePreview,
} from '../catalog/fixtures';
import type { CatalogApi } from '../catalog/api';
import type { Campaign, CampaignInput, PromotionApi, PromotionContext } from './api';
const context: PromotionContext = {
  storeId: null,
  storeName: null,
  effectiveDay: '2026-10-04',
  stores: [
    { id: 1, name: 'Магазин на вулиці Незалежності — основний торгівельний зал' },
    { id: 2, name: 'Магазин №2' },
  ],
  canManage: true,
  canViewHistory: true,
  canSelectNetwork: true,
  csrf: 'synthetic',
};
const existing: Campaign = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Вихідні з кавою',
  startsOn: '2026-10-04',
  endsOn: '2026-10-08',
  active: true,
  scope: 'stores',
  stores: [1],
  prices: [{ product: catalogProducts[0]!.id, name: catalogProducts[0]!.name, price: '20.00' }],
  reason: 'Попередні умови',
  revision: 1,
  archived: false,
  status: 'active',
  author: 'synthetic-owner',
};
function Harness({
  lost = false,
  conflict = false,
  onRequest,
  onDirty,
  pagination = false,
  onList,
  onHistory,
}: {
  pagination?: boolean;
  onList: (filters: unknown) => void;
  onHistory: (filters: unknown) => void;
  lost?: boolean;
  conflict?: boolean;
  onRequest: (input: CampaignInput, identity: unknown) => void;
  onDirty: (value: boolean) => void;
}) {
  const [services] = useState(() => {
    let requests = 0;
    let created: Campaign | null = null;
    let items = [existing];
    const api: PromotionApi = {
      context: async () => context,
      campaign: async (id) => {
        if (conflict) throw new ApiError(0, 'Актуальні умови недоступні. Чернетку збережено.');
        return items.find((c) => c.id === id) || existing;
      },
      campaigns: async (_signal, filters) => {
        onList(filters);
        return {
          items,
          total: pagination ? 21 : items.length,
          page: filters?.page || 1,
          pages: pagination ? 2 : 1,
          limit: 20,
        };
      },
      history: async (_store, _signal, filters) => {
        onHistory(filters);
        return {
          items: [],
          total: pagination ? 21 : 0,
          page: filters?.page || 1,
          pages: pagination ? 2 : 1,
          limit: 20,
        };
      },
      archive: async (c) => ({
        ...c,
        archived: true,
        active: false,
        revision: c.revision + 1,
        status: 'archived',
      }),
      save: async (input, identity) => {
        onRequest(input, identity);
        requests++;
        await new Promise((r) => setTimeout(r, 30));
        if (conflict)
          throw new ApiError(409, 'Акцію вже змінено. Чернетку збережено.', 'revision_conflict');
        if (lost && requests === 1) {
          created = {
            ...input,
            id: 'idempotencyKey' in identity ? identity.idempotencyKey : identity.id,
            revision: 1,
            archived: false,
            status: 'active',
            author: 'synthetic-owner',
            prices: input.prices.map((p) => ({
              ...p,
              name: catalogProducts.find((x) => x.id === p.product)?.name || p.product,
            })),
          };
          items = [existing, created];
          throw new ApiError(0, 'Відповідь втрачено після створення.');
        }
        if (lost && requests === 2 && created) return created;
        const result: Campaign = {
          ...input,
          id: 'idempotencyKey' in identity ? identity.idempotencyKey : identity.id,
          revision: 'revision' in identity ? identity.revision + 1 : 1,
          archived: false,
          status: 'active',
          author: 'synthetic-owner',
          prices: input.prices.map((p) => ({
            ...p,
            name: catalogProducts.find((x) => x.id === p.product)?.name || p.product,
          })),
        };
        items = [existing, result];
        return result;
      },
    };
    const catalog: CatalogApi = {
      session: async () => ({ role: 'owner', csrf: 'synthetic' }),
      list: async (filters) => {
        await new Promise((r) => setTimeout(r, 20));
        return {
          ...catalogPage,
          items: catalogProducts.filter(
            (p) =>
              !filters.q ||
              p.name.toLocaleLowerCase('uk-UA').includes(filters.q.toLocaleLowerCase('uk-UA')),
          ),
        };
      },
      product: async () => catalogProducts[0]!,
      save: async () => catalogProducts[0]!,
      remove: async () => true,
      visibility: async (product, hidden) => ({ ...product, hidden }),
      previewPrice: fixturePricePreview,
      references: async () => catalogReferences,
      createReference: async () => {
        throw new Error('Not used');
      },
    };
    return { api, catalog, client: new QueryClient() };
  });
  return (
    <QueryClientProvider client={services.client}>
      <CampaignManager
        api={services.api}
        catalog={services.catalog}
        context={context}
        onDirty={onDirty}
        onChanged={() => {}}
      />
    </QueryClientProvider>
  );
}
const meta = {
  title: 'Каталог/Акції з періодом',
  component: Harness,
  args: { onRequest: fn(), onDirty: fn(), onList: fn(), onHistory: fn() },
  parameters: { layout: 'padded' },
} satisfies Meta<typeof Harness>;
export default meta;
type Story = StoryObj<typeof meta>;
async function newCampaign(canvas: ReturnType<typeof within>) {
  await userEvent.click(canvas.getByRole('button', { name: 'Створити акцію' }));
  await userEvent.type(canvas.getByRole('textbox', { name: 'Назва акції' }), 'Осінні ціни');
  await userEvent.type(
    canvas.getByRole('textbox', { name: 'Причина зміни' }),
    'Сезонна пропозиція',
  );
  const product = canvas.getByRole('combobox', { name: 'Додати товар акції' });
  await userEvent.type(product, 'Кава');
  await waitFor(() =>
    expect(
      within(document.body).getByRole('option', { name: catalogProducts[0]!.name }),
    ).toBeVisible(),
  );
  await userEvent.keyboard('{ArrowDown}{Enter}');
  await userEvent.click(canvas.getByRole('button', { name: 'Додати вибраний товар' }));
  await userEvent.type(
    canvas.getByRole('textbox', { name: `Акційна ціна: ${catalogProducts[0]!.name}: гривні` }),
    '19',
  );
  await userEvent.tab();
}
export const KeyboardPeriodStoreAndSave: Story = {
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    await newCampaign(c);
    const dates = c.getAllByRole('button', { name: /Вибрати дату/ });
    dates[0]!.focus();
    await userEvent.keyboard('{Enter}');
    await expect(
      within(document.body).getByRole('dialog', { name: 'Календар: Початок акції' }),
    ).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await expect(dates[0]!).toHaveFocus();
    const area = c.getByRole('button', { name: /Де діє акція/ });
    area.focus();
    await userEvent.keyboard('{Enter}{End}{Enter}');
    await userEvent.click(c.getByRole('checkbox', { name: context.stores[0]!.name }));
    await userEvent.click(c.getByRole('button', { name: 'Зберегти акцію' }));
    await waitFor(() => expect(args.onRequest).toHaveBeenCalledOnce());
    await expect(args.onRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'stores',
        stores: [1],
        prices: [{ product: catalogProducts[0]!.id, price: '19.00' }],
      }),
      expect.objectContaining({ idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/) }),
    );
    await waitFor(() =>
      expect(c.queryByRole('form', { name: 'Умови акції' })).not.toBeInTheDocument(),
    );
  },
};
export const LostResponseKeepsNewInput: Story = {
  args: { lost: true },
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    await newCampaign(c);
    await userEvent.click(c.getByRole('button', { name: 'Зберегти акцію' }));
    await expect(await c.findByText('Відповідь втрачено після створення.')).toBeVisible();
    await userEvent.clear(c.getByRole('textbox', { name: 'Назва акції' }));
    await userEvent.type(
      c.getByRole('textbox', { name: 'Назва акції' }),
      'Нові умови окремим збереженням',
    );
    await userEvent.click(c.getByRole('button', { name: 'Зберегти акцію' }));
    await waitFor(() => expect(args.onRequest).toHaveBeenCalledTimes(2));
    const calls = (args.onRequest as ReturnType<typeof fn>).mock.calls;
    await expect(calls[0]).toEqual(calls[1]);
    await expect(await c.findByText(/Первісну акцію збережено/)).toBeVisible();
    await expect(c.getByRole('textbox', { name: 'Назва акції' })).toHaveValue(
      'Нові умови окремим збереженням',
    );
    await userEvent.click(c.getByRole('button', { name: 'Зберегти акцію' }));
    await waitFor(() => expect(args.onRequest).toHaveBeenCalledTimes(3));
    await expect(args.onRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: 'Нові умови окремим збереженням' }),
      expect.objectContaining({ revision: 1 }),
    );
  },
};
export const RevisionConflictPreservesDraft: Story = {
  args: { conflict: true },
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    await userEvent.click(await c.findByRole('button', { name: 'Умови акції' }));
    await userEvent.type(c.getByRole('textbox', { name: 'Причина зміни' }), 'Локальний задум');
    await userEvent.type(c.getByRole('textbox', { name: 'Назва акції' }), ' — чернетка');
    await userEvent.click(c.getByRole('button', { name: 'Зберегти акцію' }));
    await expect(await c.findByText('Акцію вже змінено. Чернетку збережено.')).toBeVisible();
    await expect(c.getByRole('textbox', { name: 'Назва акції' })).toHaveValue(
      'Вихідні з кавою — чернетка',
    );
    await expect(c.getByRole('button', { name: 'Зберегти акцію' })).toBeDisabled();
    await expect(args.onRequest).toHaveBeenCalledOnce();
    const confirm = window.confirm;
    window.confirm = () => true;
    try {
      await userEvent.click(c.getByRole('button', { name: 'Відкрити актуальні умови' }));
      await expect(
        await c.findByText('Актуальні умови недоступні. Чернетку збережено.'),
      ).toBeVisible();
      await expect(c.getByRole('textbox', { name: 'Назва акції' })).toHaveValue(
        'Вихідні з кавою — чернетка',
      );
      await expect(c.getByRole('button', { name: 'Зберегти акцію' })).toBeDisabled();
    } finally {
      window.confirm = confirm;
    }
  },
};

export const PaginationResetsForFilters: Story = {
  args: { pagination: true },
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    await userEvent.click(
      await within(await c.findByRole('navigation', { name: 'Сторінки: Кампанії' })).findByRole(
        'button',
        { name: 'Далі' },
      ),
    );
    await waitFor(() => expect(args.onList).toHaveBeenLastCalledWith({ page: 2, scope: '' }));
    const scope = c.getByRole('button', { name: /Показати кампанії/ });
    scope.focus();
    await userEvent.keyboard('{Enter}{End}{Enter}');
    await waitFor(() => expect(args.onList).toHaveBeenLastCalledWith({ page: 1, scope: 'stores' }));
    await userEvent.click(c.getByRole('button', { name: 'Журнал цін' }));
    await userEvent.click(
      await within(await c.findByRole('navigation', { name: 'Сторінки: Журнал цін' })).findByRole(
        'button',
        { name: 'Далі' },
      ),
    );
    await waitFor(() => expect(args.onHistory).toHaveBeenLastCalledWith({ page: 2 }));
    const product = c.getByRole('combobox', { name: 'Товар у журналі цін' });
    await userEvent.type(product, 'Кава');
    await waitFor(() =>
      expect(
        within(document.body).getByRole('option', { name: catalogProducts[0]!.name }),
      ).toBeVisible(),
    );
    await userEvent.keyboard('{End}{Enter}');
    await waitFor(() =>
      expect(args.onHistory).toHaveBeenLastCalledWith({ page: 1, product: catalogProducts[0]!.id }),
    );
  },
};
