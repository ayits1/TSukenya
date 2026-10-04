import { useLayoutEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { StudioView } from './StudioView';
import type { StudioFilters, StudioOutputState, StudioTab, StudioViewProps } from './StudioView';
import type { LabelConfig, LabelField } from './domain';
import { studioConfig, studioProducts, studioSettings } from './fixtures';
import { ConflictComparison } from '../../shared/ui/ConflictComparison';
import type { MergeChoices } from '../../shared/merge/threeWay';

const products = Array.from({ length: 20 }, (_, index) => ({
  ...studioProducts[0]!,
  id: 'workspace-' + index,
  name: `Товар ${index + 1} · Кава мелена, упаковка 250 г`,
}));
function DesktopWorkspace({
  readOnly = false,
  conflict = false,
}: {
  readOnly?: boolean;
  conflict?: boolean;
}) {
  useLayoutEffect(() => {
    const previous = document.body.dataset.layout;
    document.body.dataset.layout = 'studio';
    return () => {
      if (previous) document.body.dataset.layout = previous;
      else delete document.body.dataset.layout;
    };
  }, []);
  const [config, setConfig] = useState<LabelConfig>({
    ...studioConfig,
    size: 'l',
    customEnabled: true,
    custom: 'Дякуємо за покупку',
  });
  const [settings, setSettings] = useState({
    ...studioSettings,
    storeNames: Array.from({ length: 8 }, (_, i) => `Магазин ${i + 1}`),
  });
  const [field, setField] = useState<LabelField>('custom');
  const [tab, setTab] = useState<StudioTab>('design');
  const [status, setStatus] = useState<StudioViewProps['saveStatus']>(
    conflict ? 'conflict' : 'dirty',
  );
  const [choices, setChoices] = useState<MergeChoices>({});
  const [comparison, setComparison] = useState(false);
  const [selection, setSelection] = useState<Record<string, number>>({});
  const [filters, setFilters] = useState<StudioFilters>({
    q: '',
    type: '',
    category: '',
    pack: '',
    promotion: '',
  });
  const [output, setOutput] = useState<StudioOutputState | null>(null);
  const copies = Object.values(selection).reduce((sum, n) => sum + n, 0);
  const change = (value: LabelConfig) => {
    setConfig(value);
    setStatus('dirty');
  };
  return (
    <div className="tk-desktop-studio-story">
      <StudioView
        config={config}
        settings={settings}
        selectedField={field}
        onSelectField={setField}
        onConfigChange={change}
        onSettingsChange={(next) => {
          setSettings(next);
          setStatus('dirty');
        }}
        onResetField={() => change({ ...config, styles: { ...config.styles, [field]: {} } })}
        onResetTemplate={() => change(studioConfig)}
        onApplyPreset={() => change(studioConfig)}
        saveStatus={status}
        onSave={() => setStatus('saved')}
        onReload={() => setStatus('saved')}
        onCompare={() => setComparison(true)}
        comparison={
          comparison ? (
            <ConflictComparison
              rows={Array.from({ length: 12 }, (_, i) => ({
                id: String(i),
                label: `Поле ${i + 1}`,
                base: 'Чорний',
                mine: 'Зелений',
                server: 'Синій',
                status: 'conflict' as const,
              }))}
              choices={choices}
              onChoice={(id, choice) => setChoices({ ...choices, [id]: choice })}
              onApply={() => {
                setComparison(false);
                setStatus('dirty');
              }}
              onCancel={() => setComparison(false)}
            />
          ) : null
        }
        canUndo={!readOnly}
        onUndo={() => change(studioConfig)}
        canRedo={!readOnly}
        onRedo={() => change(config)}
        canEdit={!readOnly}
        selectedTab={tab}
        onTabChange={setTab}
        previewProduct={products[0]!}
        previewProducts={products}
        onPreviewProductChange={() => {}}
        onPreviewQueryChange={() => {}}
        products={products}
        selectedProducts={products.filter((p) => (selection[p.id] ?? 0) > 0)}
        selection={selection}
        onQuantityChange={(id, n) => setSelection({ ...selection, [id]: n })}
        onSelectShown={(ids) => setSelection(Object.fromEntries(ids.map((id) => [id, 1])))}
        onClearSelection={() => setSelection({})}
        filters={filters}
        facets={{ type: ['Кав’ярня'], category: ['Кава'], pack: [] }}
        onFiltersChange={setFilters}
        page={1}
        pages={1}
        total={20}
        onPageChange={() => {}}
        loading={false}
        error=""
        onReview={() => setTab('review')}
        preparing={false}
        outputBusy={output !== null}
        outputState={output}
        onCancelOutput={() => setOutput(null)}
        canOutput={copies > 0}
        onPrint={() => {}}
        onExport={() =>
          setOutput({ kind: 'pdf', stage: 'pages', completed: 1, total: 4, cancelling: false })
        }
        onCsv={() => {}}
        review={
          <div style={{ height: 900, background: '#f1f3f2', padding: 20 }}>
            Синтетичний аркуш — геометрія друку не змінюється.
          </div>
        }
        validationErrors={[]}
        staleProducts={[]}
        staleAcknowledged={false}
        onStaleAcknowledged={() => {}}
      />
    </div>
  );
}
const meta = {
  title: 'Цінники/Робочий простір',
  component: DesktopWorkspace,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof DesktopWorkspace>;
export default meta;
type Story = StoryObj<typeof meta>;
function hit(element: Element) {
  const bounds = element.getBoundingClientRect();
  const target = document.elementFromPoint(
    bounds.left + bounds.width / 2,
    bounds.top + bounds.height / 2,
  );
  return !!target && (target === element || element.contains(target));
}
export const IndependentPanesAndKeyboard: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement),
      studio = canvasElement.querySelector<HTMLElement>('.tk-studio')!;
    const desktop = matchMedia('(min-width:1200px) and (min-height:720px)').matches;
    const save = c.getByRole('button', { name: 'Зберегти макет' });
    if (desktop) {
      await waitFor(() =>
        expect(studio.getBoundingClientRect().bottom).toBeLessThanOrEqual(innerHeight),
      );
      const inspector = c.getByRole('complementary', { name: 'Параметри елемента' }),
        library = c.getByRole('complementary', { name: 'Елементи цінника' });
      await expect(getComputedStyle(inspector).overflowY).toBe('auto');
      const inspectorStart = inspector.scrollTop;
      const reset = c.getByRole('button', { name: 'Скинути цей елемент' });
      reset.focus();
      await waitFor(() => expect(hit(reset)).toBe(true));
      await expect(
        inspector.scrollTop,
        `inspector ${inspector.scrollHeight}/${inspector.clientHeight}, before=${inspectorStart}`,
      ).toBeGreaterThan(inspectorStart);
      await expect(hit(save)).toBe(true);
      const formatSummary = library.querySelector<HTMLElement>('summary')!;
      formatSummary.focus();
      await userEvent.click(formatSummary);
      await expect(c.getByRole('button', { name: /Формат цінника/ })).toBeVisible();
      await expect(hit(save)).toBe(true);
      await expect(
        library.scrollTop,
        `library ${library.scrollHeight}/${library.clientHeight}`,
      ).toBeGreaterThan(0);
      await expect(studio.scrollWidth).toBeLessThanOrEqual(studio.clientWidth + 1);
      const canvas = studio.querySelector('.tk-studio-canvas')!,
        label = canvas.querySelector('.tk-label.tag')!;
      await waitFor(() =>
        expect(label.getBoundingClientRect().bottom).toBeLessThanOrEqual(
          canvas.getBoundingClientRect().bottom + 1,
        ),
      );
    } else {
      await expect(c.getByRole('button', { name: /Елемент цінника/ })).toBeVisible();
      await expect(getComputedStyle(studio).overflowY).not.toBe('hidden');
    }
    save.focus();
    await userEvent.keyboard('{Enter}');
    await expect(save).toBeDisabled();
    await expect(c.getByRole('button', { name: 'Скасувати зміну' })).toBeVisible();
    c.getByRole('tab', { name: 'Макет' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    const list = c.getByRole('region', { name: 'Список товарів для друку' });
    const last = c.getByRole('checkbox', { name: products[19]!.name });
    last.focus();
    await userEvent.keyboard(' ');
    if (desktop) {
      await expect(
        list.scrollTop,
        `products ${list.scrollHeight}/${list.clientHeight}`,
      ).toBeGreaterThan(0);
      await expect(hit(c.getByRole('button', { name: 'Перевірити 1 цінників →' }))).toBe(true);
    }
    await userEvent.click(c.getByRole('button', { name: 'Перевірити 1 цінників →' }));
    const proof = c.getByRole('region', { name: 'Перегляд аркушів і перевірки' });
    proof.scrollTop = 800;
    const pdf = c.getByRole('button', { name: 'Завантажити PDF' });
    await expect(pdf).toBeEnabled();
    if (desktop) await expect(hit(pdf)).toBe(true);
    await userEvent.click(pdf);
    const cancel = c.getByRole('button', { name: 'Скасувати підготовку' });
    await expect(cancel).toHaveFocus();
    if (desktop) await expect(hit(cancel)).toBe(true);
    await userEvent.keyboard('{Enter}');
    await expect(pdf).toHaveFocus();
  },
};
export const ReadOnlyWorkspace: Story = { args: { readOnly: true } };
export const ConflictHasBoundedRegion: Story = {
  args: { conflict: true },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement),
      save = c.getByRole('button', { name: 'Зберегти макет' });
    await expect(save).toBeDisabled();
    await userEvent.click(c.getByRole('button', { name: 'Порівняти зміни' }));
    const notices = c.getByRole('region', { name: 'Повідомлення та узгодження змін' });
    const cancel = c.getByRole('button', { name: 'Повернутися до чернетки' });
    cancel.focus();
    if (matchMedia('(min-width:1200px) and (min-height:720px)').matches) {
      await waitFor(() => expect(notices.scrollTop).toBeGreaterThan(0));
      await expect(hit(cancel)).toBe(true);
      await expect(hit(save)).toBe(true);
    }
    await expect(c.getByRole('button', { name: 'Застосувати узгоджені зміни' })).toBeDisabled();
    await userEvent.keyboard('{Enter}');
    await expect(c.queryByRole('heading', { name: 'Порівняти зміни' })).toBeNull();
    await expect(save).toBeDisabled();
  },
};
