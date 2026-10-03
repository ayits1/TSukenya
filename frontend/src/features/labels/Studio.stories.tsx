import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { StudioView } from './StudioView';
import type { StudioOutputState, StudioTab, StudioFilters, StudioViewProps } from './StudioView';
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
  outputDemo = false,
  initialFilters = {},
  onPreset,
}: {
  initialTab?: StudioTab;
  empty?: boolean;
  readOnly?: boolean;
  conflict?: boolean;
  twoStores?: boolean;
  promotion?: boolean;
  loading?: boolean;
  outputDemo?: boolean;
  initialFilters?: Partial<StudioFilters>;
  onPreset?: (preset: string) => void;
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
  const [selection, setSelection] = useState<Record<string, number>>(
    outputDemo ? { [studioProducts[0]!.id]: 22 } : {},
  );
  const [outputState, setOutputState] = useState<StudioOutputState | null>(null);
  const [outputStatus, setOutputStatus] = useState('');
  const [filters, setFilters] = useState<StudioFilters>({
    q: '',
    type: '',
    category: '',
    pack: '',
    promotion: '',
    ...initialFilters,
  });
  const [previewQuery, setPreviewQuery] = useState('');
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
  const previewProduct = studioProducts.find((product) => product.id === previewId) ?? null;
  // Synthetic server search: every typed word may appear anywhere in the name.
  const previewWords = previewQuery.toLocaleLowerCase('uk-UA').split(/\s+/).filter(Boolean);
  const previewProducts = empty
    ? []
    : studioProducts.filter((product) =>
        previewWords.every((word) => product.name.toLocaleLowerCase('uk-UA').includes(word)),
      );
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
      onApplyPreset={(preset) => {
        onPreset?.(preset);
        change(studioConfig);
      }}
      saveStatus={status}
      onSave={() => setStatus('saved')}
      onReload={() => {
        setConfig(studioConfig);
        setStatus('saved');
      }}
      canEdit={!readOnly}
      selectedTab={tab}
      onTabChange={setTab}
      previewProduct={previewProduct}
      previewProducts={previewProducts}
      onPreviewProductChange={(id) => {
        setPreviewId(id);
        setPreviewQuery('');
      }}
      onPreviewQueryChange={(value) => setPreviewQuery(value === previewProduct?.name ? '' : value)}
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
      outputBusy={outputState !== null}
      outputState={outputState}
      outputStatus={outputStatus}
      onCancelOutput={() => {
        setOutputState(null);
        setOutputStatus('Підготовку скасовано. Товари й кількість копій збережені.');
      }}
      canOutput={selected.length > 0 && selected.every((product) => product.salePrice > 0)}
      onPrint={() => {}}
      onExport={() => {
        // Synthetic progress for visual/keyboard review; actual generation has separate stories.
        if (outputDemo) {
          setOutputStatus('');
          setOutputState({
            kind: 'pdf',
            stage: 'pages',
            completed: 1,
            total: 2,
            cancelling: false,
          });
        }
      }}
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
export const OutputProgressAndKeyboardCancel: Story = {
  args: { initialTab: 'review', outputDemo: true },
  decorators: [
    (Story) => (
      <div style={{ width: 320, maxWidth: '100%' }}>
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const exportButton = canvas.getByRole('button', { name: 'Завантажити PDF' });
    for (let attempt = 0; attempt < 2; attempt++) {
      await userEvent.click(exportButton);
      const cancel = canvas.getByRole('button', { name: 'Скасувати підготовку' });
      await expect(cancel).toHaveFocus();
      await expect(exportButton).toBeDisabled();
      await expect(canvas.getByRole('progressbar', { name: 'Підготовка PDF' })).toHaveAttribute(
        'value',
        '1',
      );
      await expect(canvas.getByText('PDF: сторінок готово 1 з 2.')).toBeVisible();
      const area = canvasElement.querySelector('.tk-studio-output')!;
      await expect(area.scrollWidth).toBeLessThanOrEqual(area.clientWidth + 1);
      await expect(cancel.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      await userEvent.keyboard('{Enter}');
      await expect(exportButton).toBeEnabled();
      await expect(exportButton).toHaveFocus();
      await expect(
        canvas.getByText('Підготовку скасовано. Товари й кількість копій збережені.'),
      ).toBeVisible();
      await expect(canvas.queryByRole('progressbar')).not.toBeInTheDocument();
    }
  },
};
export const LoadingProducts: Story = {
  args: { initialTab: 'products', loading: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('checkbox', { name: 'Американо' })).toBeDisabled();
    await expect(canvas.getByLabelText('Копій: Американо')).toBeDisabled();
    await expect(canvas.getByRole('button', { name: 'Обрати цю сторінку' })).toBeDisabled();
    await expect(canvas.getByRole('combobox', { name: 'Категорія' })).toBeDisabled();
    await expect(canvas.getByRole('combobox', { name: 'Група' })).toBeEnabled();
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
export const PreviewServerSearch: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const page = within(document.body);
    const chocolate = studioProducts[1]!.name;
    const input = canvas.getByRole('combobox', { name: 'Товар для перегляду' });
    await userEvent.click(input);
    await userEvent.clear(input);
    // The words are not contiguous in the name; the server's match is shown as returned.
    await userEvent.type(input, 'шоколад горіхами');
    await waitFor(() =>
      expect(page.queryAllByRole('option').map((option) => option.textContent)).toEqual([
        chocolate,
      ]),
    );
    await userEvent.keyboard('{ArrowDown}{Enter}');
    await expect(input).toHaveValue(chocolate);
    await expect(
      canvasElement.querySelector('.tk-studio-canvas [data-field=name]'),
    ).toHaveTextContent(chocolate);
  },
};
export const FiltersOutsideCurrentFacets: Story = {
  args: { initialTab: 'products', initialFilters: { type: 'Морозиво', category: 'Пломбір' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'Товарів не знайдено' })).toBeVisible();
    // The active filters remain visible although the facets no longer list them.
    await expect(canvas.getByRole('combobox', { name: 'Група' })).toHaveValue('Морозиво');
    await expect(canvas.getByRole('combobox', { name: 'Категорія' })).toHaveValue('Пломбір');
  },
};
export const PresetCanBeReapplied: Story = {
  args: { onPreset: fn() },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const page = within(document.body);
    await userEvent.click(canvas.getByText('Параметри шаблону та магазину'));
    const trigger = canvas.getByRole('button', { name: /Готове оформлення/ });
    for (const attempt of [1, 2]) {
      await userEvent.click(trigger);
      await userEvent.click(await page.findByRole('option', { name: 'Стандартне' }));
      await expect(args.onPreset).toHaveBeenCalledTimes(attempt);
      await expect(args.onPreset).toHaveBeenLastCalledWith('standard');
      // The choice is an action: nothing stays selected, so the same preset can be chosen again.
      await expect(trigger).toHaveTextContent('Оберіть варіант');
    }
    await expect(trigger).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    await expect(await page.findByRole('option', { name: 'Стандартне' })).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}{Enter}');
    await expect(args.onPreset).toHaveBeenLastCalledWith('promotion');
    await expect(trigger).toHaveFocus();
    await expect(trigger).toHaveTextContent('Оберіть варіант');
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
