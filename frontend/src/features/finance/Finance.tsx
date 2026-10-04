import { useSyncExternalStore, useRef, useLayoutEffect, type ReactNode } from 'react';
import { Tabs, TabList, Tab, TabPanel } from 'react-aria-components';
import { Button } from '../../shared/ui/Button';
import { TextField } from '../../shared/ui/TextField';
import { Select } from '../../shared/ui/Select';
import { DatePicker } from '../../shared/ui/DatePicker';
import { DirectoryComboBox } from '../trading/DirectoryComboBox';
import { FinanceModel } from './state';
import { tabs, kinds, documentKinds, statuses, moneyText, type Resource } from './api';
import './finance.css';
const displayDate = (value: string) => (value ? value.split('-').reverse().join('.') : '—');
const accountKinds = { cash: 'Готівка', bank: 'Банк', terminal: 'Термінал' };
function Table({
  label,
  headers,
  children,
}: {
  label: string;
  headers: string[];
  children: ReactNode;
}) {
  return (
    <div className="finance-table-wrap" role="region" aria-label={label} tabIndex={0}>
      <table className="finance-table">
        <thead>
          <tr>
            {headers.map((x) => (
              <th scope="col" key={x}>
                {x}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
function Cell({ label, children }: { label: string; children: ReactNode }) {
  return <td data-label={label}>{children}</td>;
}
function Results({ model }: { model: FinanceModel }) {
  const s = model.state,
    disabled = !model.ready();
  if (!s.data) return null;
  if (s.view === 'accounts') {
    const data = model.result('accounts')!;
    return (
      <Table label="Грошові рахунки" headers={['Рахунок', 'Магазин', 'Вид', 'Залишок', 'Дія']}>
        {data.items.map((r) => (
          <tr key={r.id}>
            <Cell label="Рахунок">{r.name}</Cell>
            <Cell label="Магазин">{r.storeName}</Cell>
            <Cell label="Вид">{accountKinds[r.kind]}</Cell>
            <Cell label="Залишок">{moneyText(r.balance)} грн</Cell>
            <Cell label="Дія">
              {data.policy.canManageAccounts ? (
                <Button
                  isDisabled={disabled}
                  aria-label={'Редагувати рахунок: ' + r.name}
                  onPress={() => void model.action(() => model.options?.onEditAccount(r.id))}
                >
                  Редагувати
                </Button>
              ) : (
                <span>Лише перегляд</span>
              )}
            </Cell>
          </tr>
        ))}
      </Table>
    );
  }
  if (s.view === 'debts') {
    const data = model.result('debts')!;
    return (
      <>
        <div className="finance-summary">
          <div>
            <span>Нам винні · усі знайдені борги</span>
            <strong>{moneyText(data.totals.owedToUs)} грн</strong>
          </div>
          <div>
            <span>Ми винні · усі знайдені борги</span>
            <strong>{moneyText(data.totals.owedByUs)} грн</strong>
          </div>
        </div>
        <Table
          label="Заборгованість"
          headers={['Документ', 'Дата', 'Магазин / контрагент', 'Борг', 'Строк оплати', 'Дія']}
        >
          {data.items.map((r) => (
            <tr key={r.id}>
              <Cell label="Документ">
                <strong>
                  {documentKinds[r.originalKind]} № {r.number}
                </strong>
                <span className="tk-help">{r.kind === 'receipt' ? 'Ми винні' : 'Нам винні'}</span>
              </Cell>
              <Cell label="Дата">{displayDate(r.date)}</Cell>
              <Cell label="Магазин / контрагент">
                {r.storeName}
                <span className="tk-help">{r.partyName}</span>
              </Cell>
              <Cell label="Борг">{moneyText(r.amount)} грн</Cell>
              <Cell label="Строк оплати">
                {r.dueDate || 'Без строку'}
                {r.overdue ? <strong className="finance-overdue">Прострочено</strong> : null}
              </Cell>
              <Cell label="Дія">
                <Button
                  isDisabled={disabled}
                  aria-label={'Оплатити борг № ' + r.number}
                  onPress={() => void model.payDebt(r)}
                >
                  Оплатити борг
                </Button>
              </Cell>
            </tr>
          ))}
        </Table>
      </>
    );
  }
  if (s.view === 'advances') {
    const data = model.result('advances')!;
    return (
      <>
        <div className="finance-summary">
          <div>
            <span>Аванси покупців · усі знайдені</span>
            <strong>{moneyText(data.totals.customer)} грн</strong>
          </div>
          <div>
            <span>Аванси постачальникам · усі знайдені</span>
            <strong>{moneyText(data.totals.supplier)} грн</strong>
          </div>
        </div>
        <p className="tk-help">
          Аванси й борги показані окремо, без автоматичного взаємозаліку. Для звірки виберіть
          контрагента.
        </p>
        <Button
          isDisabled={disabled || s.filters.advances.party === null}
          onPress={() => void model.statement()}
        >
          Управлінська звірка
        </Button>
        <Table
          label="Невикористані аванси"
          headers={['Платіж', 'Дата', 'Магазин / контрагент', 'Напрям', 'Невикористано', 'Дії']}
        >
          {data.items.map((r) => (
            <tr key={r.id}>
              <Cell label="Платіж">№ {r.number}</Cell>
              <Cell label="Дата">{displayDate(r.date)}</Cell>
              <Cell label="Магазин / контрагент">
                {r.storeName}
                <span className="tk-help">{r.partyName}</span>
              </Cell>
              <Cell label="Напрям">
                {r.direction === 'customer' ? 'Від покупця' : 'Постачальнику'}
              </Cell>
              <Cell label="Невикористано">{moneyText(r.unallocated)} грн</Cell>
              <Cell label="Дії">
                <div className="finance-row-actions">
                  <Button
                    isDisabled={disabled}
                    aria-label={'Використати аванс № ' + r.number}
                    onPress={() => void model.advance('advance_allocation', r)}
                  >
                    Використати
                  </Button>
                  <Button
                    isDisabled={disabled}
                    aria-label={'Повернути аванс № ' + r.number}
                    onPress={() => void model.advance('payment_refund', r)}
                  >
                    Повернути
                  </Button>
                </div>
              </Cell>
            </tr>
          ))}
        </Table>
      </>
    );
  }
  if (s.view === 'ledger') {
    const data = model.result('ledger')!;
    return (
      <Table
        label="Рух коштів"
        headers={['Дата', 'Документ / операція', 'Рахунок / магазин', 'Примітка', 'Сума', 'Дія']}
      >
        {data.items.map((r) => (
          <tr key={r.id}>
            <Cell label="Дата">{displayDate(r.date)}</Cell>
            <Cell label="Документ / операція">
              {documentKinds[r.kind]} № {r.number}
              {r.reversal ? <strong>Скасування</strong> : null}
            </Cell>
            <Cell label="Рахунок / магазин">
              {r.accountName}
              <span className="tk-help">{r.storeName}</span>
            </Cell>
            <Cell label="Примітка">{r.note || '—'}</Cell>
            <Cell label="Сума">{moneyText(r.amount)} грн</Cell>
            <Cell label="Дія">
              <Button
                isDisabled={disabled}
                aria-label={'Відкрити документ № ' + r.number}
                onPress={() => void model.action(() => model.options?.onViewDocument(r.voucher))}
              >
                Документ
              </Button>
            </Cell>
          </tr>
        ))}
      </Table>
    );
  }
  const data = model.result('documents')!;
  return (
    <Table
      label="Фінансові документи"
      headers={['Документ', 'Дата', 'Магазин / контрагент', 'Сума', 'Стан', 'Дія']}
    >
      {data.items.map((r) => (
        <tr key={r.id}>
          <Cell label="Документ">
            {kinds[r.kind]} № {r.number}
          </Cell>
          <Cell label="Дата">{displayDate(r.date)}</Cell>
          <Cell label="Магазин / контрагент">
            {r.storeName}
            <span className="tk-help">{r.partyName || 'Без контрагента'}</span>
          </Cell>
          <Cell label="Сума">{moneyText(r.total)} грн</Cell>
          <Cell label="Стан">{statuses[r.status]}</Cell>
          <Cell label="Дія">
            <Button
              isDisabled={disabled}
              aria-label={'Відкрити ' + kinds[r.kind] + ' № ' + r.number}
              onPress={() => void model.action(() => model.options?.onViewDocument(r.id))}
            >
              Відкрити
            </Button>
          </Cell>
        </tr>
      ))}
    </Table>
  );
}
export function Finance({ model }: { model: FinanceModel }) {
  const state = useSyncExternalStore(model.subscribe, model.snapshot),
    options = model.options,
    disabled = state.busy || state.actionBusy,
    f = state.filters[state.view],
    host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (state.busy || state.actionBusy) return;
    if (state.error) {
      host.current?.querySelector<HTMLButtonElement>('[data-finance-retry]')?.focus();
      return;
    }
    if (!state.focus) return;
    const pager = host.current?.querySelector('[data-finance-pager]'),
      button = pager?.querySelector<HTMLButtonElement>(`[data-page=${state.focus}]`);
    if (button && !button.disabled) button.focus();
    else pager?.querySelector<HTMLElement>('[data-page-status]')?.focus();
  }, [state.busy, state.actionBusy, state.error, state.focus, state.data]);
  return (
    <div className="finance-workspace" data-react-finance ref={host}>
      <header className="finance-toolbar">
        <h2>Фінанси</h2>
        <div className="finance-row-actions">
          <Button isDisabled={disabled} onPress={() => void model.reload()}>
            Оновити
          </Button>
          {!state.denied ? (
            <Button isDisabled={disabled} onPress={() => options?.onDrafts()}>
              Локальні чернетки
            </Button>
          ) : null}
        </div>
      </header>
      {state.error ? (
        <div className="finance-error" role="alert">
          <p>{state.error}</p>
          <Button
            data-finance-retry
            isDisabled={disabled}
            onPress={() => void (state.denied ? model.reload() : model.refresh())}
          >
            {state.denied ? 'Перевірити доступ' : 'Повторити читання'}
          </Button>
        </div>
      ) : null}
      {state.busy ? <p role="status">Завантаження фінансів…</p> : null}
      {state.policy && !state.denied && options ? (
        <>
          <div className="finance-create" aria-label="Створення фінансового документа">
            {state.policy.createKinds.map((k) => (
              <Button
                key={k}
                isDisabled={disabled}
                onPress={() => void model.action(() => options.onCreateDocument(k))}
              >
                + {kinds[k]}
              </Button>
            ))}
          </div>
          <Tabs
            className="finance-tab-layout"
            selectedKey={state.view}
            onSelectionChange={(key) => void model.change(key as Resource)}
          >
            <TabList className="finance-tabs" aria-label="Робота з фінансами">
              {Object.entries(tabs).map(([id, label]) => (
                <Tab key={id} id={id} isDisabled={state.actionBusy}>
                  {label}
                </Tab>
              ))}
            </TabList>
            <form
              className="finance-filters"
              onSubmit={(e) => {
                e.preventDefault();
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
                onCommit={(item) => void model.store(item ? Number(item.id) : null, item)}
              />
              {state.view !== 'documents' ? (
                <TextField
                  label="Пошук"
                  placeholder={state.view === 'accounts' ? 'Назва рахунку' : 'Номер або контрагент'}
                  value={f.q}
                  maxLength={250}
                  isDisabled={disabled}
                  onChange={(q) => model.edit({ q })}
                />
              ) : null}
              {['debts', 'advances'].includes(state.view) ? (
                <DirectoryComboBox
                  api={options.directoryApi}
                  type="parties"
                  query={{ purpose: 'filter' }}
                  label="Контрагент"
                  value={f.party === null ? '' : String(f.party)}
                  selected={f.selectedParty}
                  disabled={disabled}
                  emptyLabel="Усі контрагенти"
                  onCommit={(item) => {
                    model.edit({ party: item ? Number(item.id) : null, selectedParty: item });
                    void model.search();
                  }}
                />
              ) : null}
              {state.view === 'ledger' ? (
                <DirectoryComboBox
                  api={options.directoryApi}
                  type="accounts"
                  query={{ purpose: 'filter', ...(state.store ? { store: state.store } : {}) }}
                  label="Рахунок"
                  value={f.account === null ? '' : String(f.account)}
                  selected={f.selectedAccount}
                  disabled={disabled}
                  emptyLabel="Усі рахунки"
                  onCommit={(item) => {
                    model.edit({ account: item ? Number(item.id) : null, selectedAccount: item });
                    void model.search();
                  }}
                />
              ) : null}
              {['debts', 'ledger'].includes(state.view) ? (
                <>
                  <DatePicker
                    label="З дати"
                    value={f.from}
                    onChange={(from) => model.edit({ from })}
                    isDisabled={disabled}
                  />
                  <DatePicker
                    label="По дату"
                    value={f.to}
                    onChange={(to) => model.edit({ to })}
                    isDisabled={disabled}
                  />
                </>
              ) : null}
              {state.view === 'debts' ? (
                <>
                  <DatePicker
                    label="Строк оплати з"
                    value={f.due_from}
                    onChange={(due_from) => model.edit({ due_from })}
                    isDisabled={disabled}
                  />
                  <DatePicker
                    label="Строк оплати по"
                    value={f.due_to}
                    onChange={(due_to) => model.edit({ due_to })}
                    isDisabled={disabled}
                  />
                  <Select
                    label="Стан боргу"
                    selectedKey={f.status || 'all'}
                    isDisabled={disabled}
                    options={[
                      { id: 'all', label: 'Усі борги' },
                      { id: 'overdue', label: 'Прострочені' },
                      { id: 'not_overdue', label: 'Не прострочені' },
                    ]}
                    onSelectionChange={(k) => model.edit({ status: k === 'all' ? '' : String(k) })}
                  />
                </>
              ) : null}
              {state.view === 'documents' ? (
                <Select
                  label="Стан документа"
                  selectedKey={f.status || 'all'}
                  isDisabled={disabled}
                  options={[
                    { id: 'all', label: 'Усі стани' },
                    ...Object.entries(statuses).map(([id, label]) => ({ id, label })),
                  ]}
                  onSelectionChange={(k) => model.edit({ status: k === 'all' ? '' : String(k) })}
                />
              ) : null}
              <Button type="submit" isDisabled={disabled} variant="primary">
                Знайти
              </Button>
              <Button isDisabled={disabled} onPress={() => void model.reset()}>
                Очистити фільтри
              </Button>
            </form>
            {Object.entries(tabs).map(([view, label]) => (
              <TabPanel key={view} id={view} className="finance-panel">
                <h3>{label}</h3>
                {state.view === 'accounts' && state.policy?.canManageAccounts ? (
                  <Button
                    isDisabled={!model.ready()}
                    onPress={() => void model.action(() => options.onEditAccount(null))}
                  >
                    Додати рахунок
                  </Button>
                ) : null}
                <Results model={model} />
                {state.data && !state.data.items.length ? (
                  <p className="finance-empty">За цими фільтрами записів немає.</p>
                ) : null}
                {state.data ? (
                  <nav data-finance-pager className="finance-pager" aria-label="Сторінки фінансів">
                    <Button
                      data-page="previous"
                      isDisabled={disabled || state.data.page <= 1}
                      onPress={() => void model.page(state.data!.page - 1)}
                    >
                      Назад
                    </Button>
                    <span data-page-status role="status" tabIndex={-1}>
                      {state.data.page} / {state.data.pages} · записів {state.data.total}
                    </span>
                    <Button
                      data-page="next"
                      isDisabled={disabled || state.data.page >= state.data.pages}
                      onPress={() => void model.page(state.data!.page + 1)}
                    >
                      Далі
                    </Button>
                  </nav>
                ) : null}
              </TabPanel>
            ))}
          </Tabs>
        </>
      ) : null}
    </div>
  );
}
