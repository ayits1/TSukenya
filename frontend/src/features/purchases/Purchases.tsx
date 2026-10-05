import { useSyncExternalStore, useState, useRef, useLayoutEffect } from 'react';
import { Tabs, TabList, Tab, TabPanel } from 'react-aria-components';
import { Button } from '../../shared/ui/Button';
import { TextField } from '../../shared/ui/TextField';
import { Select } from '../../shared/ui/Select';
import { DatePicker } from '../../shared/ui/DatePicker';
import { DirectoryComboBox } from '../trading/DirectoryComboBox';
import { PurchasesModel } from './state';
import { decimalText, kinds, statuses, type Group, type DocumentQuery } from './api';
import './purchases.css';
function Pager({
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
    <nav className="purchases-pager" aria-label={label}>
      <Button
        data-page="previous"
        isDisabled={busy || page <= 1}
        onPress={() => {
          onPage(page - 1);
        }}
      >
        Назад
      </Button>
      <span role="status" data-page-status tabIndex={-1}>
        {page} / {pages} · записів {total}
      </span>
      <Button
        data-page="next"
        isDisabled={busy || page >= pages}
        onPress={() => {
          onPage(page + 1);
        }}
      >
        Далі
      </Button>
    </nav>
  );
}
function GroupActions({ group, model }: { group: Group; model: PurchasesModel }) {
  const state = model.state,
    disabled = state.busy || state.actionBusy;
  const [selection, setSelection] = useState({ binding: group.binding, part: 1 });
  const part = selection.binding === group.binding ? Math.min(selection.part, group.parts) : 1;
  const choose = (next: number) => setSelection({ binding: group.binding, part: next });
  return (
    <div className="purchases-group-actions">
      <Button isDisabled={disabled} onPress={() => void model.openLines(group)}>
        Переглянути товари ({group.linesCount})
      </Button>
      {group.parts > 1 ? (
        <>
          <p className="tk-help">
            Товарів: {group.linesCount} · частин: {group.parts}. У кожній до 200 товарів. Після
            зміни залишків або проведення замовлення оновіть групу.
          </p>
          <nav
            className="purchases-parts"
            aria-label={`Частини замовлення: ${group.warehouseName}, ${group.partyName || 'без постачальника'}`}
          >
            <Button isDisabled={disabled || part === 1} onPress={() => choose(part - 1)}>
              Попередня частина
            </Button>
            <span role="status">
              Частина {part} / {group.parts}
            </span>
            <Button isDisabled={disabled || part === group.parts} onPress={() => choose(part + 1)}>
              Наступна частина
            </Button>
          </nav>
        </>
      ) : null}
      <Button
        variant="primary"
        isDisabled={disabled}
        aria-label={`Створити замовлення: ${group.partyName || 'постачальник не визначений'}, ${group.warehouseName}${group.parts > 1 ? `, частина ${part} з ${group.parts}` : ''}`}
        onPress={() => void model.prepare(group, part)}
      >
        {group.parts > 1 ? `Підготувати частину ${part} / ${group.parts}` : 'Створити замовлення'}
      </Button>
      {state.prepared.has(group.binding + ':' + part) ? (
        <span className="tk-help">Відкрито у редакторі</span>
      ) : null}
    </div>
  );
}
function DocumentsPanel({ model }: { model: PurchasesModel }) {
  const { documents: data, busy, actionBusy } = model.state;
  if (!data) return null;
  return (
    <section aria-labelledby="purchase-journal-heading">
      <div className="purchases-section-heading">
        <h3 id="purchase-journal-heading">Журнал документів</h3>
        <span>Документів: {data.total}</span>
      </div>
      <p className="tk-help">
        Замовлення планує закупівлю. Товарний залишок і борг постачальнику змінюються після
        проведення надходження.
      </p>
      <div
        className="purchases-table-wrap"
        role="region"
        aria-label="Документи закупівель"
        tabIndex={0}
      >
        <table className="purchases-table">
          <thead>
            <tr>
              {['Документ', 'Дата', 'Магазин / постачальник', 'Сума', 'Стан', 'Дія'].map((x) => (
                <th key={x}>{x}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.items.map((r) => (
              <tr key={r.id}>
                <td data-label="Документ">
                  <strong>{kinds[r.kind]}</strong>
                  <span className="tk-help">№ {r.number}</span>
                </td>
                <td data-label="Дата">{r.date.split('-').reverse().join('.')}</td>
                <td data-label="Магазин / постачальник">
                  <span>{r.storeName}</span>
                  <span className="tk-help">{r.partyName || 'Без постачальника'}</span>
                </td>
                <td data-label="Сума" className="purchases-money">
                  {decimalText(r.total, 2)} грн
                </td>
                <td data-label="Стан">
                  <span className={'purchases-status ' + r.status}>{statuses[r.status]}</span>
                </td>
                <td data-label="Дія">
                  <Button
                    isDisabled={busy || actionBusy}
                    data-document-id={r.id}
                    aria-label={`Відкрити ${kinds[r.kind]} № ${r.number}`}
                    onPress={(event) =>
                      void model.action(() => model.options?.onViewDocument(r.id, event.target))
                    }
                  >
                    Відкрити
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!data.items.length ? (
        <p className="purchases-empty">За цими фільтрами документів немає.</p>
      ) : null}
      <Pager
        page={data.page}
        pages={data.pages}
        total={data.total}
        busy={busy || actionBusy}
        onPage={(p) => void model.page(p)}
        label="Сторінки документів"
      />
    </section>
  );
}
function ReplenishmentPanel({ model }: { model: PurchasesModel }) {
  const { groups: data, chosen, lines, linesBusy, linesError, actionBusy } = model.state;
  if (!data) return null;
  return (
    <section aria-labelledby="purchase-replenishment-heading">
      <div className="purchases-section-heading">
        <h3 id="purchase-replenishment-heading">Поповнення запасів</h3>
        <span>
          Товарів: {data.summary.lines} · груп: {data.summary.groups}
        </span>
      </div>
      <p className="tk-help">
        Потреба до мінімального залишку з урахуванням уже замовленого. Постачальник і ціна — з
        останнього надходження. Перевірте чернетку перед збереженням.
      </p>
      <div className="purchases-summary">
        <strong>Орієнтовно {decimalText(data.summary.total, 2)} грн</strong>
        <span>
          {data.summary.covered} товарів нижче мінімуму вже покриті проведеними замовленнями.
        </span>
      </div>
      <div className="purchases-groups">
        {data.items.map((g) => (
          <article className="purchases-group" key={g.key} data-purchase-group={g.key}>
            <div>
              <h4>{g.partyName || 'Постачальника не визначено'}</h4>
              <p>
                {g.warehouseName} · {g.storeName}
              </p>
              <ul>
                {g.preview.map((l) => (
                  <li key={l.product}>
                    {l.name} — {decimalText(l.quantity)} {l.unit}
                    {!l.costKnown ? <span className="tk-help"> · ціна не визначена</span> : null}
                  </li>
                ))}
              </ul>
              {g.linesCount > g.preview.length ? (
                <p className="tk-help">Іще товарів: {g.linesCount - g.preview.length}</p>
              ) : null}
              <strong>{decimalText(g.total, 2)} грн</strong>
            </div>
            <GroupActions group={g} model={model} />
          </article>
        ))}
      </div>
      {!data.items.length ? (
        <p className="purchases-empty">
          Усі товари вище мінімального залишку або потребу вже покрито замовленнями. Перевірте також
          фільтри.
        </p>
      ) : null}
      <Pager
        page={data.page}
        pages={data.pages}
        total={data.total}
        busy={model.state.busy || actionBusy}
        onPage={(p) => void model.page(p)}
        label="Сторінки груп поповнення"
      />
      {chosen ? (
        <section className="purchases-detail" aria-label="Товари групи поповнення">
          <div className="purchases-section-heading">
            <h4>
              {chosen.partyName || 'Постачальника не визначено'} · {chosen.warehouseName}
            </h4>
            <Button onPress={() => model.closeLines()}>Закрити список товарів</Button>
          </div>
          {linesBusy ? <p role="status">Завантаження товарів…</p> : null}
          {linesError ? (
            <div role="alert">
              <p>{linesError}</p>
              <Button onPress={() => void model.openLines(chosen, model.state.linesPage)}>
                Повторити читання
              </Button>
              <Button onPress={() => void model.refresh()}>Оновити групи</Button>
            </div>
          ) : null}
          {lines ? (
            <>
              <div
                className="purchases-table-wrap"
                role="region"
                aria-label="Потреба товарів"
                tabIndex={0}
              >
                <table className="purchases-table">
                  <thead>
                    <tr>
                      {['Товар', 'Доступно', 'Мінімум', 'Замовлено', 'Потреба', 'Остання ціна'].map(
                        (x) => (
                          <th key={x}>{x}</th>
                        ),
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {lines.items.map((l) => (
                      <tr key={l.product}>
                        <td data-label="Товар">
                          {l.name}
                          <span className="tk-help">{l.unit}</span>
                        </td>
                        <td data-label="Доступно">{decimalText(l.available)}</td>
                        <td data-label="Мінімум">{decimalText(l.minimum)}</td>
                        <td data-label="Замовлено">{decimalText(l.onOrder)}</td>
                        <td data-label="Потреба">
                          <strong>{decimalText(l.quantity)}</strong>
                        </td>
                        <td data-label="Остання ціна">
                          {l.costKnown ? decimalText(l.price, 2) + ' грн' : 'Не визначена'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager
                page={lines.page}
                pages={lines.pages}
                total={lines.total}
                busy={linesBusy}
                onPage={(p) => void model.openLines(chosen, p)}
                label="Сторінки товарів групи"
              />
            </>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}
export function Purchases({ model }: { model: PurchasesModel }) {
  const state = useSyncExternalStore(model.subscribe, model.snapshot),
    options = model.options,
    disabled = state.busy || state.actionBusy;
  const host = useRef<HTMLDivElement>(null),
    focused = useRef(state.focus);
  useLayoutEffect(() => {
    if (state.busy || state.linesBusy || !state.focus || focused.current === state.focus) return;
    focused.current = state.focus;
    const pager = [...(host.current?.querySelectorAll<HTMLElement>('nav[aria-label]') || [])].find(
      (el) => el.getAttribute('aria-label') === state.focus?.label,
    );
    const button = pager?.querySelector<HTMLButtonElement>(`[data-page=${state.focus.direction}]`);
    if (button && !button.disabled) button.focus();
    else pager?.querySelector<HTMLElement>('[data-page-status]')?.focus();
  }, [state.busy, state.linesBusy, state.focus]);
  return (
    <div ref={host} className="purchases-workspace" data-react-purchases>
      <header className="purchases-toolbar">
        {state.policy && !state.denied && options ? (
          <div className="purchases-create">
            {state.policy.documentKinds.map((kind) => (
              <Button
                key={kind}
                variant={kind === 'receipt' ? 'primary' : 'secondary'}
                isDisabled={disabled}
                onPress={() => void model.action(() => options.onCreateDocument(kind))}
              >
                + {kinds[kind]}
              </Button>
            ))}
          </div>
        ) : (
          <span>Закупівлі</span>
        )}
        <Button isDisabled={disabled} onPress={() => void model.reload()}>
          Оновити
        </Button>
      </header>
      {state.error ? (
        <div className="purchases-error" role="alert">
          <p>{state.error}</p>
          <Button isDisabled={disabled} onPress={() => void model.reload()}>
            Повторити завантаження
          </Button>
        </div>
      ) : null}
      {state.notice ? <p role="status">{state.notice}</p> : null}
      {state.busy ? <p role="status">Завантаження закупівель…</p> : null}
      {state.policy && !state.denied && options ? (
        <>
          <Tabs
            className="purchases-tab-layout"
            selectedKey={state.view}
            onSelectionChange={(key) =>
              void model.change({ view: key as 'documents' | 'replenishment' })
            }
          >
            <TabList aria-label="Робота із закупівлями" className="purchases-tabs">
              <Tab id="documents" isDisabled={state.actionBusy}>
                Документи
              </Tab>
              <Tab id="replenishment" isDisabled={state.actionBusy}>
                Поповнення запасів
              </Tab>
            </TabList>
            <form
              className="purchases-filters"
              onSubmit={(event) => {
                event.preventDefault();
                void model.search();
              }}
            >
              <DirectoryComboBox
                api={options.directoryApi}
                type="stores"
                query={{ purpose: 'filter' }}
                label="Магазин"
                value={state.store === null ? '' : String(state.store)}
                selected={state.selectedStore}
                disabled={disabled || state.policy.store !== null}
                emptyLabel="Усі магазини"
                onCommit={(item) =>
                  void model.change({ store: item ? Number(item.id) : null, selectedStore: item })
                }
              />
              {state.view === 'replenishment' ? (
                <DirectoryComboBox
                  api={options.directoryApi}
                  type="warehouses"
                  query={{ purpose: 'filter', ...(state.store ? { store: state.store } : {}) }}
                  label="Склад"
                  value={state.warehouse === null ? '' : String(state.warehouse)}
                  selected={state.selectedWarehouse}
                  disabled={disabled}
                  emptyLabel="Усі склади"
                  onCommit={(item) =>
                    void model.change({
                      warehouse: item ? Number(item.id) : null,
                      selectedWarehouse: item,
                    })
                  }
                />
              ) : (
                <>
                  <Select
                    label="Вид документа"
                    selectedKey={state.kind || 'all'}
                    options={[
                      { id: 'all', label: 'Усі документи' },
                      ...Object.entries(kinds).map(([id, label]) => ({ id, label })),
                    ]}
                    isDisabled={disabled}
                    onSelectionChange={(key) =>
                      model.edit({
                        kind: (key === 'all' ? '' : String(key)) as DocumentQuery['kind'],
                      })
                    }
                  />
                  <Select
                    label="Стан документа"
                    selectedKey={state.status || 'all'}
                    options={[
                      { id: 'all', label: 'Усі стани' },
                      ...Object.entries(statuses).map(([id, label]) => ({ id, label })),
                    ]}
                    isDisabled={disabled}
                    onSelectionChange={(key) =>
                      model.edit({
                        status: (key === 'all' ? '' : String(key)) as DocumentQuery['status'],
                      })
                    }
                  />
                </>
              )}
              <TextField
                label="Пошук"
                placeholder={
                  state.view === 'documents'
                    ? 'Номер або постачальник'
                    : 'Постачальник, склад або товар'
                }
                value={state.q}
                maxLength={250}
                isDisabled={disabled}
                onChange={(q) => model.edit({ q })}
              />
              {state.view === 'documents' ? (
                <>
                  <DatePicker
                    label="З дати"
                    value={state.from}
                    onChange={(from) => model.edit({ from })}
                    isDisabled={disabled}
                  />
                  <DatePicker
                    label="По дату"
                    value={state.to}
                    onChange={(to) => model.edit({ to })}
                    isDisabled={disabled}
                  />
                </>
              ) : null}
              <Button type="submit" isDisabled={disabled}>
                Знайти
              </Button>
            </form>
            {state.view === 'replenishment' ? (
              <p className="tk-help">
                Пошук знаходить групи за постачальником, складом або товаром; замовлення містить усі
                потрібні товари групи.
              </p>
            ) : null}
            <TabPanel id="documents">
              <DocumentsPanel model={model} />
            </TabPanel>
            <TabPanel id="replenishment">
              <ReplenishmentPanel model={model} />
            </TabPanel>
          </Tabs>
        </>
      ) : null}
    </div>
  );
}
