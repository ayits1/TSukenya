import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fireEvent, userEvent, waitFor, within } from 'storybook/test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '../../shared/api/client';
import { Button } from '../../shared/ui/Button';
import { Studio, initialStudioMemory } from './Studio';
import { adaptLabelProduct } from './domain';
import type { LabelConfig, LabelSettings } from './domain';
import { studioConfig, studioSettings } from './fixtures';
import { catalogPage, catalogProducts, catalogReferences } from '../catalog/fixtures';
import type { CatalogApi } from '../catalog/api';
import type { LabelApi, Workspace } from './api';

type Mode = 'merge' | 'failure' | 'deferred' | 'permission';
function ConflictScenario({ mode = 'merge' }: { mode?: Mode }) {
  const [writes, setWrites] = useState<
    { revision: string; config: LabelConfig; settings: LabelSettings }[]
  >([]);
  const [services] = useState(() => {
    const base: Workspace = {
      config: structuredClone(studioConfig),
      settings: structuredClone(studioSettings),
      revision: 'synthetic-base',
      csrf: 'synthetic-csrf',
      canEdit: true,
      warnings: [],
    };
    const server: Workspace = {
      ...structuredClone(base),
      revision: 'synthetic-server',
      canEdit: mode !== 'permission',
      config: {
        ...structuredClone(base.config),
        styles: { ...base.config.styles, name: { size: 20, font: 'arial' } },
      },
      settings: {
        ...base.settings,
        chainName: 'Мережа з сервера',
        storeNames: [
          'Магазин з дуже довгою українською назвою на центральній площі',
          'Другий магазин',
        ],
      },
    };
    server.config.storeIdx = 1;
    let reads = 0,
      saved = base;
    const pending: (() => void)[] = [];
    const labels: LabelApi = {
      workspace: async () => {
        reads++;
        if (reads === 1) return structuredClone(base);
        if (mode === 'failure' && reads === 2) throw new Error('Макет тимчасово недоступний.');
        if (mode === 'deferred') await new Promise<void>((resolve) => pending.push(resolve));
        return structuredClone(server);
      },
      save: async (revision, config, settings) => {
        setWrites((previous) => [
          ...previous,
          { revision, config: structuredClone(config), settings: structuredClone(settings) },
        ]);
        if (revision !== server.revision)
          throw new ApiError(409, 'Макет уже змінено на іншому пристрої.', 'revision_conflict');
        saved = {
          ...server,
          config: structuredClone(config),
          settings: structuredClone(settings),
          revision: 'synthetic-saved',
        };
        return saved;
      },
      prepare: async (selection) => ({
        ...saved,
        products: [catalogProducts[0]!],
        selection,
        date: '2026-10-04',
        snapshot: 'synthetic-proof',
      }),
    };
    const catalog: CatalogApi = {
      session: async () => ({ role: 'owner', csrf: 'synthetic' }),
      list: async () => catalogPage,
      product: async () => catalogProducts[0]!,
      save: async () => catalogProducts[0]!,
      remove: async () => true,
      references: async () => catalogReferences,
      createReference: async () => {
        throw new Error('Довідники не використовуються в цьому сценарії.');
      },
      ...{
        previewPrice: async () => ({
          regularPrice: '35.00',
          salePrice: '29.99',
          config: { markup: '30', rounding: '0.50' },
          pricingRevision: 'synthetic-pricing',
          warnings: [],
          promotionValid: true,
          effectivePromotion: null,
          effectiveDay: '2026-10-04',
          effectivePriceRevision: 'f'.repeat(64),
          priceContext: { storeId: null, storeName: null },
        }),
      },
    };
    return {
      client: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      labels,
      catalog,
      release: () => pending.shift()?.(),
      memory: {
        ...initialStudioMemory(),
        selection: { [catalogProducts[0]!.id]: 3 },
        records: {
          [catalogProducts[0]!.id]: adaptLabelProduct(
            catalogProducts[0]!,
            Number(catalogProducts[0]!.salePrice),
          ),
        },
      },
    };
  });
  return (
    <QueryClientProvider client={services.client}>
      <Studio
        api={services.labels}
        catalog={services.catalog}
        initialMemory={services.memory}
        onMemory={() => {}}
        onDirty={() => {}}
        onChanged={() => {}}
      />
      {mode === 'deferred' ? (
        <Button onPress={services.release}>Відповісти на порівняння</Button>
      ) : null}
      <output
        aria-label="Синтетичні запити збереження"
        style={{ display: 'block', overflowWrap: 'anywhere' }}
      >
        {JSON.stringify(writes)}
      </output>
    </QueryClientProvider>
  );
}
const meta = {
  title: 'Цінники/Порівняння конфлікту',
  component: ConflictScenario,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof ConflictScenario>;
export default meta;
type Story = StoryObj<typeof meta>;
const createConflict = async (canvas: ReturnType<typeof within>) => {
  const size = await canvas.findByLabelText('Розмір, pt');
  await userEvent.clear(size);
  await userEvent.type(size, '18');
  await userEvent.tab();
  fireEvent.input(canvas.getByLabelText('Колір'), { target: { value: '#123456' } });
  await userEvent.click(canvas.getByRole('button', { name: 'Зберегти макет' }));
  await canvas.findByText('Макет змінили в іншому вікні');
  return size;
};
export const IndependentMergeAndExplicitKeyboardChoice: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement),
      page = within(document.body);
    const size = await createConflict(canvas);
    await userEvent.click(canvas.getByText('Параметри шаблону та магазину'));
    await userEvent.clear(canvas.getByLabelText('Назва магазину 1'));
    await userEvent.type(canvas.getByLabelText('Назва магазину 1'), 'Мій магазин');
    await userEvent.click(canvas.getByRole('button', { name: 'Порівняти зміни' }));
    const heading = await canvas.findByRole('heading', { name: 'Порівняння макетів цінника' });
    await expect(heading).toHaveFocus();
    // The same scenario is also run at a real 320px browser viewport.
    if (window.innerWidth <= 360) {
      const panel = heading.closest('.tk-conflict')!;
      await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
      await expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth);
      for (const choice of within(panel as HTMLElement).getAllByRole('radio'))
        await expect(choice.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      const values = panel.querySelector('dl')!;
      await expect(getComputedStyle(values).gridTemplateColumns.split(' ')).toHaveLength(1);
    }
    await expect(size).toHaveValue('18');
    const apply = canvas.getByRole('button', { name: 'Застосувати узгоджені зміни' });
    await expect(apply).toBeDisabled();
    const storeGroup = canvas.getByRole('radiogroup', {
      name: 'Версія для поля «Магазини — список і вибраний магазин»',
    });
    await userEvent.tab();
    await expect(
      within(storeGroup).getByRole('radio', { name: 'Залишити мої зміни' }),
    ).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    await expect(
      within(storeGroup).getByRole('radio', { name: 'Взяти зміни сервера' }),
    ).toBeChecked();
    await userEvent.tab();
    const sizeGroup = canvas.getByRole('radiogroup', {
      name: 'Версія для поля «Назва товару — Розмір шрифту»',
    });
    await expect(
      within(sizeGroup).getByRole('radio', { name: 'Залишити мої зміни' }),
    ).toHaveFocus();
    await userEvent.keyboard(' ');
    await expect(apply).toBeEnabled();
    await userEvent.click(apply);
    await expect(canvas.getByLabelText('Розмір, pt')).toHaveValue('18');
    await expect(canvas.getByLabelText('Колір')).toHaveValue('#123456');
    await expect(canvas.getByRole('button', { name: /Шрифт/ })).toHaveTextContent('Arial');
    await expect(canvas.getByLabelText('Назва мережі')).toHaveValue('Мережа з сервера');
    await expect(canvas.getByLabelText('Назва магазину 1')).toHaveValue(
      'Магазин з дуже довгою українською назвою на центральній площі',
    );
    await expect(canvas.getByRole('button', { name: /Магазин на ціннику/ })).toHaveTextContent(
      'Другий магазин',
    );
    await expect(canvas.getByRole('button', { name: 'Скасувати зміну' })).toBeDisabled();
    await expect(
      JSON.parse(canvas.getByLabelText('Синтетичні запити збереження').textContent!),
    ).toHaveLength(1);
    await userEvent.click(canvas.getByRole('tab', { name: /Товари для друку/ }));
    await expect(canvas.getByRole('checkbox', { name: catalogProducts[0]!.name })).toBeChecked();
    await expect(canvas.getByLabelText(`Копій: ${catalogProducts[0]!.name}`)).toHaveValue('3');
    await userEvent.click(canvas.getByRole('tab', { name: 'Перевірка перед друком' }));
    await expect(canvas.getByRole('button', { name: 'Завантажити PDF' })).toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: 'Зберегти макет' }));
    await canvas.findByText('Макет збережено');
    const requests = JSON.parse(canvas.getByLabelText('Синтетичні запити збереження').textContent!);
    await expect(requests).toHaveLength(2);
    await expect(requests[1].revision).toBe('synthetic-server');
    // Confirm the save is separate from choosing and applying a comparison.
    await expect(
      page.queryByRole('heading', { name: 'Порівняння макетів цінника' }),
    ).not.toBeInTheDocument();
  },
};
export const FailedReadAndCancelPreserveDraft: Story = {
  args: { mode: 'failure' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement),
      size = await createConflict(canvas);
    await userEvent.click(canvas.getByRole('button', { name: 'Порівняти зміни' }));
    await canvas.findByText(/Не вдалося завантажити порівняння/);
    await expect(size).toHaveValue('18');
    await expect(canvas.getByRole('button', { name: 'Скасувати зміну' })).toBeEnabled();
    await userEvent.click(canvas.getByRole('button', { name: 'Порівняти зміни' }));
    await canvas.findByRole('heading', { name: 'Порівняння макетів цінника' });
    await userEvent.click(canvas.getByRole('button', { name: 'Повернутися до чернетки' }));
    await waitFor(() =>
      expect(canvas.getByRole('button', { name: 'Порівняти зміни' })).toHaveFocus(),
    );
    await expect(size).toHaveValue('18');
    await expect(canvas.getByLabelText('Колір')).toHaveValue('#123456');
    await expect(canvas.getByRole('button', { name: 'Зберегти макет' })).toBeDisabled();
  },
};
export const CancelAndLateResponsePreserveNewerEdits: Story = {
  args: { mode: 'deferred' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement),
      size = await createConflict(canvas);
    await userEvent.click(canvas.getByRole('button', { name: 'Порівняти зміни' }));
    await canvas.findByRole('button', { name: 'Скасувати порівняння' });
    await userEvent.click(canvas.getByRole('button', { name: 'Скасувати порівняння' }));
    await waitFor(() =>
      expect(canvas.getByRole('button', { name: 'Порівняти зміни' })).toHaveFocus(),
    );
    await userEvent.click(canvas.getByRole('button', { name: 'Відповісти на порівняння' }));
    await expect(size).toHaveValue('18');
    await userEvent.click(canvas.getByRole('button', { name: 'Порівняти зміни' }));
    await canvas.findByRole('button', { name: 'Скасувати порівняння' });
    await userEvent.clear(size);
    await userEvent.type(size, '21');
    await userEvent.tab();
    await userEvent.click(canvas.getByRole('button', { name: 'Відповісти на порівняння' }));
    await expect(size).toHaveValue('21');
    await expect(
      canvas.queryByRole('heading', { name: 'Порівняння макетів цінника' }),
    ).not.toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: 'Скасувати зміну' })).toBeEnabled();
    await expect(canvas.getByRole('button', { name: 'Порівняти зміни' })).toBeEnabled();
  },
};
export const PermissionChangedAllowsCancel: Story = {
  args: { mode: 'permission' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement),
      size = await createConflict(canvas);
    await userEvent.click(canvas.getByRole('button', { name: 'Порівняти зміни' }));
    await canvas.findByRole('heading', { name: 'Порівняння макетів цінника' });
    await expect(
      canvas.getByRole('button', { name: 'Застосувати узгоджені зміни' }),
    ).toBeDisabled();
    await expect(canvas.getByRole('button', { name: 'Повернутися до чернетки' })).toBeEnabled();
    await userEvent.click(canvas.getByRole('button', { name: 'Повернутися до чернетки' }));
    await expect(size).toHaveValue('18');
  },
};
