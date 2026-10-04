import { useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { Tabs, TabList, Tab, TabPanel } from 'react-aria-components';
import { Button } from '../../shared/ui/Button';
import { DatePicker } from '../../shared/ui/DatePicker';
import { TextField } from '../../shared/ui/TextField';
import { Select } from '../../shared/ui/Select';
import { DirectoryComboBox } from '../trading/DirectoryComboBox';
import { bases, kinds, statuses, tabs, moneyText, quantityText, type Resource } from './api';
import { StaffModel } from './state';
import './staff.css';

const displayDate = (value: string) => value.split('-').reverse().join('.');
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
    <div className="staff-table-wrap" role="region" aria-label={label} tabIndex={0}>
      <table className="staff-table">
        <thead>
          <tr>
            {headers.map((label) => (
              <th scope="col" key={label}>
                {label}
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
function Results({ model }: { model: StaffModel }) {
  const s = model.state,
    options = model.options,
    disabled = !model.ready();
  if (!s.data || !options) return null;
  if (s.data.total === 0)
    return (
      <p className="staff-empty" role="status">
        За цими фільтрами записів немає.
      </p>
    );
  if (s.view === 'employees') {
    const data = model.result('employees')!;
    return (
      <Table
        label="Працівники та умови оплати"
        headers={['Працівник', 'Магазин', 'Ставка за зміну', 'Відсоток', 'До виплати', 'Дії']}
      >
        {data.items.map((row) => (
          <tr key={row.id}>
            <Cell label="Працівник">
              {row.name}
              {!row.active ? <span className="staff-muted">Неактивний</span> : null}
            </Cell>
            <Cell label="Магазин">{row.storeName}</Cell>
            <Cell label="Ставка за зміну">{moneyText(row.shiftRate)} грн</Cell>
            <Cell label="Відсоток">
              {quantityText(row.bonusPercent)} %
              <span className="staff-muted">{bases[row.bonusBasis]}</span>
            </Cell>
            <Cell label="До виплати">{moneyText(row.payrollDebt)} грн</Cell>
            <Cell label="Дії">
              {data.policy.canManageEmployees ? (
                <Button
                  isDisabled={disabled}
                  aria-label={'Редагувати працівника: ' + row.name}
                  onPress={(event) =>
                    void model.action(() => options.onEditEmployee(row.id), event.target)
                  }
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
  if (s.view === 'work-shifts') {
    const data = model.result('work-shifts')!;
    return (
      <Table
        label="Табель робочих змін"
        headers={[
          'Дата',
          'Працівник / магазин',
          'Змін',
          'Зафіксовані умови',
          'Нараховано',
          'Стан / дії',
        ]}
      >
        {data.items.map((row) => (
          <tr key={row.id}>
            <Cell label="Дата">
              {displayDate(row.date)}
              <span className="staff-muted">
                Табель № {row.id} ·{' '}
                {row.cashShift ? 'Касова зміна № ' + row.cashShift : 'Без касової зміни'}
              </span>
            </Cell>
            <Cell label="Працівник / магазин">
              {row.employeeName}
              <span className="staff-muted">
                {row.storeName}
                {!row.employeeActive ? ' · неактивний працівник' : ''}
              </span>
            </Cell>
            <Cell label="Змін">{quantityText(row.units)}</Cell>
            <Cell label="Зафіксовані умови">
              {moneyText(row.shiftRate)} грн + {quantityText(row.bonusPercent)} %
              <span className="staff-muted">{bases[row.bonusBasis]}</span>
            </Cell>
            <Cell label="Нараховано">{moneyText(row.accrued)} грн</Cell>
            <Cell label="Стан / дії">
              {row.payroll ? (
                <Button
                  isDisabled={disabled}
                  aria-label={'Нарахування № ' + row.payroll + ' для ' + row.employeeName}
                  onPress={(event) =>
                    void model.action(() => options.onViewDocument(row.payroll!), event.target)
                  }
                >
                  Нарахування
                </Button>
              ) : row.canEdit ? (
                <Button
                  isDisabled={disabled}
                  aria-label={
                    'Редагувати табель № ' + row.id + ' ' + row.employeeName + ' за ' + row.date
                  }
                  onPress={(event) =>
                    void model.action(() => options.onWorkShift(row.id), event.target)
                  }
                >
                  Редагувати
                </Button>
              ) : (
                <span>Закритий період</span>
              )}
            </Cell>
          </tr>
        ))}
      </Table>
    );
  }
  const data = model.result('documents')!;
  return (
    <Table
      label="Зарплатні документи"
      headers={['Документ', 'Дата', 'Працівник / магазин', 'Сума', 'Стан', 'Дії']}
    >
      {data.items.map((row) => (
        <tr key={row.id}>
          <Cell label="Документ">
            {kinds[row.kind]} № {row.number}
          </Cell>
          <Cell label="Дата">{displayDate(row.date)}</Cell>
          <Cell label="Працівник / магазин">
            {row.employeeName || 'Без працівника'}
            <span className="staff-muted">{row.storeName}</span>
          </Cell>
          <Cell label="Сума">{moneyText(row.total)} грн</Cell>
          <Cell label="Стан">
            <span className={'staff-status ' + row.status}>{statuses[row.status]}</span>
          </Cell>
          <Cell label="Дії">
            <Button
              isDisabled={disabled}
              aria-label={'Відкрити ' + kinds[row.kind] + ' № ' + row.number}
              onPress={(event) =>
                void model.action(() => options.onViewDocument(row.id), event.target)
              }
            >
              Відкрити
            </Button>
          </Cell>
        </tr>
      ))}
    </Table>
  );
}

export function Staff({ model }: { model: StaffModel }) {
  const s = useSyncExternalStore(model.subscribe, model.snapshot),
    host = useRef<HTMLDivElement>(null),
    options = model.options;
  const disabled = s.busy || s.actionBusy,
    f = s.filters[s.view];
  useLayoutEffect(() => {
    if (!s.focus || disabled) return;
    if (s.error) {
      host.current?.querySelector<HTMLButtonElement>('[data-staff-retry]')?.focus();
      return;
    }
    const button = host.current?.querySelector<HTMLButtonElement>('[data-page=' + s.focus + ']');
    if (button && !button.disabled) button.focus();
    else host.current?.querySelector<HTMLElement>('[data-page-status]')?.focus();
  }, [s.focus, disabled, s.data, s.error]);
  return (
    <div className="staff-workspace" data-react-staff ref={host}>
      <header className="staff-toolbar">
        <h2>Команда й зарплата</h2>
        <div className="staff-row-actions">
          <Button isDisabled={disabled} onPress={() => void model.reload()}>
            Оновити
          </Button>
          {!s.denied ? (
            <Button isDisabled={disabled} onPress={() => options?.onDrafts()}>
              Локальні чернетки
            </Button>
          ) : null}
        </div>
      </header>
      {s.error ? (
        <div className="staff-error" role="alert">
          <p>{s.error}</p>
          <Button
            data-staff-retry
            isDisabled={disabled}
            onPress={() => void (s.denied ? model.reload() : model.refresh())}
          >
            {s.denied ? 'Перевірити доступ' : 'Повторити читання'}
          </Button>
        </div>
      ) : null}
      {s.busy ? <p role="status">Завантаження команди…</p> : null}
      {s.policy && !s.denied && options ? (
        <>
          <p className="staff-notice">
            Ставка й відсоток конкретної зміни зберігаються у табелі. Кількість змін множить лише
            ставку; відсоток від виторгу вибраної касової зміни враховується один раз. Нарахування
            та виплата — окремі документи.
          </p>
          <div className="staff-create" aria-label="Документи зарплати">
            {s.policy.documentKinds.map((kind) => (
              <Button
                key={kind}
                isDisabled={!model.ready()}
                onPress={(event) =>
                  void model.action(() => options.onCreateDocument(kind), event.target)
                }
              >
                + {kinds[kind]}
              </Button>
            ))}
          </div>
          <Tabs
            className="staff-tab-layout"
            selectedKey={s.view}
            onSelectionChange={(key) => void model.change(key as Resource)}
          >
            <TabList className="staff-tabs" aria-label="Команда й зарплата">
              {Object.entries(tabs).map(([id, label]) => (
                <Tab key={id} id={id} isDisabled={s.actionBusy}>
                  {label}
                </Tab>
              ))}
            </TabList>
            <form
              className="staff-filters"
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
                value={s.store === null ? '' : String(s.store)}
                selected={s.selectedStore}
                disabled={disabled || s.policy.store !== null}
                onCommit={(item) => void model.store(item ? Number(item.id) : null, item)}
                emptyLabel="Усі магазини"
              />
              {s.view === 'employees' ? (
                <TextField
                  label="Пошук працівника"
                  value={f.q}
                  onChange={(q) => model.edit({ q })}
                  isDisabled={disabled}
                  maxLength={250}
                />
              ) : null}
              {s.view === 'work-shifts' ? (
                <>
                  <DirectoryComboBox
                    api={options.directoryApi}
                    type="employees"
                    query={{ purpose: 'filter', ...(s.store ? { store: s.store } : {}) }}
                    label="Працівник"
                    value={f.employee === null ? '' : String(f.employee)}
                    selected={f.selectedEmployee}
                    disabled={disabled}
                    emptyLabel="Усі працівники"
                    onCommit={(item) => {
                      model.edit({
                        employee: item ? Number(item.id) : null,
                        selectedEmployee: item,
                      });
                      void model.search();
                    }}
                  />
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
              {s.view === 'documents' ? (
                <Select
                  label="Стан документа"
                  selectedKey={f.status || 'all'}
                  onSelectionChange={(key) =>
                    model.edit({ status: key === 'all' ? '' : String(key) })
                  }
                  isDisabled={disabled}
                  options={[
                    { id: 'all', label: 'Усі стани' },
                    ...Object.entries(statuses).map(([id, label]) => ({ id, label })),
                  ]}
                />
              ) : null}
              <Button type="submit" isDisabled={disabled} variant="primary">
                Знайти
              </Button>
              <Button isDisabled={disabled} onPress={() => void model.reset()}>
                Очистити фільтри
              </Button>
            </form>
            {(Object.keys(tabs) as Resource[]).map((resource) => (
              <TabPanel key={resource} id={resource}>
                <section>
                  <div className="staff-section-heading">
                    <h3>{tabs[resource]}</h3>
                    {resource === 'employees' && s.policy?.canManageEmployees ? (
                      <Button
                        isDisabled={!model.ready()}
                        onPress={(event) =>
                          void model.action(() => options.onEditEmployee(null), event.target)
                        }
                      >
                        Додати працівника
                      </Button>
                    ) : null}
                    {resource === 'work-shifts' ? (
                      <Button
                        isDisabled={!model.ready()}
                        onPress={(event) =>
                          void model.action(() => options.onWorkShift(null), event.target)
                        }
                      >
                        Відмітити зміну
                      </Button>
                    ) : null}
                  </div>
                  <Results model={model} />
                </section>
              </TabPanel>
            ))}
          </Tabs>
          {s.data && !s.busy ? (
            <nav className="staff-pager" aria-label="Сторінки команди">
              <Button
                data-page="previous"
                isDisabled={disabled || s.data.page <= 1}
                onPress={() => void model.page(s.data!.page - 1)}
              >
                Назад
              </Button>
              <span data-page-status tabIndex={-1} role="status">
                {s.data.page} / {s.data.pages} · записів {s.data.total}
              </span>
              <Button
                data-page="next"
                isDisabled={disabled || s.data.page >= s.data.pages}
                onPress={() => void model.page(s.data!.page + 1)}
              >
                Далі
              </Button>
            </nav>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
