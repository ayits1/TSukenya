import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { StudioView } from './StudioView';
import type { StudioTab, StudioFilters, StudioViewProps } from './StudioView';
import { defaultConfig } from './domain';
import type { LabelField, LabelConfig } from './domain';
import { studioProducts, studioConfig, studioSettings } from './fixtures';

function Demo({
  initialTab = 'design',
  empty = false,
  readOnly = false,
  conflict = false,
  twoStores = false,
  promotion = false,
  loading = false,
}: {
  initialTab?: StudioTab;
  empty?: boolean;
  readOnly?: boolean;
  conflict?: boolean;
  twoStores?: boolean;
  promotion?: boolean;
  loading?: boolean;
}) {
  const [config, setConfig] = useState<LabelConfig>({
    ...studioConfig,
    storeIdx: twoStores ? 1 : 0,
  });
  const [settings, setSettings] = useState({
    ...studioSettings,
    storeNames: twoStores ? ['Перший магазин', 'Другий магазин'] : studioSettings.storeNames,
  });
  const [field, setField] = useState<LabelField>('price');
  const [tab, setTab] = useState(initialTab);
  const [previewId, setPreviewId] = useState<string | null>(
    empty ? null : studioProducts[promotion ? 1 : 0]!.id,
  );
  const [selection, setSelection] = useState<Record<string, number>>({});
  const [filters, setFilters] = useState<StudioFilters>({
    q: '',
    type: '',
    category: '',
    pack: '',
    promotion: '',
  });
  const [status, setStatus] = useState<StudioViewProps['saveStatus']>(
    conflict ? 'conflict' : 'saved',
  );
  const [acknowledged, setAcknowledged] = useState(false);
  const change = (value: LabelConfig) => {
    setConfig(value);
    setStatus('dirty');
  };
  const products = empty
    ? []
    : studioProducts.filter(
        (product) =>
          product.name.toLocaleLowerCase('uk-UA').includes(filters.q.toLocaleLowerCase('uk-UA')) &&
          (!filters.type || product.type === filters.type) &&
          (!filters.category || product.category === filters.category) &&
          (!filters.promotion || product.promotion === (filters.promotion === 'yes')),
      );
  const selected = studioProducts.filter((product) => (selection[product.id] ?? 0) > 0);
  return (
    <StudioView
      config={config}
      settings={settings}
      selectedField={field}
      onSelectField={setField}
      onConfigChange={change}
      onSettingsChange={(value, storeIdx) => {
        setSettings(value);
        if (storeIdx !== undefined) setConfig((current) => ({ ...current, storeIdx }));
        setStatus('dirty');
      }}
      onResetField={() => change({ ...config, styles: { ...config.styles, [field]: {} } })}
      onResetTemplate={() => change(defaultConfig())}
      onApplyPreset={() => change(studioConfig)}
      saveStatus={status}
      onSave={() => setStatus('saved')}
      onReload={() => {
        setConfig(studioConfig);
        setStatus('saved');
      }}
      canEdit={!readOnly}
      selectedTab={tab}
      onTabChange={setTab}
      previewProduct={studioProducts.find((product) => product.id === previewId) ?? null}
      previewProducts={empty ? [] : studioProducts}
      onPreviewProductChange={setPreviewId}
      onPreviewQueryChange={() => {}}
      products={products}
      selectedProducts={selected}
      selection={selection}
      onQuantityChange={(id, quantity) =>
        setSelection((current) => ({ ...current, [id]: quantity }))
      }
      onSelectShown={(ids) =>
        setSelection((current) => ({ ...current, ...Object.fromEntries(ids.map((id) => [id, 1])) }))
      }
      onClearSelection={() => setSelection({})}
      filters={filters}
      facets={{
        type: ['Кав’ярня', 'Солодощі', 'Напої'],
        category: ['Кава', 'Шоколад', 'Вода'],
        pack: [],
      }}
      onFiltersChange={setFilters}
      page={1}
      pages={1}
      total={products.length}
      onPageChange={() => {}}
      loading={loading}
      error={
        conflict
          ? 'Шаблон змінено в іншому вікні. Завантажте поточний макет перед збереженням.'
          : ''
      }
      onReview={() => setTab('review')}
      preparing={false}
      outputBusy={false}
      canOutput={selected.length > 0 && selected.every((product) => product.salePrice > 0)}
      onPrint={() => {}}
      onExport={() => {}}
      review={
        <div className="tk-studio-empty">
          Аркуші друку з’являться після підготовки вибраних товарів.
        </div>
      }
      validationErrors={
        selected.some((product) => product.salePrice <= 0)
          ? ['Вода мінеральна негазована 0,5 л: немає ціни.']
          : []
      }
      staleProducts={[]}
      staleAcknowledged={acknowledged}
      onStaleAcknowledged={setAcknowledged}
    />
  );
}
const meta = {
  title: 'Цінники/Студія',
  component: Demo,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof Demo>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Template: Story = {};
export const PromotionPrices: Story = {
  args: { promotion: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const oldPrice = canvasElement.querySelector('[data-field=oldPrice]')!;
    await expect(oldPrice).toHaveTextContent('99,00 грн');
    await expect(getComputedStyle(oldPrice).textDecorationLine).toBe('line-through');
    await expect(canvasElement.querySelector('[data-field=price]')).toHaveTextContent('79,50');
    await userEvent.click(canvas.getByRole('button', { name: 'Стара ціна' }));
    await userEvent.clear(canvas.getByLabelText('Розмір, pt'));
    await userEvent.type(canvas.getByLabelText('Розмір, pt'), '11');
    await userEvent.tab();
    await expect((oldPrice as HTMLElement).style.fontSize).toBe('11pt');
    await expect(canvasElement.querySelector('[data-field=price]')).toHaveTextContent('79,50');
  },
};
export const Empty: Story = { args: { empty: true } };
export const ReadOnly: Story = { args: { readOnly: true } };
export const Conflict: Story = { args: { conflict: true } };
export const Products: Story = { args: { initialTab: 'products' } };
export const LoadingProducts: Story = {
  args: { initialTab: 'products', loading: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('checkbox', { name: 'Американо' })).toBeDisabled();
    await expect(canvas.getByLabelText('Копій: Американо')).toBeDisabled();
    await expect(canvas.getByRole('button', { name: 'Обрати цю сторінку' })).toBeDisabled();
  },
};
export const EditAndSave: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Назва товару' }));
    const size = canvas.getByLabelText('Розмір, pt');
    await userEvent.clear(size);
    await userEvent.type(size, '14');
    await userEvent.tab();
    await expect(canvas.getByText('Є незбережені зміни')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Зберегти макет' }));
    await expect(canvas.getByText('Макет збережено')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Очистити товар для перегляду' }));
    await expect(
      canvas.getByRole('heading', { name: 'Оберіть товар для перегляду' }),
    ).toBeVisible();
  },
};
export const Selection: Story = {
  args: { initialTab: 'products' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('checkbox', { name: 'Американо' }));
    const copies = canvas.getByLabelText('Копій: Американо');
    await userEvent.clear(copies);
    await userEvent.type(copies, '3');
    await userEvent.tab();
    await expect(canvas.getByText('Обрано 1 товарів · 3 цінників')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Перевірити 3 цінників →' }));
    await expect(canvas.getByRole('heading', { name: 'Переддруковий перегляд' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Друкувати' })).toBeEnabled();
  },
};

export const RemoveStore: Story = {
  args: { twoStores: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText('Параметри шаблону та магазину'));
    await userEvent.click(canvas.getByRole('button', { name: 'Видалити магазин 1' }));
    await expect(canvas.getByLabelText('Назва магазину 1')).toHaveValue('Другий магазин');
    await expect(canvas.queryByLabelText('Назва магазину 2')).not.toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: /Магазин на ціннику/ })).toHaveTextContent(
      'Другий магазин',
    );
    await expect(canvas.getByText('Є незбережені зміни')).toBeVisible();
  },
};
