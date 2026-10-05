import { useState, useSyncExternalStore, useRef, useLayoutEffect } from 'react';
import { Checkbox } from 'react-aria-components';
import { Button } from '../../shared/ui/Button';
import { TextField } from '../../shared/ui/TextField';
import { Select } from '../../shared/ui/Select';
import { ConflictComparison } from '../../shared/ui/ConflictComparison';
import { compareThreeWay, resolveThreeWay, type MergeChoices } from '../../shared/merge/threeWay';
import { DirectoryComboBox } from '../trading/DirectoryComboBox';
import type { DirectoryItem, TradingApi } from '../trading/api';
import {
  displayDecimal,
  documentLabels,
  statusLabels,
  type AssortmentRow,
  type StockTotal,
  type StockLot,
} from './api';
import { StockModel, assortmentFields, captureTerms, draftKey, terms, type Draft } from './state';
import './stock.css';

export function Pager({
  page,
  pages,
  total,
  busy,
  onPage,
  label,
}: {
  page: number;
  pages: number;
  total: number;
  busy: boolean;
  onPage: (p: number) => void;
  label: string;
}) {
  return (
    <nav className="stock-pager" aria-label={label} data-stock-pager={label}>
      <Button data-stock-previous isDisabled={busy || page <= 1} onPress={() => onPage(page - 1)}>
        Назад
      </Button>
      <span role="status" tabIndex={-1} data-stock-page-status>
        {page} / {pages} · записів {total}
      </span>
      <Button data-stock-next isDisabled={busy || page >= pages} onPress={() => onPage(page + 1)}>
        Далі
      </Button>
    </nav>
  );
}
export function AssortmentEditor({
  warehouse,
  row,
  draft,
  disabled,
  onEdit,
  onSave,
  onReset,
  onCompare,
  onApply,
  onCancel,
}: {
  warehouse: number;
  row: AssortmentRow;
  draft: Draft | undefined;
  disabled: boolean;
  onEdit: (patch: Pick<Partial<Draft>, 'sold' | 'minimum'>) => void;
  onSave: () => void;
  onReset: () => void;
  onCompare: () => void;
  onApply: (value: { sold: boolean; min_stock: string | null }) => void;
  onCancel: () => void;
}) {
  const [choices, setChoices] = useState<MergeChoices>({});
  const min = draft?.minimum ?? row.min_stock ?? '',
    sold = draft?.sold ?? row.sold;
  let local = null,
    invalid = '';
  try {
    local = captureTerms({ sold, minimum: min });
  } catch (error) {
    invalid = (error as Error).message;
  }
  const comparison =
    draft?.server && local
      ? compareThreeWay(terms(draft.base), local, terms(draft.server), assortmentFields)
      : null;
  return (
    <article className="stock-editor" data-stock-draft={warehouse + ':' + row.product}>
      <h4 tabIndex={-1}>
        {row.name} <span className="tk-help">· {row.unit}</span>
      </h4>
      <Checkbox
        className="stock-checkbox"
        isSelected={sold}
        isDisabled={disabled}
        onChange={(value) => onEdit({ sold: value })}
      >
        <span aria-hidden="true" />
        Продається на цьому складі
      </Checkbox>
      <TextField
        label={`Мінімум: ${row.name}`}
        value={min}
        onChange={(value) => onEdit({ minimum: value })}
        isDisabled={disabled}
        inputMode="decimal"
        error={invalid}
        description={`Порожнє поле — з каталогу (${displayDecimal(row.default_min)} ${row.unit}); 0 — власний нуль.`}
      />
      <div className="stock-actions">
        <Button
          variant="primary"
          isDisabled={disabled || !draft || draft.busy || draft.uncertain || !!invalid}
          onPress={onSave}
        >
          {draft?.busy ? 'Збереження…' : 'Зберегти'}
        </Button>
        <Button isDisabled={disabled || !draft || draft.busy || draft.uncertain} onPress={onReset}>
          Скинути чернетку
        </Button>
        {draft?.reading ? <Button onPress={onCancel}>Скасувати читання</Button> : null}
        {draft ? (
          <Button
            isDisabled={disabled || draft.busy || draft.reading}
            onPress={() => {
              setChoices({});
              onCompare();
            }}
          >
            {draft.reading ? 'Читання…' : 'Порівняти поточний стан'}
          </Button>
        ) : null}
      </div>
      {draft?.error ? (
        <p role="status" className="stock-message">
          {draft.error}
        </p>
      ) : null}
      {draft?.uncertain ? (
        <p className="tk-help">
          Результат запиту невідомий або версія застаріла. Повторний запис заблоковано до явного
          узгодження поточного стану.
        </p>
      ) : null}
      {draft?.server ? (
        <>
          <p className="tk-help">
            Зараз на сервері: {draft.server.sold ? 'продається' : 'не продається'}, мінімум{' '}
            {draft.server.min_stock === null
              ? 'із каталогу'
              : displayDecimal(draft.server.min_stock)}
            . Прочитана версія ще не стала версією чернетки.
          </p>
          {comparison && local ? (
            <ConflictComparison
              key={draft.server.revision ?? 'new'}
              rows={comparison}
              choices={choices}
              onChoice={(id, choice) => setChoices((v) => ({ ...v, [id]: choice }))}
              isDisabled={disabled || draft.busy}
              onCancel={onCancel}
              onApply={() => {
                const merged = resolveThreeWay(
                  terms(draft.base),
                  local,
                  terms(draft.server!),
                  assortmentFields,
                  choices,
                );
                if (merged) onApply(merged);
              }}
            />
          ) : (
            <p role="alert">
              Поточний стан прочитано. Виправте мінімум у вашій чернетці, щоб узгодити зміни.
            </p>
          )}
        </>
      ) : null}
    </article>
  );
}
function Directory({
  api,
  type,
  label,
  value,
  selected,
  store,
  disabled,
  onCommit,
}: {
  api: TradingApi;
  type: 'stores' | 'warehouses';
  label: string;
  value: number | null;
  selected: DirectoryItem | null;
  store?: number | null;
  disabled: boolean;
  onCommit: (id: number | null) => void;
}) {
  return (
    <DirectoryComboBox
      api={api}
      type={type}
      label={label}
      value={value === null ? '' : String(value)}
      selected={selected}
      query={{ purpose: 'filter', ...(store ? { store } : {}) }}
      disabled={disabled}
      emptyLabel={type === 'stores' ? 'Усі магазини' : 'Усі склади'}
      onCommit={(item) => onCommit(item ? Number(item.id) : null)}
    />
  );
}
export function Stock({ model }: { model: StockModel }) {
  const s = useSyncExternalStore(model.subscribe, model.snapshot),
    options = model.options;
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (s.busy || s.error || !s.focus) return;
    const labels: Record<string, string> = {
      page: 'Сторінки товарів',
      lotsPage: 'Сторінки партій',
      assortmentPage: 'Сторінки асортименту',
      documentsPage: 'Сторінки документів',
    };
    const pager = host.current?.querySelector(`[data-stock-pager="${labels[s.focus.section]}"]`),
      button = pager?.querySelector<HTMLButtonElement>(`[data-stock-${s.focus.direction}]`);
    if (button && !button.disabled) button.focus();
    else pager?.querySelector<HTMLElement>('[data-stock-page-status]')?.focus();
  }, [s.busy, s.error, s.focus]);
  if (!options) return null;
  if (s.denied)
    return (
      <section className="react-stock stock-panel">
        <h2>Залишки</h2>
        <p role="alert">{s.error}</p>
        <p>
          Приватні дані прибрано. Оновіть сесію або відкрийте доступний розділ. Локальні чернетки не
          надіслано.
        </p>
      </section>
    );
  const policy = s.totals?.policy,
    caption = (type: string, id: number | null) =>
      id === null ? '—' : (s.captions.get(type + ':' + id)?.name ?? 'Запис недоступний'),
    selected = (type: string, id: number | null) =>
      id === null ? null : (s.captions.get(type + ':' + id) ?? null);
  const drafts = [...s.drafts.entries()].filter(
    ([, d]) => policy?.canEditAssortment && (policy.store === null || d.store === policy.store),
  );
  async function rowAction(
    key: string,
    action: () => void | Promise<void>,
    target: 'h4' | 'input[type="text"]',
    cleanOnly = false,
  ) {
    const container = host.current;
    const previous = document.activeElement;
    const hadFocus = !!previous && !!container?.contains(previous);
    await action();
    if (!hadFocus || (cleanOnly && model.snapshot().drafts.has(key))) return;
    requestAnimationFrame(() => {
      const state = model.snapshot();
      if (
        !container?.isConnected ||
        host.current !== container ||
        state.denied ||
        state.error ||
        state.busy ||
        (document.activeElement !== previous && document.activeElement !== document.body)
      )
        return;
      const card = [...container.querySelectorAll<HTMLElement>('[data-stock-draft]')].find(
        (element) => element.dataset.stockDraft === key,
      );
      card?.querySelector<HTMLElement>(target)?.focus();
    });
  }
  const editor = (warehouse: number, row: AssortmentRow) => {
    const key = draftKey(warehouse, row.product);
    return (
      <AssortmentEditor
        key={key}
        warehouse={warehouse}
        row={row}
        draft={s.drafts.get(key)}
        disabled={!policy?.canEditAssortment}
        onEdit={(patch) => model.edit(warehouse, row, patch)}
        // Clean buttons are disabled; their row heading retains the keyboard position.
        onSave={() => void rowAction(key, () => model.save(warehouse, row.product), 'h4', true)}
        onReset={() => void rowAction(key, () => model.reset(key), 'h4')}
        onCompare={() => void model.compare(warehouse, row.product)}
        onApply={(value) => model.apply(key, value)}
        onCancel={() => model.cancelComparison(key)}
      />
    );
  };
  return (
    <div className="react-stock" data-react-stock ref={host}>
      <section className="stock-panel">
        <h2>Залишки</h2>
        <div className="stock-filters">
          <TextField
            label="Пошук товару"
            value={s.q}
            maxLength={250}
            onChange={(q) => void model.change({ q })}
          />
          <Directory
            api={options.directoryApi}
            type="stores"
            label="Магазин"
            value={s.store}
            selected={selected('stores', s.store)}
            disabled={!!(policy?.store ?? options.bootstrap.storeId)}
            onCommit={(store) =>
              void model.change({ store, warehouse: null, assortmentWarehouse: null })
            }
          />
          <Directory
            api={options.directoryApi}
            type="warehouses"
            label="Склад залишків"
            value={s.warehouse}
            selected={selected('warehouses', s.warehouse)}
            store={s.store}
            disabled={false}
            onCommit={(warehouse) => void model.change({ warehouse })}
          />
        </div>
        <div className="stock-actions">
          <Button onPress={() => void model.refresh()} isDisabled={s.busy}>
            Оновити
          </Button>
          <Button onPress={() => void model.csv()} isDisabled={s.busy || s.csvBusy || !s.totals}>
            {s.csvBusy ? 'Завантаження CSV…' : 'CSV залишків'}
          </Button>
          {policy?.canControl ? (
            <Button onPress={() => void model.action(options.onControl)} isDisabled={s.busy}>
              Контроль операцій
            </Button>
          ) : null}
          {policy?.canLegacyRecipes ? (
            <Button onPress={() => void model.action(options.onLegacyRecipes)} isDisabled={s.busy}>
              Калькуляції
            </Button>
          ) : null}
          {policy?.canRecipeVersions ? (
            <Button onPress={() => void model.action(options.onRecipeVersions)} isDisabled={s.busy}>
              Версії рецептур
            </Button>
          ) : null}
          {policy?.canReplenish ? (
            <Button onPress={options.onReplenishment} isDisabled={s.busy}>
              Поповнення запасів
            </Button>
          ) : null}
        </div>
        {s.error ? (
          <div role="alert">
            <p>{s.error}</p>
            <Button onPress={() => void model.refresh()}>Повторити читання</Button>
          </div>
        ) : null}
        {s.notice ? <p role="status">{s.notice}</p> : null}
        {s.busy ? <p role="status">Завантаження залишків…</p> : null}
        {s.totals ? (
          <>
            <div className="stock-cards">
              {policy?.costVisible ? (
                <div>
                  <strong>{displayDecimal(s.totals.summary.value!)} грн</strong>
                  <span>Вартість усього фільтра</span>
                </div>
              ) : null}
              <div>
                <strong>{s.totals.summary.low}</strong>
                <span>Нижче мінімуму</span>
              </div>
              <div>
                <strong>{s.totals.summary.expiry}</strong>
                <span>Партій: термін минув / за 7 днів</span>
              </div>
            </div>
            <p className="tk-help">
              Стан на {s.totals.asOf}. Підсумки охоплюють увесь фільтр; різні одиниці не
              складаються.
            </p>
            {s.totals.alerts ? (
              <p role="status">
                Контроль:{' '}
                {s.totals.alerts.error
                  ? 'помилка — повторіть перевірку'
                  : s.totals.alerts.stale
                    ? 'потребує оновлення'
                    : 'оновлено'}
                {s.totals.alerts.ok?.at ? ' · ' + String(s.totals.alerts.ok.at) : ''}
              </p>
            ) : null}
            <div
              className="stock-table-scroll"
              tabIndex={0}
              role="region"
              aria-label="Товари — горизонтальна таблиця"
            >
              <table>
                <caption>Товари · записів {s.totals.total}</caption>
                <thead>
                  <tr>
                    <th>Товар / склад</th>
                    <th>Кількість</th>
                    <th>Доступно</th>
                    <th>Резерв</th>
                    {policy?.costVisible ? <th>Вартість</th> : null}
                    <th>Мінімум / продаж</th>
                  </tr>
                </thead>
                <tbody>
                  {(s.totals.items as StockTotal[]).map((row) => (
                    <tr key={row.warehouse + ':' + row.product}>
                      <td>
                        {row.name}
                        <span className="stock-sub">{caption('warehouses', row.warehouse)}</span>
                      </td>
                      <td>
                        {displayDecimal(row.quantity)} {row.unit}
                      </td>
                      <td>
                        {displayDecimal(row.available)} {row.unit}
                      </td>
                      <td>
                        {displayDecimal(row.reserved)} {row.unit}
                      </td>
                      {policy?.costVisible ? <td>{displayDecimal(row.value!)} грн</td> : null}
                      <td>
                        {!row.sold
                          ? 'Не продається'
                          : row.low
                            ? 'Нижче мінімуму'
                            : displayDecimal(row.minimum) + ' ' + row.unit}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!s.totals.total ? <p>Залишків за цим фільтром немає.</p> : null}
            </div>
            <Pager
              page={s.totals.page}
              pages={s.totals.pages}
              total={s.totals.total}
              busy={s.busy}
              label="Сторінки товарів"
              onPage={(p) => void model.page('page', p)}
            />
          </>
        ) : null}
      </section>
      <section className="stock-panel">
        <h3>
          <Button
            onPress={() => void model.change({ lotsOpen: !s.lotsOpen })}
            aria-expanded={s.lotsOpen}
          >
            Партії {s.totals ? '(' + s.totals.summary.lots + ')' : ''}
          </Button>
        </h3>
        {s.lotsOpen && s.lots ? (
          <>
            <div
              className="stock-table-scroll"
              tabIndex={0}
              role="region"
              aria-label="Партії — горизонтальна таблиця"
            >
              <table>
                <caption>Партії</caption>
                <thead>
                  <tr>
                    <th>Товар / склад</th>
                    <th>Партія</th>
                    <th>Придатний до</th>
                    <th>Кількість</th>
                    <th>Доступно</th>
                    <th>Резерв</th>
                  </tr>
                </thead>
                <tbody>
                  {(s.lots.items as StockLot[]).map((row) => (
                    <tr key={row.id}>
                      <td>
                        {row.name}
                        <span className="stock-sub">{caption('warehouses', row.warehouse)}</span>
                      </td>
                      <td>{row.lot || '—'}</td>
                      <td>
                        {row.expiry ?? 'Не задано'}
                        {row.expired ? ' · прострочено' : ''}
                      </td>
                      <td>
                        {displayDecimal(row.quantity)} {row.unit}
                      </td>
                      <td>
                        {displayDecimal(row.available)} {row.unit}
                      </td>
                      <td>
                        {displayDecimal(row.reserved)} {row.unit}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!s.lots.total ? <p>Партій немає.</p> : null}
            </div>
            <Pager
              page={s.lots.page}
              pages={s.lots.pages}
              total={s.lots.total}
              busy={s.busy}
              label="Сторінки партій"
              onPage={(p) => void model.page('lotsPage', p)}
            />
          </>
        ) : s.lotsOpen ? (
          <p role="status">Завантаження партій…</p>
        ) : null}
      </section>
      {policy?.canEditAssortment ? (
        <section className="stock-panel">
          <h3>
            <Button
              onPress={() => void model.change({ assortmentOpen: !s.assortmentOpen })}
              aria-expanded={s.assortmentOpen}
            >
              Асортимент складу
            </Button>
          </h3>
          {s.assortmentOpen ? (
            <>
              <Directory
                api={options.directoryApi}
                type="warehouses"
                label="Склад асортименту"
                value={s.assortmentWarehouse}
                selected={selected('warehouses', s.assortmentWarehouse)}
                store={s.store}
                disabled={false}
                onCommit={(assortmentWarehouse) => void model.change({ assortmentWarehouse })}
              />
              <p className="tk-help">
                Окремі правила продажу та мінімуму. Чернетки зберігаються в цій вкладці при пошуку,
                переході між складами та розділами.
              </p>
              {s.assortmentProduct ? (
                <Button onPress={() => void model.change({ assortmentProduct: '' })}>
                  Увесь асортимент
                </Button>
              ) : null}
              {s.assortment ? (
                s.assortment.rows.map((row) => editor(s.assortment!.warehouse, row))
              ) : s.assortmentWarehouse ? (
                <p role="status">Завантаження асортименту…</p>
              ) : (
                <p>Оберіть склад для редагування.</p>
              )}
              {s.assortment ? (
                <Pager
                  page={s.assortment.page}
                  pages={s.assortment.pages}
                  total={s.assortment.total}
                  busy={s.busy}
                  label="Сторінки асортименту"
                  onPage={(p) => void model.page('assortmentPage', p)}
                />
              ) : null}
            </>
          ) : null}
          {drafts.length ? (
            <div className="stock-drafts">
              <h4>Локальні чернетки: {drafts.length}</h4>
              {drafts.map(([key, d]) => {
                const warehouse = Number(key.split(':')[0]);
                return (
                  <div key={key}>
                    <Button
                      onPress={() =>
                        void rowAction(
                          key,
                          () =>
                            model.change({
                              assortmentWarehouse: warehouse,
                              assortmentProduct: d.base.product,
                              assortmentOpen: true,
                            }),
                          'input[type="text"]',
                        )
                      }
                    >
                      {d.base.name} · відкрити чернетку
                    </Button>
                    {!(
                      s.assortment?.warehouse === warehouse &&
                      s.assortment.rows.some((r) => r.product === d.base.product)
                    )
                      ? editor(warehouse, d.base)
                      : null}
                  </div>
                );
              })}
            </div>
          ) : null}
        </section>
      ) : null}
      {policy?.documentKinds.length ? (
        <section className="stock-panel">
          <h3>Складські документи</h3>
          <div className="stock-actions">
            {policy.documentKinds.map((kind) => (
              <Button
                key={kind}
                onPress={() => void model.action(() => options.onCreateDocument(kind))}
                isDisabled={s.busy}
              >
                + {documentLabels[kind]}
              </Button>
            ))}
          </div>
          <div className="stock-filters">
            <Select
              label="Стан документа"
              selectedKey={s.status}
              onSelectionChange={(key) => void model.change({ status: String(key ?? '') })}
              options={[
                { id: '', label: 'Усі стани' },
                ...Object.entries(statusLabels).map(([id, label]) => ({ id, label })),
              ]}
            />
          </div>
          {s.documents ? (
            <>
              <div
                className="stock-table-scroll"
                tabIndex={0}
                role="region"
                aria-label="Документи — горизонтальна таблиця"
              >
                <table>
                  <caption>Журнал складських документів</caption>
                  <thead>
                    <tr>
                      <th>Документ</th>
                      <th>Дата</th>
                      <th>Магазин</th>
                      <th>Контрагент / працівник</th>
                      <th>Сума</th>
                      <th>Стан</th>
                      <th>Дії</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.documents.items.map((row) => (
                      <tr key={row.id}>
                        <td>
                          {documentLabels[row.kind]}
                          <span className="stock-sub">№ {row.number}</span>
                        </td>
                        <td>{row.date}</td>
                        <td>{caption('stores', row.store)}</td>
                        <td>
                          {row.employee
                            ? caption('employees', row.employee)
                            : caption('parties', row.party)}
                        </td>
                        <td>{displayDecimal(row.total)} грн</td>
                        <td>{statusLabels[row.status]}</td>
                        <td>
                          <Button
                            onPress={(event) =>
                              void model.action(() => options.onViewDocument(row.id, event.target))
                            }
                            isDisabled={s.busy}
                          >
                            Відкрити № {row.number}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!s.documents.total ? <p>Документів за цим фільтром немає.</p> : null}
              </div>
              <Pager
                page={s.documents.page}
                pages={s.documents.pages}
                total={s.documents.total}
                busy={s.busy}
                label="Сторінки документів"
                onPage={(p) => void model.page('documentsPage', p)}
              />
            </>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
