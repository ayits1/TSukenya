import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within, waitFor } from 'storybook/test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '../../shared/api/client';
import { ProductEditor } from './ProductEditor';
import { catalogProducts, catalogReferences, catalogPage, fixturePricePreview } from './fixtures';
import type { CatalogApi, PricePreview, PricePreviewRequest, Product } from './api';
import './catalog.css';

const product: Product = {
  ...catalogProducts[0]!,
  manualPrice: false,
  price: null,
  cost: '10.01',
  markup: '30',
  regularPrice: '13.50',
  salePrice: '13.50',
  promotion: false,
  promotionPrice: null,
};
function calculated(input: PricePreviewRequest): PricePreview {
  const regular =
    input.manualPrice && input.price
      ? input.price
      : input.markup === '40'
        ? '14.50'
        : input.markup === '50'
          ? '15.50'
          : '13.50';
  return {
    regularPrice: regular,
    salePrice: input.promotion && input.promotionPrice ? input.promotionPrice : regular,
    config: { markup: '30', rounding: '.5' },
    pricingRevision: 'synthetic-policy',
    warnings: [],
    promotionValid: !!input.promotion && !!input.promotionPrice,
    effectivePromotion: null,
    effectiveDay: '2026-10-04',
    effectivePriceRevision: 'f'.repeat(64),
    priceContext: { storeId: null, storeName: null },
  };
}
const api: CatalogApi = {
  session: async () => ({ role: 'owner', csrf: 'synthetic' }),
  list: async () => catalogPage,
  product: async () => product,
  remove: async () => true,
  save: fn(async () => product),
  references: async () => catalogReferences,
  createReference: async () => {
    throw new Error('Додавання довідника тут не використовується.');
  },
  previewPrice: async (input) => calculated(input),
};
const meta = {
  title: 'Catalogue/Editor Preview and Conflicts',
  component: ProductEditor,
  args: {
    product,
    defaultMarkup: '30',
    api,
    onClose: fn(),
    onSaved: fn(),
    onDirty: fn(),
    onDeleted: fn(),
  },
  render: function Render(args) {
    const [client] = useState(() => new QueryClient());
    return (
      <QueryClientProvider client={client}>
        <ProductEditor {...args} />
      </QueryClientProvider>
    );
  },
} satisfies Meta<typeof ProductEditor>;
export default meta;
type Story = StoryObj<typeof meta>;
const form = () => within(within(document.body).getByRole('dialog'));
const ready = async () => {
  await waitFor(() => expect(form().getByRole('button', { name: 'Зберегти товар' })).toBeEnabled());
};

export const PriceAndManualDraft: Story = {
  play: async ({ args }) => {
    const ui = form();
    await ready();
    const markup = ui.getByRole('textbox', { name: 'Націнка, %' });
    await userEvent.clear(markup);
    await userEvent.type(markup, '40');
    await expect(ui.getByRole('button', { name: 'Зберегти товар' })).toBeDisabled();
    await ready();
    await expect(ui.getAllByText('14,50 грн', { selector: 'strong' })).toHaveLength(2);
    const manual = ui.getByRole('checkbox', { name: 'Задати ціну продажу вручну' });
    await userEvent.click(manual);
    await expect(ui.getByRole('textbox', { name: 'Звичайна ціна: гривні' })).toHaveValue('14');
    const cents = ui.getByRole('textbox', { name: 'Звичайна ціна: копійки' });
    await userEvent.clear(cents);
    await userEvent.type(cents, '05');
    await userEvent.click(manual);
    await ready();
    await userEvent.click(manual);
    await expect(ui.getByRole('textbox', { name: 'Звичайна ціна: копійки' })).toHaveValue('05');
    await ready();
    await userEvent.click(ui.getByRole('button', { name: 'Зберегти товар' }));
    await expect(args.api.save).toHaveBeenCalledWith(
      expect.objectContaining({
        price: '14.05',
        manualPrice: true,
        pricingRevision: 'synthetic-policy',
      }),
      product.id,
    );
  },
};

export const LatePreviewCannotWin: Story = {
  render: function Render(args) {
    const [services] = useState(() => {
      let release: (() => void) | undefined;
      return {
        client: new QueryClient(),
        release: () => release?.(),
        api: {
          ...api,
          previewPrice: fn(async (input: PricePreviewRequest) => {
            if (input.markup === '40')
              await new Promise<void>((resolve) => {
                release = resolve;
              });
            return calculated(input);
          }),
        },
      };
    });
    return (
      <QueryClientProvider client={services.client}>
        <ProductEditor {...args} api={services.api} />
        <button onClick={services.release}>Відповісти на старий preview</button>
      </QueryClientProvider>
    );
  },
  play: async () => {
    const ui = form();
    await ready();
    const markup = ui.getByRole('textbox', { name: 'Націнка, %' });
    await userEvent.clear(markup);
    await userEvent.type(markup, '40');
    await waitFor(() => expect(ui.getByText('Розраховуємо актуальну ціну…')).toBeVisible());
    await new Promise((resolve) => setTimeout(resolve, 300));
    await userEvent.clear(markup);
    await userEvent.type(markup, '50');
    await ready();
    await expect(ui.getAllByText('15,50 грн', { selector: 'strong' })).toHaveLength(2);
    // The controlling button lives behind the modal; invoke its synthetic service without altering focus.
    within(document.body)
      .getByRole('button', { name: 'Відповісти на старий preview', hidden: true })
      .click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await expect(ui.getAllByText('15,50 грн', { selector: 'strong' })).toHaveLength(2);
    await expect(ui.queryByText('14,50 грн', { selector: 'strong' })).toBeNull();
  },
};

const fresh: Product = { ...product, name: 'Оновлено на сервері', revision: 'synthetic-fresh' };
export const IndependentChangesAndRepeatedConflict: Story = {
  args: {
    api: {
      ...api,
      product: fn(async () => fresh),
      save: fn(async () => {
        throw new ApiError(409, 'Товар змінено на іншому пристрої.', 'revision_conflict');
      }),
    },
  },
  play: async ({ args }) => {
    const ui = form();
    await ready();
    const pack = ui.getByRole('combobox', { name: 'Пакування' });
    await userEvent.clear(pack);
    await userEvent.type(pack, 'Коробка');
    await userEvent.keyboard('{ArrowDown}{Enter}');
    await userEvent.click(ui.getByRole('button', { name: 'Зберегти товар' }));
    await userEvent.click(await ui.findByRole('button', { name: 'Порівняти зміни' }));
    await expect(await ui.findByRole('heading', { name: 'Порівняти зміни' })).toHaveFocus();
    await expect(ui.getByRole('textbox', { name: 'Назва товару' })).toHaveValue(product.name);
    await expect(args.api.save).toHaveBeenCalledTimes(1);
    await userEvent.click(ui.getByRole('button', { name: 'Застосувати узгоджені зміни' }));
    await expect(ui.getByRole('textbox', { name: 'Назва товару' })).toHaveValue(fresh.name);
    await expect(pack).toHaveValue('Коробка');
    await expect(args.api.save).toHaveBeenCalledTimes(1);
    await ready();
    await userEvent.click(ui.getByRole('button', { name: 'Зберегти товар' }));
    await expect(args.api.save).toHaveBeenLastCalledWith(
      expect.objectContaining({
        revision: fresh.revision,
        name: fresh.name,
        pack: 'Коробка',
        pricingRevision: 'synthetic-policy',
      }),
      product.id,
    );
    await expect(await ui.findByRole('button', { name: 'Порівняти зміни' })).toBeVisible();
    await expect(pack).toHaveValue('Коробка');
  },
};

export const SamePriceRequiresChoiceAndCancelPreservesDraft: Story = {
  args: {
    product: catalogProducts[0]!,
    api: {
      ...api,
      previewPrice: fixturePricePreview,
      product: async () => ({
        ...catalogProducts[0]!,
        revision: 'synthetic-price-fresh',
        price: '40',
        regularPrice: '40.00',
      }),
      save: fn(async () => {
        throw new ApiError(409, 'Ціну змінено на іншому пристрої.', 'revision_conflict');
      }),
    },
  },
  play: async ({ args }) => {
    const ui = form();
    await ready();
    const price = ui.getByRole('textbox', { name: 'Звичайна ціна: гривні' });
    await userEvent.clear(price);
    await userEvent.type(price, '38');
    await ready();
    await userEvent.click(ui.getByRole('button', { name: 'Зберегти товар' }));
    const compare = await ui.findByRole('button', { name: 'Порівняти зміни' });
    await userEvent.click(compare);
    await expect(
      await ui.findByRole('button', { name: 'Застосувати узгоджені зміни' }),
    ).toBeDisabled();
    await userEvent.click(ui.getByRole('button', { name: 'Повернутися до чернетки' }));
    await expect(price).toHaveValue('38');
    await waitFor(() => expect(ui.getByRole('button', { name: 'Порівняти зміни' })).toHaveFocus());
    await userEvent.keyboard('{Enter}');
    await userEvent.click(await ui.findByRole('radio', { name: 'Залишити мої зміни' }));
    await userEvent.click(ui.getByRole('button', { name: 'Застосувати узгоджені зміни' }));
    await expect(price).toHaveValue('38');
    await expect(args.api.save).toHaveBeenCalledTimes(1);
  },
};

export const PreviewFailureAndRetry: Story = {
  render: function Render(args) {
    const [services] = useState(() => {
      let requests = 0;
      return {
        client: new QueryClient(),
        api: {
          ...api,
          previewPrice: async (input: PricePreviewRequest) => {
            if (++requests === 1) throw new Error('Не вдалося розрахувати ціну. Спробуйте ще раз.');
            return calculated(input);
          },
        },
      };
    });
    return (
      <QueryClientProvider client={services.client}>
        <ProductEditor {...args} api={services.api} />
      </QueryClientProvider>
    );
  },
  play: async () => {
    const ui = form();
    await expect(await ui.findByRole('alert')).toHaveTextContent('Не вдалося розрахувати ціну');
    await expect(ui.getByRole('button', { name: 'Зберегти товар' })).toBeDisabled();
    await userEvent.click(ui.getByRole('button', { name: 'Повторити розрахунок ціни' }));
    await ready();
  },
};

export const ChangedPricingPolicyNeedsFreshBaseline: Story = {
  render: function Render(args) {
    const [services] = useState(() => {
      let changed = false;
      const current = { ...product, revision: 'synthetic-new-policy-product' };
      return {
        client: new QueryClient(),
        api: {
          ...api,
          product: async () => current,
          previewPrice: async (input: PricePreviewRequest) => {
            if (changed && input.revision !== current.revision)
              throw new ApiError(
                409,
                'Товар змінився разом із політикою округлення.',
                'revision_conflict',
              );
            return {
              ...calculated(input),
              pricingRevision: changed ? 'synthetic-policy-2' : 'synthetic-policy',
            };
          },
          save: async (input) => {
            if (!changed) {
              changed = true;
              throw new ApiError(409, 'Політику округлення змінено.', 'pricing_revision_conflict');
            }
            if (
              input.pricingRevision !== 'synthetic-policy-2' ||
              !('revision' in input) ||
              input.revision !== current.revision
            )
              throw new Error('Чернетка має отримати нову політику та версію товару.');
            return current;
          },
        } satisfies CatalogApi,
      };
    });
    return (
      <QueryClientProvider client={services.client}>
        <ProductEditor {...args} api={services.api} />
      </QueryClientProvider>
    );
  },
  play: async ({ args }) => {
    const ui = form();
    await ready();
    await userEvent.click(ui.getByRole('button', { name: 'Зберегти товар' }));
    await userEvent.click(await ui.findByRole('button', { name: 'Оновити розрахунок ціни' }));
    await userEvent.click(await ui.findByRole('button', { name: 'Порівняти зміни' }));
    await userEvent.click(await ui.findByRole('button', { name: 'Застосувати узгоджені зміни' }));
    await ready();
    await userEvent.click(ui.getByRole('button', { name: 'Зберегти товар' }));
    await waitFor(() =>
      expect(args.onSaved).toHaveBeenCalledWith(
        expect.objectContaining({ revision: 'synthetic-new-policy-product' }),
      ),
    );
  },
};
