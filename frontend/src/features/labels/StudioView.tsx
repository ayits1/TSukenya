import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Checkbox,
  Group,
  Input,
  Label as FieldLabel,
  NumberField,
  Tab,
  TabList,
  TabPanel,
  Tabs,
} from 'react-aria-components';
import { Button } from '../../shared/ui/Button';
import { ComboBox } from '../../shared/ui/ComboBox';
import { Select } from '../../shared/ui/Select';
import { TextField } from '../../shared/ui/TextField';
import { Label } from './Label';
import {
  fieldStyle,
  fieldVisible,
  LABEL_FIELDS,
  LABEL_SIZES,
  formatLabelMoney,
  withFieldStyle,
} from './domain';
import type { LabelConfig, LabelField, LabelProduct, LabelSettings, LabelStyle } from './domain';
import type { LabelOutputProgress } from './output';
import { pageGeometry } from './domain';
import './studio.css';

export type StudioTab = 'design' | 'products' | 'review';
export type StudioOutputState = {
  kind: 'pdf' | 'print' | 'csv';
  stage: 'verify' | 'module' | LabelOutputProgress['stage'];
  completed: number;
  total: number;
  cancelling: boolean;
};
export type StudioFilters = {
  q: string;
  type: string;
  category: string;
  pack: string;
  promotion: string;
};
export type StudioViewProps = {
  config: LabelConfig;
  settings: LabelSettings;
  previewSettings?: LabelSettings;
  previewConfig?: LabelConfig;
  selectedField: LabelField;
  onSelectField: (field: LabelField) => void;
  /** `mergeKey`: consecutive changes with the same key form one undo step (e.g. a colour drag). */
  onConfigChange: (config: LabelConfig, mergeKey?: string) => void;
  onSettingsChange: (settings: LabelSettings, storeIdx?: number) => void;
  onResetField: () => void;
  onResetTemplate: () => void;
  onApplyPreset: (preset: PresetId) => void;
  saveStatus: 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';
  onSave: () => void;
  onReload: () => void;
  onCompare?: (trigger: HTMLButtonElement) => void;
  comparisonBusy?: boolean;
  comparison?: ReactNode;
  operationReview?: ReactNode;
  canUndo?: boolean;
  onUndo?: () => void;
  canRedo?: boolean;
  onRedo?: () => void;
  onCsv?: () => void;
  previewWarnings?: string[];
  canEdit: boolean;
  selectedTab: StudioTab;
  onTabChange: (tab: StudioTab) => void;
  previewProduct: LabelProduct | null;
  /** Server search results for the typed preview text; listed without a second filter. */
  previewProducts: LabelProduct[];
  previewLoading?: boolean;
  onPreviewProductChange: (id: string | null) => void;
  onPreviewQueryChange: (query: string) => void;
  products: LabelProduct[];
  selectedProducts: LabelProduct[];
  selection: Record<string, number>;
  onQuantityChange: (id: string, quantity: number) => void;
  onSelectShown: (ids: string[]) => void;
  onClearSelection: () => void;
  filters: StudioFilters;
  facets: { type: string[]; category: string[]; pack: string[] };
  onFiltersChange: (filters: StudioFilters) => void;
  page: number;
  pages: number;
  total: number;
  onPageChange: (page: number) => void;
  loading: boolean;
  error: string;
  onRetryProducts?: () => void;
  retryingProducts?: boolean;
  onReview: () => void;
  preparing: boolean;
  outputBusy: boolean;
  outputState?: StudioOutputState | null;
  outputStatus?: string;
  onCancelOutput?: () => void;
  canOutput: boolean;
  onPrint: () => void;
  onExport: () => void;
  review: ReactNode;
  validationErrors: string[];
  staleProducts: string[];
  staleAcknowledged: boolean;
  onStaleAcknowledged: (acknowledged: boolean) => void;
};
function outputMessage(state: StudioOutputState): string {
  if (state.cancelling) return 'Скасовуємо підготовку…';
  if (state.stage === 'verify') return 'Звіряємо актуальні ціни й макет…';
  if (state.stage === 'module') return 'Завантажуємо модуль підготовки файлу…';
  if (state.stage === 'fonts') return 'Готуємо шрифти цінників…';
  if (state.stage === 'pages') return `PDF: сторінок готово ${state.completed} з ${state.total}.`;
  if (state.stage === 'download') return 'Формуємо файл для завантаження…';
  if (state.stage === 'print') return 'Відкриваємо системний діалог друку…';
  return `Готуємо цінники: ${state.completed} з ${state.total}.`;
}
const fieldName = (key: LabelField) => LABEL_FIELDS.find(([field]) => field === key)?.[1] ?? key;
// An active filter stays visible even when the current facets no longer contain its value.
const choices = (values: string[], all: string, selected: string) => [
  { id: '*', label: all },
  ...(selected && !values.includes(selected) ? [{ id: selected, label: selected }] : []),
  ...values.map((value) => ({ id: value, label: value })),
];
const PRESETS = [
  { id: 'standard', label: 'Стандартне' },
  { id: 'promotion', label: 'Акцент на акції' },
  { id: 'minimal', label: 'Тільки головне' },
] as const;
type PresetId = (typeof PRESETS)[number]['id'];
const SAVE_LABELS = {
  saved: 'Макет збережено',
  dirty: 'Є незбережені зміни',
  saving: 'Збереження…',
  error: 'Не вдалося зберегти',
  conflict: 'Макет змінили в іншому вікні',
};
function Check({
  children,
  isSelected,
  onChange,
  isDisabled = false,
}: {
  children: ReactNode;
  isSelected: boolean;
  onChange: (checked: boolean) => void;
  isDisabled?: boolean;
}) {
  return (
    <Checkbox
      className="tk-studio-check"
      isSelected={isSelected}
      onChange={onChange}
      isDisabled={isDisabled}
    >
      <span className="tk-studio-check-box" aria-hidden="true">
        {isSelected ? '✓' : ''}
      </span>
      <span>{children}</span>
    </Checkbox>
  );
}
function NumericField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  disabled = false,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
}) {
  return (
    <NumberField
      className="tk-studio-number"
      value={value}
      onChange={(n) => {
        if (Number.isFinite(n)) onChange(n);
      }}
      minValue={min}
      maxValue={max}
      step={step}
      isDisabled={disabled}
    >
      <FieldLabel className="tk-label">{label}</FieldLabel>
      <Group>
        <Input className="tk-input" />
      </Group>
    </NumberField>
  );
}
function Canvas({
  product,
  config,
  settings,
  selectedField,
  onSelectField,
}: Pick<StudioViewProps, 'config' | 'settings' | 'selectedField' | 'onSelectField'> & {
  product: LabelProduct;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [width, height] = LABEL_SIZES[config.size];
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) {
        const physicalWidth = (width * 96) / 25.4,
          physicalHeight = (height * 96) / 25.4;
        setZoom(
          Math.max(
            0.2,
            Math.min(
              1.65,
              (entry.contentRect.width - 16) / physicalWidth,
              (entry.contentRect.height - 16) / physicalHeight,
            ),
          ),
        );
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [width, height]);
  return (
    <div className="tk-studio-canvas" ref={container}>
      <div style={{ zoom }}>
        <Label
          product={product}
          config={config}
          settings={settings}
          selectedField={selectedField}
          onSelectField={onSelectField}
        />
      </div>
    </div>
  );
}
export function StudioView(props: StudioViewProps) {
  const { config, settings, selectedField, canEdit, saveStatus, selectedTab } = props;
  const tabsRef = useRef<HTMLDivElement>(null);
  const cancelOutputRef = useRef<HTMLButtonElement>(null);
  const pdfRef = useRef<HTMLButtonElement>(null);
  const printRef = useRef<HTMLButtonElement>(null);
  const csvRef = useRef<HTMLButtonElement>(null);
  const reviewRef = useRef<HTMLButtonElement>(null);
  const previousOutput = useRef<StudioOutputState['kind'] | null>(null);
  const outputKind = props.outputState?.kind;
  useLayoutEffect(() => {
    if (props.outputBusy && outputKind && !previousOutput.current) {
      previousOutput.current = outputKind;
      cancelOutputRef.current?.focus({ preventScroll: true });
      cancelOutputRef.current?.scrollIntoView({ block: 'nearest' });
    } else if (!props.outputBusy && previousOutput.current) {
      const origin = { pdf: pdfRef, print: printRef, csv: csvRef }[previousOutput.current].current;
      previousOutput.current = null;
      const target = origin && !origin.disabled ? origin : reviewRef.current;
      target?.focus({ preventScroll: true });
    }
  }, [props.outputBusy, outputKind]);
  const previousTab = useRef(selectedTab);
  useLayoutEffect(() => {
    if (previousTab.current === selectedTab) return;
    previousTab.current = selectedTab;
    const tabs = tabsRef.current;
    if (tabs && tabs.getBoundingClientRect().top < 0) {
      tabs.scrollIntoView({ block: 'start', behavior: 'instant' });
    }
  }, [selectedTab]);
  const locked = !canEdit || saveStatus === 'saving' || props.outputBusy;
  const style = fieldStyle(config, selectedField);
  const quantities = Object.values(props.selection).filter((quantity) => quantity > 0);
  const copies = quantities.reduce((sum, quantity) => sum + quantity, 0);
  const change = (patch: Partial<LabelConfig>) => props.onConfigChange({ ...config, ...patch });
  // Only the edited property is stored: an untouched size keeps scaling with the format.
  const changeStyle = (patch: Partial<LabelStyle>, mergeKey?: string) =>
    props.onConfigChange(withFieldStyle(config, selectedField, patch), mergeKey);
  const filters = (patch: Partial<StudioFilters>) =>
    props.onFiltersChange({ ...props.filters, ...patch });
  const [width, height] = LABEL_SIZES[config.size];
  const previewOptions = props.previewProducts.map((product) => ({
    id: product.id,
    label: product.name,
  }));
  return (
    <section className="tk-root tk-studio" data-view={selectedTab} aria-label="Студія цінників">
      <Tabs
        className="tk-studio-frame"
        ref={tabsRef}
        selectedKey={selectedTab}
        onSelectionChange={(key) =>
          key === 'review' ? props.onReview() : props.onTabChange(String(key) as StudioTab)
        }
      >
        <div className="tk-studio-commandbar">
          <TabList className="tk-studio-tabs" aria-label="Етапи підготовки цінників">
            <Tab className="tk-studio-tab" id="design" isDisabled={props.outputBusy}>
              Макет
            </Tab>
            <Tab className="tk-studio-tab" id="products" isDisabled={props.outputBusy}>
              Товари для друку{quantities.length ? ` · ${quantities.length}` : ''}
            </Tab>
            <Tab className="tk-studio-tab" id="review" isDisabled={props.outputBusy}>
              Перевірка перед друком
            </Tab>
          </TabList>
          <header className="tk-studio-heading">
            <div className="tk-studio-history">
              <Button
                aria-label="Скасувати зміну"
                onPress={() => props.onUndo?.()}
                isDisabled={locked || !props.canUndo}
              >
                <span title="Скасувати останню зміну">Скасувати</span>
              </Button>
              <Button
                aria-label="Повторити зміну"
                onPress={() => props.onRedo?.()}
                isDisabled={locked || !props.canRedo}
              >
                <span title="Повторити скасовану зміну">Повторити</span>
              </Button>
            </div>
            <div className="tk-studio-save">
              <span
                role="status"
                className={
                  saveStatus === 'error' || saveStatus === 'conflict'
                    ? 'tk-error'
                    : 'tk-studio-note'
                }
              >
                {SAVE_LABELS[saveStatus]}
              </span>
              {canEdit ? (
                <Button
                  variant="primary"
                  onPress={props.onSave}
                  isDisabled={
                    saveStatus === 'saved' ||
                    saveStatus === 'saving' ||
                    saveStatus === 'conflict' ||
                    props.outputBusy
                  }
                >
                  Зберегти макет
                </Button>
              ) : (
                <span className="tk-studio-note">Перегляд без редагування</span>
              )}
            </div>
          </header>
        </div>
        <div
          className="tk-studio-notices"
          role="region"
          aria-label="Повідомлення та узгодження змін"
          tabIndex={0}
        >
          {props.operationReview}
          {props.error || saveStatus === 'conflict' ? (
            <div className="tk-studio-alert" role="alert">
              {props.error ||
                'Збережений макет змінився. Завантажте актуальний макет перед збереженням.'}
              {saveStatus === 'conflict' ? (
                <>
                  {props.onCompare ? (
                    <Button
                      onPress={(event) => {
                        if (event.target instanceof HTMLButtonElement)
                          props.onCompare?.(event.target);
                      }}
                      isDisabled={!!(props.outputBusy || props.preparing || props.comparisonBusy)}
                    >
                      {props.comparisonBusy ? 'Завантажуємо для порівняння…' : 'Порівняти зміни'}
                    </Button>
                  ) : null}
                  <Button
                    onPress={props.onReload}
                    isDisabled={!!(props.outputBusy || props.preparing || props.comparisonBusy)}
                  >
                    Завантажити збережений макет
                  </Button>
                </>
              ) : null}
              {props.onRetryProducts ? (
                <Button
                  onPress={props.onRetryProducts}
                  isDisabled={props.retryingProducts || props.outputBusy}
                >
                  {props.retryingProducts ? 'Завантажуємо товари…' : 'Завантажити товари повторно'}
                </Button>
              ) : null}
            </div>
          ) : null}
          {props.comparison}
        </div>
        <TabPanel id="design">
          <div className="tk-studio-workspace">
            <aside className="tk-studio-layers" aria-label="Елементи цінника">
              <h3>
                Елементи <span className="tk-studio-layer-count">{LABEL_FIELDS.length}</span>
              </h3>
              <div className="tk-studio-layer-list">
                {LABEL_FIELDS.map(([key, label]) => (
                  <button
                    type="button"
                    key={key}
                    className="tk-studio-layer"
                    data-label-field={key}
                    disabled={props.outputBusy}
                    aria-pressed={key === selectedField}
                    data-hidden={!fieldVisible(config, key)}
                    onClick={() => props.onSelectField(key)}
                  >
                    <span>{label}</span>
                    {!fieldVisible(config, key) ? (
                      <span
                        className="tk-studio-hidden-mark"
                        title="Приховано"
                        aria-label="Приховано"
                      />
                    ) : null}
                  </button>
                ))}
              </div>
              <div className="tk-studio-mobile-field">
                <Select
                  label="Елемент цінника"
                  options={LABEL_FIELDS.map(([id, label]) => ({ id, label }))}
                  selectedKey={selectedField}
                  isDisabled={props.outputBusy}
                  onSelectionChange={(key) => props.onSelectField(String(key) as LabelField)}
                />
              </div>

              <details className="tk-studio-format tk-studio-advanced">
                <summary>Формат і рамка</summary>
                <div className="tk-studio-advanced-content">
                  <Select
                    label="Формат цінника"
                    options={Object.entries(LABEL_SIZES).map(([id, dimensions]) => ({
                      id,
                      label: `${dimensions[0]} × ${dimensions[1]} мм`,
                    }))}
                    selectedKey={config.size}
                    onSelectionChange={(key) =>
                      change({ size: String(key) as LabelConfig['size'] })
                    }
                    isDisabled={locked}
                  />
                  <Select
                    label="Рамка"
                    options={[
                      { id: 'dash', label: 'Пунктир для різання' },
                      { id: 'solid', label: 'Суцільна' },
                      { id: 'none', label: 'Без рамки' },
                    ]}
                    selectedKey={config.border}
                    onSelectionChange={(key) =>
                      change({ border: String(key) as LabelConfig['border'] })
                    }
                    isDisabled={locked}
                  />
                </div>
              </details>
              <details className="tk-studio-identity tk-studio-advanced">
                <summary>Параметри шаблону та магазину</summary>
                <div className="tk-studio-advanced-content">
                  <div className="tk-studio-identity-fields">
                    <Select
                      label="Відображення ціни"
                      options={[
                        { id: 'auto', label: 'Без зайвих нулів' },
                        { id: 'always', label: 'Завжди з копійками' },
                      ]}
                      selectedKey={config.kop ? 'always' : 'auto'}
                      onSelectionChange={(key) => change({ kop: key === 'always' })}
                      isDisabled={locked}
                    />
                    <TextField
                      label="Назва мережі"
                      value={settings.chainName}
                      onChange={(chainName) => props.onSettingsChange({ ...settings, chainName })}
                      isDisabled={locked}
                    />
                    {settings.storeNames.length ? (
                      <Select
                        label="Магазин на ціннику"
                        options={settings.storeNames.map((label, index) => ({
                          id: String(index),
                          label: label || `Магазин ${index + 1}`,
                        }))}
                        selectedKey={String(config.storeIdx)}
                        onSelectionChange={(key) => change({ storeIdx: Number(key) })}
                        isDisabled={locked}
                      />
                    ) : null}
                    {settings.storeNames.map((name, index) => (
                      <div key={index} className="tk-studio-store-row">
                        <TextField
                          label={`Назва магазину ${index + 1}`}
                          value={name}
                          onChange={(value) =>
                            props.onSettingsChange({
                              ...settings,
                              storeNames: settings.storeNames.map((item, i) =>
                                i === index ? value : item,
                              ),
                            })
                          }
                          isDisabled={locked}
                        />
                        <Button
                          aria-label={`Видалити магазин ${index + 1}`}
                          onPress={() => {
                            props.onSettingsChange(
                              {
                                ...settings,
                                storeNames: settings.storeNames.filter((_, i) => i !== index),
                              },
                              Math.max(
                                0,
                                config.storeIdx > index
                                  ? config.storeIdx - 1
                                  : config.storeIdx === index
                                    ? 0
                                    : config.storeIdx,
                              ),
                            );
                          }}
                          isDisabled={locked}
                        >
                          ×
                        </Button>
                      </div>
                    ))}
                  </div>
                  <div className="tk-studio-selection-actions">
                    <Button
                      onPress={() =>
                        props.onSettingsChange({
                          ...settings,
                          storeNames: [...settings.storeNames, ''],
                        })
                      }
                      isDisabled={locked || settings.storeNames.length >= 100}
                    >
                      Додати магазин
                    </Button>
                    <div>
                      <Select
                        label="Готове оформлення"
                        options={[...PRESETS]}
                        placeholder="Оберіть варіант"
                        // An action, not a stored setting: after applying or cancelling it shows
                        // no choice, so the same preset can be applied again.
                        selectedKey={null}
                        onSelectionChange={(key) => {
                          const preset = PRESETS.find((item) => item.id === key);
                          if (preset) props.onApplyPreset(preset.id);
                        }}
                        isDisabled={locked}
                      />
                      <Button onPress={props.onResetTemplate} isDisabled={locked}>
                        Скинути макет
                      </Button>
                    </div>
                  </div>
                </div>
              </details>
            </aside>
            <div className="tk-studio-stage">
              <div className="tk-studio-canvas-toolbar">
                {' '}
                <div className="tk-studio-preview-picker">
                  <ComboBox
                    search="server"
                    label="Товар для перегляду"
                    options={previewOptions}
                    selectedOption={
                      props.previewProduct
                        ? { id: props.previewProduct.id, label: props.previewProduct.name }
                        : null
                    }
                    isLoading={!!props.previewLoading}
                    selectedKey={props.previewProduct?.id ?? null}
                    onSelectionChange={(key) => props.onPreviewProductChange(String(key))}
                    onInputChange={props.onPreviewQueryChange}
                    placeholder="Знайдіть товар за назвою"
                    isDisabled={props.outputBusy}
                  />
                  <Button
                    aria-label="Очистити товар для перегляду"
                    onPress={() => props.onPreviewProductChange(null)}
                    isDisabled={!props.previewProduct || props.outputBusy}
                  >
                    ×
                  </Button>
                </div>
              </div>
              <div className="tk-studio-stage-head">
                <span>
                  {width} × {height} мм
                </span>
                <span>Масштаб для екрана</span>
              </div>
              {props.previewProduct ? (
                <Canvas
                  product={props.previewProduct}
                  config={props.previewConfig || config}
                  settings={props.previewSettings || settings}
                  selectedField={selectedField}
                  onSelectField={props.onSelectField}
                />
              ) : (
                <div className="tk-studio-canvas">
                  <div className="tk-studio-empty">
                    <h3>Оберіть товар для перегляду</h3>
                    <p>У макеті з’являться його назва, ціна та ознака акції.</p>
                  </div>
                </div>
              )}
              {props.previewWarnings?.length ? (
                <div className="tk-studio-alert" role="status">
                  {props.previewWarnings.map((warning) => (
                    <p key={warning}>{warning}</p>
                  ))}
                </div>
              ) : null}
              <div className="tk-studio-stage-foot">
                <span>Вибрано: {fieldName(selectedField)}</span>
                <span>Натисніть елемент у макеті</span>
              </div>
            </div>
            <aside className="tk-studio-properties" aria-label="Параметри елемента">
              <div className="tk-studio-properties-title">
                <h3>{fieldName(selectedField)}</h3>
                <span className="tk-studio-note">Для всіх цінників цього макета</span>
              </div>
              <Check
                isSelected={fieldVisible(config, selectedField)}
                onChange={(visible) =>
                  change({
                    [selectedField === 'custom' ? 'customEnabled' : selectedField]: visible,
                  })
                }
                isDisabled={locked}
              >
                Показувати на ціннику
              </Check>
              {selectedField === 'promo' ? (
                <p className="tk-help">Позначка «Акція» з’являється лише на акційних товарах.</p>
              ) : null}
              {selectedField === 'custom' ? (
                <TextField
                  label="Текст напису"
                  value={config.custom}
                  onChange={(custom) => change({ custom })}
                  maxLength={40}
                  isDisabled={locked}
                />
              ) : null}
              <Select
                label="Шрифт"
                options={[
                  { id: 'rubik', label: 'Rubik' },
                  { id: 'arial', label: 'Arial' },
                  { id: 'georgia', label: 'Georgia' },
                  { id: 'courier', label: 'Courier New' },
                ]}
                selectedKey={style.font}
                onSelectionChange={(key) =>
                  changeStyle({ font: String(key) as LabelStyle['font'] })
                }
                isDisabled={locked}
              />
              <div className="tk-studio-pair">
                <NumericField
                  label="Розмір, pt"
                  min={5}
                  max={72}
                  step={0.5}
                  value={style.size}
                  onChange={(size) => changeStyle({ size })}
                  disabled={locked}
                />
                <label className="tk-studio-color">
                  Колір
                  <input
                    type="color"
                    value={style.color}
                    onChange={(event) =>
                      // Dragging in the picker emits many values; keep them as one undo step.
                      changeStyle({ color: event.target.value }, `${selectedField}.color`)
                    }
                    disabled={locked}
                  />
                </label>
              </div>
              <Select
                label="Насиченість"
                options={[
                  { id: '400', label: 'Звичайний' },
                  { id: '600', label: 'Напівжирний' },
                  { id: '700', label: 'Жирний' },
                ]}
                selectedKey={style.weight}
                onSelectionChange={(key) =>
                  changeStyle({ weight: String(key) as LabelStyle['weight'] })
                }
                isDisabled={locked}
              />
              <Select
                label="Вирівнювання"
                options={[
                  { id: 'left', label: 'Ліворуч' },
                  { id: 'center', label: 'По центру' },
                  { id: 'right', label: 'Праворуч' },
                ]}
                selectedKey={style.align}
                onSelectionChange={(key) =>
                  changeStyle({ align: String(key) as LabelStyle['align'] })
                }
                isDisabled={locked}
              />
              <p className="tk-help">
                Розмір у пунктах зберігається в друці. Масштаб перегляду його не змінює.
              </p>
              <Button onPress={props.onResetField} isDisabled={locked}>
                Скинути цей елемент
              </Button>
            </aside>
          </div>

          <footer className="tk-studio-bottom">
            <span className="tk-studio-note">
              Шаблон змінює оформлення цінників. Ціни беруться з каталогу.
            </span>
            <Button onPress={() => props.onTabChange('products')} isDisabled={props.outputBusy}>
              Обрати товари →
            </Button>
          </footer>
        </TabPanel>
        <TabPanel id="products">
          <div className="tk-studio-content tk-studio-content--products" aria-busy={props.loading}>
            <div className="tk-studio-product-filters">
              <TextField
                label="Пошук товарів"
                type="search"
                value={props.filters.q}
                onChange={(q) => filters({ q })}
                placeholder="Назва або штрихкод"
                isDisabled={props.outputBusy}
              />
              <ComboBox
                label="Група"
                options={choices(props.facets.type, 'Усі групи', props.filters.type)}
                selectedKey={props.filters.type || '*'}
                isDisabled={props.outputBusy}
                onSelectionChange={(key) =>
                  filters({ type: key === '*' ? '' : String(key), category: '', pack: '' })
                }
              />
              <ComboBox
                label="Категорія"
                options={choices(props.facets.category, 'Усі категорії', props.filters.category)}
                selectedKey={props.filters.category || '*'}
                isDisabled={props.outputBusy || props.loading}
                onSelectionChange={(key) =>
                  filters({ category: key === '*' ? '' : String(key), pack: '' })
                }
              />
              <Select
                label="Акція"
                options={[
                  { id: '*', label: 'Усі товари' },
                  { id: 'yes', label: 'Акційні' },
                  { id: 'no', label: 'Без акції' },
                ]}
                selectedKey={props.filters.promotion || '*'}
                isDisabled={props.outputBusy}
                onSelectionChange={(key) => filters({ promotion: key === '*' ? '' : String(key) })}
              />
            </div>
            <div className="tk-studio-selection-actions">
              <span role="status">
                Обрано {quantities.length} товарів · {copies} цінників
              </span>
              <div>
                <Button
                  onPress={() => props.onSelectShown(props.products.map((product) => product.id))}
                  isDisabled={props.loading || !props.products.length || props.outputBusy}
                >
                  Обрати цю сторінку
                </Button>
                <Button
                  onPress={props.onClearSelection}
                  isDisabled={!quantities.length || props.outputBusy}
                >
                  Очистити вибір
                </Button>
              </div>
            </div>
            <div
              className="tk-studio-products-scroll"
              role="region"
              aria-label="Список товарів для друку"
              tabIndex={0}
            >
              {props.products.length ? (
                <div className="tk-studio-product-list">
                  {props.products.map((product) => {
                    const quantity = props.selection[product.id] ?? 0;
                    return (
                      <div
                        key={product.id}
                        className="tk-studio-product-row"
                        data-selected={quantity > 0}
                      >
                        <div>
                          <Check
                            isSelected={quantity > 0}
                            isDisabled={props.loading || props.outputBusy}
                            onChange={(checked) =>
                              props.onQuantityChange(product.id, checked ? 1 : 0)
                            }
                          >
                            {product.name}
                          </Check>
                          <div className="tk-studio-product-meta">
                            <span>
                              {[product.type, product.category].filter(Boolean).join(' · ')}
                            </span>
                            {product.promotion ? (
                              <span className="tk-studio-promo">Акція</span>
                            ) : null}
                          </div>
                        </div>
                        <div className={product.salePrice > 0 ? 'tk-studio-price' : 'tk-error'}>
                          {product.promotion && (product.regularPrice ?? 0) > product.salePrice ? (
                            <del aria-label="Звичайна ціна">
                              {formatLabelMoney(product.regularPrice!)} грн
                            </del>
                          ) : null}
                          {product.salePrice > 0
                            ? `${formatLabelMoney(product.salePrice)} грн`
                            : 'Немає ціни'}
                        </div>
                        <NumericField
                          label={`Копій: ${product.name}`}
                          value={quantity > 0 ? quantity : 1}
                          min={1}
                          max={500}
                          onChange={(number) =>
                            props.onQuantityChange(product.id, Math.round(number))
                          }
                          disabled={quantity === 0 || props.loading || props.outputBusy}
                        />
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="tk-studio-empty">
                  <h3>{props.loading ? 'Завантажуємо товари…' : 'Товарів не знайдено'}</h3>
                  <p>Змініть пошук або скиньте фільтри.</p>
                </div>
              )}
              <details className="tk-studio-selected-summary tk-studio-advanced">
                <summary>Усі вибрані товари · {quantities.length}</summary>
                <div className="tk-studio-selected-list">
                  {props.selectedProducts
                    .filter((product) => (props.selection[product.id] ?? 0) > 0)
                    .map((product) => (
                      <div key={product.id}>
                        <span>
                          {product.name} · {props.selection[product.id]} коп.
                        </span>
                        <Button
                          aria-label={`Прибрати з друку: ${product.name}`}
                          isDisabled={props.outputBusy}
                          onPress={() => props.onQuantityChange(product.id, 0)}
                        >
                          Прибрати
                        </Button>
                      </div>
                    ))}
                </div>
              </details>
            </div>
            <div className="tk-studio-pagination">
              <span>Знайдено {props.total} товарів</span>
              <div>
                <Button
                  onPress={() => props.onPageChange(props.page - 1)}
                  isDisabled={props.loading || props.page <= 1 || props.outputBusy}
                >
                  Назад
                </Button>
                <span>
                  {props.page} / {props.pages}
                </span>
                <Button
                  onPress={() => props.onPageChange(props.page + 1)}
                  isDisabled={props.loading || props.page >= props.pages || props.outputBusy}
                >
                  Далі
                </Button>
              </div>
            </div>
            <div className="tk-studio-bottom">
              <Button
                isDisabled={props.outputBusy}
                onPress={() =>
                  props.onFiltersChange({ q: '', type: '', category: '', pack: '', promotion: '' })
                }
              >
                Скинути фільтри
              </Button>
              <Button
                variant="primary"
                onPress={props.onReview}
                isDisabled={!quantities.length || props.preparing || props.outputBusy}
              >
                {props.preparing ? 'Готуємо перегляд…' : `Перевірити ${copies} цінників →`}
              </Button>
            </div>
          </div>
        </TabPanel>
        <TabPanel id="review">
          <div className="tk-studio-content tk-studio-content--review">
            <div className="tk-studio-review-top">
              <div>
                <h3>Переддруковий перегляд</h3>
                <p>
                  Цінників: {copies} · аркушів: {Math.ceil(copies / pageGeometry(config).perSheet)}{' '}
                  · A4 · поля 8 мм · масштаб друку 100%
                </p>
              </div>
              <div className="tk-studio-review-actions" aria-busy={props.outputBusy}>
                <Button
                  ref={reviewRef}
                  onPress={props.onReview}
                  isDisabled={props.preparing || props.outputBusy}
                >
                  Оновити перевірку
                </Button>
                <Button onPress={() => props.onTabChange('products')} isDisabled={props.outputBusy}>
                  Змінити товари
                </Button>
                {props.onCsv ? (
                  <Button
                    ref={csvRef}
                    onPress={props.onCsv}
                    isDisabled={!props.canOutput || props.outputBusy}
                  >
                    Експорт CSV
                  </Button>
                ) : null}
                <Button
                  ref={pdfRef}
                  onPress={props.onExport}
                  isDisabled={!props.canOutput || props.outputBusy}
                >
                  Завантажити PDF
                </Button>
                <Button
                  ref={printRef}
                  variant="primary"
                  onPress={props.onPrint}
                  isDisabled={!props.canOutput || props.outputBusy}
                >
                  Друкувати
                </Button>
              </div>
            </div>
            {props.outputBusy && props.outputState ? (
              <div className="tk-studio-output" aria-label="Підготовка виводу">
                <div>
                  <p role="status" aria-live="polite" aria-atomic="true">
                    {outputMessage(props.outputState)}
                  </p>
                  <progress
                    aria-label={
                      { pdf: 'Підготовка PDF', print: 'Підготовка друку', csv: 'Підготовка CSV' }[
                        props.outputState.kind
                      ]
                    }
                    max={Math.max(1, props.outputState.total)}
                    {...(['verify', 'module'].includes(props.outputState.stage)
                      ? {}
                      : { value: props.outputState.completed })}
                  />
                </div>
                {props.onCancelOutput ? (
                  <Button
                    ref={cancelOutputRef}
                    onPress={props.onCancelOutput}
                    isDisabled={
                      props.outputState.cancelling ||
                      ['download', 'print'].includes(props.outputState.stage)
                    }
                  >
                    Скасувати підготовку
                  </Button>
                ) : null}
              </div>
            ) : null}
            {props.outputStatus ? (
              <p role="status" className="tk-studio-output-result">
                {props.outputStatus}
              </p>
            ) : null}
            <div
              className="tk-studio-review-scroll"
              role="region"
              aria-label="Перегляд аркушів і перевірки"
              tabIndex={0}
            >
              {props.validationErrors.length ? (
                <div role="alert" className="tk-studio-alert">
                  <strong>Перед друком потрібно виправити</strong>
                  <ul>
                    {props.validationErrors.map((error) => (
                      <li key={error}>{error}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {props.staleProducts.length ? (
                <div className="tk-studio-alert tk-studio-warning">
                  <strong>Ціни потребують перевірки</strong>
                  <p>{props.staleProducts.join(', ')}</p>
                  <Check
                    isSelected={props.staleAcknowledged}
                    onChange={props.onStaleAcknowledged}
                    isDisabled={props.outputBusy}
                  >
                    Ціни перевірено, можна друкувати
                  </Check>
                </div>
              ) : null}
              {props.preparing ? (
                <p role="status">Завантажуємо актуальні ціни та перевіряємо макет…</p>
              ) : null}
              <div className="tk-studio-proof">{props.review}</div>{' '}
            </div>
          </div>
        </TabPanel>
      </Tabs>
    </section>
  );
}
