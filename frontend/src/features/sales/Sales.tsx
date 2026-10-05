import { useSyncExternalStore, useRef, useLayoutEffect } from 'react';
import { Tabs, TabList, Tab, TabPanel } from 'react-aria-components';
import { Button } from '../../shared/ui/Button';
import { TextField } from '../../shared/ui/TextField';
import { Select } from '../../shared/ui/Select';
import { DatePicker } from '../../shared/ui/DatePicker';
import { DirectoryComboBox } from '../trading/DirectoryComboBox';
import { SalesModel } from './state';
import { kinds, statuses, moneyText, type DocumentQuery, type ShiftQuery } from './api';
import './sales.css';
const time = (value: string) =>
  new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv',
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
function Pager({ model }: { model: SalesModel }) {
  const data = model.state.documents ?? model.state.shifts;
  if (!data) return null;
  return (
    <nav className="sales-pager" aria-label="Сторінки результатів">
      <Button
        data-page="previous"
        isDisabled={!model.ready() || data.page <= 1}
        onPress={() => void model.page(data.page - 1)}
      >
        Назад
      </Button>
      <span role="status" data-page-status tabIndex={-1}>
        {data.page} / {data.pages} · записів {data.total}
      </span>
      <Button
        data-page="next"
        isDisabled={!model.ready() || data.page >= data.pages}
        onPress={() => void model.page(data.page + 1)}
      >
        Далі
      </Button>
    </nav>
  );
}
function DocumentsPanel({ model }: { model: SalesModel }) {
  const data = model.state.documents;
  if (!data) return null;
  return (
    <section aria-labelledby="sales-journal-heading">
      <div className="sales-section-heading">
        <h3 id="sales-journal-heading">Журнал продажів</h3>
        <span>Документів: {data.total}</span>
      </div>
      <p className="tk-help">
        {data.fiscalRequired
          ? 'Для проведення продажу потрібен номер чека, виданого вашим ПРРО.'
          : 'Продажі записуються в облік. Автоматична фіскалізація ще не підключена; чек ПРРО можна зазначити вручну.'}
      </p>
      <div className="sales-table-wrap" role="region" aria-label="Документи продажів" tabIndex={0}>
        <table className="sales-table">
          <thead>
            <tr>
              {['Документ', 'Дата', 'Магазин / покупець', 'Сума', 'Стан', 'Дія'].map((x) => (
                <th key={x} scope="col">
                  {x}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.items.map((row) => (
              <tr key={row.id}>
                <td data-label="Документ">
                  <strong>{kinds[row.kind]}</strong>
                  <span className="tk-help">№ {row.number}</span>
                </td>
                <td data-label="Дата">{row.date.split('-').reverse().join('.')}</td>
                <td data-label="Магазин / покупець">
                  <span>{row.storeName}</span>
                  <span className="tk-help">{row.partyName || 'Без покупця'}</span>
                  {row.employeeName ? (
                    <span className="tk-help">Працівник: {row.employeeName}</span>
                  ) : null}
                </td>
                <td data-label="Сума" className="sales-money">
                  {moneyText(row.total)} грн
                </td>
                <td data-label="Стан">
                  <span className={'sales-status ' + row.status}>{statuses[row.status]}</span>
                </td>
                <td data-label="Дія">
                  <Button
                    isDisabled={!model.ready()}
                    data-document-id={row.id}
                    aria-label={`Відкрити ${kinds[row.kind]} № ${row.number}`}
                    onPress={(event) =>
                      void model.action(() => model.options?.onViewDocument(row.id, event.target))
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
        <p className="sales-empty">За цими фільтрами документів немає.</p>
      ) : null}
      <Pager model={model} />
    </section>
  );
}
function ShiftsPanel({ model }: { model: SalesModel }) {
  const data = model.state.shifts;
  if (!data) return null;
  return (
    <section aria-labelledby="sales-shifts-heading">
      <div className="sales-section-heading">
        <h3 id="sales-shifts-heading">Касові зміни</h3>
        <span>Змін: {data.total}</span>
      </div>
      <p className="tk-help">
        Час за Києвом. Період відбирає дату відкриття зміни. Розходження — порахована готівка мінус
        очікувана, зафіксовані при закритті.
      </p>
      <div className="sales-table-wrap" role="region" aria-label="Журнал касових змін" tabIndex={0}>
        <table className="sales-table">
          <thead>
            <tr>
              {['Зміна / час', 'Магазин / каса', 'Працівник', 'Готівка, грн', 'Стан / дія'].map(
                (x) => (
                  <th key={x} scope="col">
                    {x}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {data.items.map((row) => (
              <tr key={row.id}>
                <td data-label="Зміна / час">
                  <strong>№ {row.id}</strong>
                  <span>{time(row.openedAt)}</span>
                  {row.closedAt ? (
                    <span className="tk-help">Закрито: {time(row.closedAt)}</span>
                  ) : null}
                </td>
                <td data-label="Магазин / каса">
                  <span>{row.storeName}</span>
                  <span className="tk-help">{row.accountName}</span>
                </td>
                <td data-label="Працівник">
                  <span>{row.employeeName || 'Без працівника'}</span>
                  <span className="tk-help">Відкрив: {row.openedBy}</span>
                </td>
                <td data-label="Готівка, грн" className="sales-money">
                  <dl className="sales-cash">
                    <div>
                      <dt>На початку</dt>
                      <dd>{moneyText(row.openingCash)}</dd>
                    </div>
                    {row.closedAt ? (
                      <>
                        <div>
                          <dt>Очікувана</dt>
                          <dd>{row.expectedCash === null ? '—' : moneyText(row.expectedCash)}</dd>
                        </div>
                        <div>
                          <dt>Порахована</dt>
                          <dd>{row.countedCash === null ? '—' : moneyText(row.countedCash)}</dd>
                        </div>
                        <div>
                          <dt>Розходження</dt>
                          <dd>{row.difference === null ? '—' : moneyText(row.difference)}</dd>
                        </div>
                      </>
                    ) : null}
                  </dl>
                </td>
                <td data-label="Стан / дія">
                  <span className={'sales-status ' + (row.closedAt ? '' : 'posted')}>
                    {row.closedAt ? 'Закрита' : 'Відкрита'}
                  </span>
                  {row.canClose ? (
                    <Button
                      isDisabled={!model.canClose(row)}
                      aria-label={`Закрити зміну № ${row.id}`}
                      onPress={() => void model.closeShift(row)}
                    >
                      Закрити зміну
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!data.items.length ? (
        <p className="sales-empty">За цими фільтрами касових змін немає.</p>
      ) : null}
      <Pager model={model} />
    </section>
  );
}
export function Sales({ model }: { model: SalesModel }) {
  const state = useSyncExternalStore(model.subscribe, model.snapshot),
    options = model.options,
    host = useRef<HTMLDivElement>(null),
    disabled = state.busy || state.actionBusy;
  useLayoutEffect(() => {
    if (state.busy || !state.focus) return;
    const button = host.current?.querySelector<HTMLButtonElement>(`[data-page="${state.focus}"]`);
    if (button && !button.disabled) button.focus();
    else host.current?.querySelector<HTMLElement>('[data-page-status]')?.focus();
  }, [state.busy, state.focus]);
  return (
    <div ref={host} className="sales-workspace" data-react-sales>
      <header className="sales-toolbar">
        {state.policy && !state.denied && options ? (
          <div className="sales-create">
            {state.view === 'documents' ? (
              state.policy.documentKinds.map((kind) => (
                <Button
                  key={kind}
                  variant={kind === 'sale' ? 'primary' : 'secondary'}
                  isDisabled={!model.ready()}
                  onPress={() => void model.action(() => options.onCreateDocument(kind))}
                >
                  + {kinds[kind]}
                </Button>
              ))
            ) : (
              <Button
                variant="primary"
                isDisabled={!model.ready()}
                onPress={() => void model.action(options.onOpenShift)}
              >
                Відкрити зміну
              </Button>
            )}
          </div>
        ) : (
          <span>Продажі</span>
        )}
        <Button isDisabled={disabled} onPress={() => void model.reload()}>
          Оновити
        </Button>
      </header>
      {state.error ? (
        <div className="sales-error" role="alert">
          <p>{state.error}</p>
          <Button isDisabled={disabled} onPress={() => void model.reload()}>
            Повторити завантаження
          </Button>
        </div>
      ) : null}
      {state.busy ? <p role="status">Завантаження продажів…</p> : null}
      {state.policy && !state.denied && options ? (
        <Tabs
          className="sales-tab-layout"
          selectedKey={state.view}
          onSelectionChange={(key) => void model.change({ view: key as 'documents' | 'shifts' })}
        >
          <TabList aria-label="Робота з продажами" className="sales-tabs">
            <Tab id="documents" isDisabled={state.actionBusy}>
              Документи
            </Tab>
            <Tab id="shifts" isDisabled={state.actionBusy}>
              Касові зміни
            </Tab>
          </TabList>
          <form
            className="sales-filters"
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
            {state.view === 'documents' ? (
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
                <TextField
                  label="Пошук"
                  placeholder="Номер або покупець"
                  value={state.q}
                  maxLength={250}
                  isDisabled={disabled}
                  onChange={(q) => model.edit({ q })}
                />
              </>
            ) : (
              <>
                <DirectoryComboBox
                  api={options.directoryApi}
                  type="employees"
                  query={{ purpose: 'filter', ...(state.store ? { store: state.store } : {}) }}
                  label="Працівник"
                  value={state.employee === null ? '' : String(state.employee)}
                  selected={state.selectedEmployee}
                  disabled={disabled}
                  emptyLabel="Усі працівники"
                  onCommit={(item) =>
                    void model.change({
                      employee: item ? Number(item.id) : null,
                      selectedEmployee: item,
                    })
                  }
                />
                <Select
                  label="Стан зміни"
                  selectedKey={state.shiftStatus || 'all'}
                  options={[
                    { id: 'all', label: 'Усі зміни' },
                    { id: 'open', label: 'Відкриті' },
                    { id: 'closed', label: 'Закриті' },
                  ]}
                  isDisabled={disabled}
                  onSelectionChange={(key) =>
                    model.edit({
                      shiftStatus: (key === 'all' ? '' : String(key)) as ShiftQuery['status'],
                    })
                  }
                />
              </>
            )}
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
            <Button type="submit" isDisabled={disabled}>
              Знайти
            </Button>
          </form>
          <TabPanel id="documents">
            <DocumentsPanel model={model} />
          </TabPanel>
          <TabPanel id="shifts">
            <ShiftsPanel model={model} />
          </TabPanel>
        </Tabs>
      ) : null}
    </div>
  );
}
