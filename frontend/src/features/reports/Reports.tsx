import { useSyncExternalStore, useRef, useLayoutEffect, type ReactNode } from 'react';
import { Tabs, TabList, Tab, TabPanel } from 'react-aria-components';
import { Button } from '../../shared/ui/Button';
import { TextField } from '../../shared/ui/TextField';
import { DatePicker, ukraineToday } from '../../shared/ui/DatePicker';
import { DirectoryComboBox } from '../trading/DirectoryComboBox';
import { ABCReport } from '../abc/ABCReport';
import { ReportsModel } from './state';
import {
  moneyText,
  sections,
  titles,
  labels,
  moneyKeys,
  exportURL,
  type Page,
  type Section,
  type Summary,
  type SourceQuery,
} from './api';
import { ReportTable } from './Table';
import { CurrentDebts } from './CurrentDebts';
import './reports.css';
function Source({
  model,
  label,
  metric,
  value,
  id,
}: {
  model: ReportsModel;
  label: string;
  metric: SourceQuery['metric'];
  value: string;
  id?: number;
}) {
  return (
    <Button
      isDisabled={!model.ready()}
      data-report-source
      data-metric={metric}
      onPress={(event) => void model.sources(metric, value, id, event.target)}
    >
      {label}
    </Button>
  );
}
function Rows({ data, model }: { data: Page; model: ReportsModel }) {
  let headers: string[], rows: { key: string; cells: ReactNode[] }[];
  switch (data.section) {
    case 'products':
      headers = [
        'Товар',
        'Кількість',
        'Виторг',
        'Валовий прибуток',
        'Маржа',
        'Результат',
        'Складові',
      ];
      rows = data.items.map((r) => ({
        key: r.product,
        cells: [
          r.name,
          r.quantity.replace('.', ',') + ' ' + r.unit,
          moneyText(r.revenue),
          moneyText(r.gross_profit),
          r.margin === null ? '—' : r.margin.replace('.', ',') + '%',
          moneyText(r.result),
          <details className="reports-breakdown">
            <summary>Собівартість і коригування</summary>
            <dl>
              <dt>Собівартість продажів</dt>
              <dd>{moneyText(r.cogs)} грн</dd>
              <dt>Списано</dt>
              <dd>
                {r.writeoff_quantity.replace('.', ',')} {r.unit} · {moneyText(r.writeoff)} грн
              </dd>
              <dt>Інвентаризаційне коригування</dt>
              <dd>{moneyText(r.inventory)} грн</dd>
            </dl>
          </details>,
        ],
      }));
      break;
    case 'by_store':
      headers = ['Магазин', 'Виторг', 'Результат', 'Складові'];
      rows = data.items.map((r) => ({
        key: String(r.store),
        cells: [
          r.name,
          moneyText(r.revenue),
          moneyText(r.profit),
          <details className="reports-breakdown">
            <summary>Розрахунок результату</summary>
            <dl>
              {moneyKeys
                .filter((k) => k !== 'unallocated_expenses')
                .map((k) => (
                  <div key={k}>
                    <dt>{labels[k]}</dt>
                    <dd>{moneyText(r[k as Exclude<typeof k, 'unallocated_expenses'>])} грн</dd>
                  </div>
                ))}
            </dl>
          </details>,
        ],
      }));
      break;
    case 'expenses_by_category':
      headers = ['Стаття', 'Належність', 'Сума'];
      rows = data.items.map((r) => ({
        key: JSON.stringify([r.store, r.category]),
        cells: [
          r.category,
          r.scope === 'network'
            ? 'Мережева — без розподілу'
            : r.store_name || 'Магазин № ' + r.store,
          moneyText(r.amount),
        ],
      }));
      break;
    case 'cashiers':
      headers = [
        'Касир',
        'Змін / годин',
        'З розходженням',
        'Виторг',
        'На годину',
        'Нестача',
        'Надлишок',
        'Разом',
        ...(data.summary.can_view_payroll ? ['Бонус пізніх повернень'] : []),
      ];
      rows = data.items.map((r) => ({
        key: JSON.stringify([r.employee, r.employee === null ? r.name : null]),
        cells: [
          r.name,
          `${r.shifts} / ${r.hours.replace('.', ',')}`,
          r.with_difference,
          moneyText(r.revenue),
          r.revenue_per_hour === null ? '—' : moneyText(r.revenue_per_hour),
          moneyText(r.shortage),
          moneyText(r.surplus),
          moneyText(r.net),
          ...(data.summary.can_view_payroll ? [moneyText(r.late_return_bonus!)] : []),
        ],
      }));
      break;
    case 'stock':
      headers = ['Товар', 'Склад / партія', 'Кількість', 'Вартість', 'Термін', 'Джерела'];
      rows = data.items.map((r) => ({
        key: String(r.lot),
        cells: [
          r.name,
          <>
            {r.warehouse_name}
            <span className="tk-help">{r.code}</span>
          </>,
          r.quantity.replace('.', ',') + ' ' + r.unit,
          moneyText(r.value),
          r.expiry ? (
            <span className={r.expired ? 'tk-error' : ''}>{r.expiry}</span>
          ) : (
            'Без терміну'
          ),
          <Source model={model} label="Рухи партії" metric="stock" value={r.value} id={r.lot} />,
        ],
      }));
      break;
    case 'cash':
      headers = ['Рахунок', 'Тип', 'Залишок', 'Джерела'];
      rows = data.items.map((r) => ({
        key: String(r.account),
        cells: [
          r.name,
          ({ cash: 'Готівка', bank: 'Банк', terminal: 'Термінал' } as Record<string, string>)[
            r.kind
          ],
          moneyText(r.amount),
          <Source
            model={model}
            label="Рухи рахунку"
            metric="cash"
            value={r.amount}
            id={r.account}
          />,
        ],
      }));
      break;
    case 'debts':
      headers = ['Документ / дата', 'Контрагент', 'Напрям', 'Борг', 'Строк'];
      rows = data.items.map((r) => ({
        key: String(r.voucher),
        cells: [
          <>
            {r.number}
            <span className="tk-help">{r.date}</span>
          </>,
          r.party,
          r.kind === 'sale' ? 'Нам винні' : 'Ми винні',
          moneyText(r.amount),
          <span className={r.overdue ? 'tk-error' : ''}>{r.due_date || 'Не задано'}</span>,
        ],
      }));
      break;
    case 'advances':
      headers = ['Платіж / дата', 'Контрагент', 'Напрям', 'Аванс'];
      rows = data.items.map((r) => ({
        key: String(r.payment),
        cells: [
          <>
            {r.number}
            <span className="tk-help">{r.date}</span>
          </>,
          r.party,
          r.direction === 'customer' ? 'Клієнтський' : 'Постачальнику',
          moneyText(r.amount),
        ],
      }));
      break;
    case 'payroll_debts':
      headers = ['Працівник', 'Борг із зарплати'];
      rows = data.items.map((r) => ({
        key: String(r.employee),
        cells: [r.name, moneyText(r.amount)],
      }));
      break;
  }
  return <ReportTable label={titles[data.section]} headers={headers} rows={rows} />;
}
function Cards({ value }: { value: Summary }) {
  const pairs =
    value.mode === 'period'
      ? (
          ['revenue', 'cogs', 'gross_profit', 'profit', 'expenses', 'payroll', 'cash_net'] as const
        ).map((k) => [labels[k], value[k]])
      : [
          ['Товар на дату', value.stock_value],
          ['Кошти на дату', value.cash_total],
          ['Нам винні', value.debt_totals.owed_to_us],
          ['Ми винні', value.debt_totals.owed_by_us],
          ['Аванси клієнтів', value.advance_totals.customer],
          ['Аванси постачальникам', value.advance_totals.supplier],
        ];
  return (
    <div className="reports-cards">
      {pairs.map(([label, money]) => (
        <div key={label}>
          <span>{label}</span>
          <strong>{moneyText(money!)} грн</strong>
        </div>
      ))}
    </div>
  );
}
export function Reports({ model }: { model: ReportsModel }) {
  const s = useSyncExternalStore(model.subscribe, model.snapshot),
    retry = useRef<HTMLButtonElement>(null),
    pager = useRef<HTMLSpanElement>(null),
    previousFocus = useRef(0),
    options = model.options;
  useLayoutEffect(() => {
    if (s.focus !== previousFocus.current && !s.busy) {
      previousFocus.current = s.focus;
      (s.error ? retry.current : pager.current)?.focus();
    }
  }, [s.focus, s.busy, s.error]);
  if (!options) return null;
  const data = s.data,
    summary = data?.summary,
    query = s.committed,
    blocked = s.busy || s.actionBusy || s.denied,
    valid =
      s.view === 'balances'
        ? !!s.draft.as_of && s.draft.as_of <= ukraineToday()
        : !!s.draft.from &&
          !!s.draft.to &&
          s.draft.from <= s.draft.to &&
          s.draft.to <= ukraineToday();
  const csv = (section: Section | 'summary' | 'all', q = '') =>
    model.ready() && query ? exportURL(query, section, q) : undefined;
  return (
    <section className="reports-workspace" aria-label="Фінансові звіти" data-react-reports>
      <Tabs selectedKey={s.view} onSelectionChange={(key) => void model.mode(key as typeof s.view)}>
        <TabList aria-label="Режим фінансового звіту" className="reports-tabs">
          {[
            ['period', 'Обороти періоду'],
            ['balances', 'Залишки на дату'],
            ['abc', 'ABC товарів'],
          ].map(([key, label]) => (
            <Tab
              id={key!}
              key={key}
              className="reports-tab"
              isDisabled={s.denied}
              data-report-mode={key}
            >
              {label}
            </Tab>
          ))}
        </TabList>
        {s.denied ? (
          <p role="alert" className="tk-error">
            {s.error}
          </p>
        ) : s.view === 'abc' ? (
          <TabPanel id="abc" key="abc">
            <ABCReport
              api={model.abc}
              directories={options.directoryApi}
              initial={{
                ...s.abc,
                store: s.draft.store ? String(s.draft.store) : '',
                from: s.draft.from,
                to: s.draft.to,
              }}
              onFilters={(v) => model.abcFilters(v)}
            />
          </TabPanel>
        ) : (
          <TabPanel id={s.view} key={s.view}>
            <form
              className="reports-filters"
              aria-busy={s.busy}
              data-report-form
              onSubmit={(event) => {
                event.preventDefault();
                if (!blocked && valid) void model.apply();
              }}
            >
              {s.view === 'balances' ? (
                <DatePicker
                  label="Станом на дату включно"
                  value={s.draft.as_of}
                  onChange={(as_of) => model.edit({ as_of })}
                  maxValue={ukraineToday()}
                  isDisabled={blocked}
                />
              ) : (
                <>
                  <DatePicker
                    label="З"
                    value={s.draft.from}
                    onChange={(from) => model.edit({ from })}
                    maxValue={ukraineToday()}
                    isDisabled={blocked}
                  />
                  <DatePicker
                    label="По"
                    value={s.draft.to}
                    onChange={(to) => model.edit({ to })}
                    maxValue={ukraineToday()}
                    isDisabled={blocked}
                  />
                </>
              )}
              <DirectoryComboBox
                api={options.directoryApi}
                type="stores"
                query={{ purpose: 'filter' }}
                label="Магазин"
                value={s.draft.store ? String(s.draft.store) : ''}
                selected={s.selectedStore}
                disabled={blocked || options.bootstrap.storeId !== null}
                emptyLabel={
                  s.draft.store ? 'Недоступний магазин № ' + s.draft.store : 'Усі доступні магазини'
                }
                onCommit={(item) => model.store(item)}
              />
              <Button type="submit" variant="primary" isDisabled={blocked || !valid}>
                Показати
              </Button>
            </form>
            {!valid ? (
              <p className="tk-error">Виберіть коректний період не пізніше сьогодні.</p>
            ) : null}
            <p role="status" aria-live="polite" data-report-status>
              {s.busy
                ? 'Обчислення звіту…'
                : s.stale
                  ? 'Показано попередній підтверджений звіт за датами у підсумках. Нові умови не застосовано. CSV і джерела вимкнено до успішного читання.'
                  : data
                    ? 'Підсумки охоплюють увесь контекст; таблиця — одну сторінку.'
                    : ''}
            </p>
            {s.error ? (
              <div>
                <p className="tk-error" role="alert" data-report-error>
                  {s.error}
                </p>
                <Button
                  ref={retry}
                  data-report-retry
                  isDisabled={s.busy}
                  onPress={() => void model.retry()}
                >
                  Повторити читання
                </Button>
              </div>
            ) : null}
            {summary && query ? (
              <>
                <div data-report-summary>
                  <Cards value={summary} />
                  <p className="tk-help">
                    {summary.scope_name} ·{' '}
                    {summary.mode === 'balances'
                      ? 'Стан на кінець ' + summary.as_of
                      : summary.from + ' — ' + summary.to}
                    . За обліковими датами; сторно — київською датою скасування. Назви — чинні.
                  </p>
                  <p className="tk-help">
                    {summary.snapshot_notice} Читання: {summary.generated_at}.
                  </p>
                  {summary.mode === 'period' ? (
                    <>
                      <p className="tk-help">
                        Закупівля створює запаси; собівартість потрапляє у результат під час
                        продажу. Кредитний продаж входить у виторг, оплата — у рух коштів. Результат
                        управлінський, до податків.
                      </p>
                      <p className="tk-help">
                        Мережеві нерозподілені витрати: {moneyText(summary.unallocated_expenses)}{' '}
                        грн. Сума результатів магазинів мінус ця сума дорівнює результату мережі.
                      </p>
                      <details className="reports-breakdown trade-report-source-actions">
                        <summary>Розшифрувати показники</summary>
                        <div className="reports-actions">
                          {moneyKeys.map((k) => (
                            <Source
                              key={k}
                              model={model}
                              label={labels[k]}
                              metric={k}
                              value={summary[k]}
                            />
                          ))}
                        </div>
                      </details>
                    </>
                  ) : null}
                  <a
                    className="tk-button tk-button--secondary"
                    data-report-export
                    href={csv(summary.mode === 'balances' ? 'all' : 'summary')}
                    aria-disabled={!model.ready()}
                    tabIndex={model.ready() ? 0 : -1}
                    download
                  >
                    {summary.mode === 'balances' ? 'CSV усіх залишків' : 'CSV підсумків'}
                  </a>
                </div>
                <Tabs
                  selectedKey={s.section}
                  onSelectionChange={(key) => void model.section(key as Section)}
                >
                  <TabList aria-label="Секції звіту" className="reports-tabs">
                    {sections[summary.mode]
                      .filter((key) => key !== 'payroll_debts' || summary.can_view_payroll)
                      .map((key) => (
                        <Tab
                          id={key}
                          key={key}
                          className="reports-tab"
                          data-report-section={key}
                          isDisabled={s.busy}
                        >
                          {titles[key]} · {(summary.counts as Record<string, number>)[key]}
                        </Tab>
                      ))}
                  </TabList>
                  <TabPanel id={s.section} key={s.section}>
                    <form
                      className="reports-search"
                      data-report-search
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (!blocked) void model.search();
                      }}
                    >
                      <TextField
                        label="Пошук у секції"
                        value={s.q}
                        onChange={(q) => model.searchText(q)}
                        maxLength={250}
                        isDisabled={blocked}
                      />
                      <Button type="submit" isDisabled={blocked}>
                        Знайти
                      </Button>
                      <a
                        className="tk-button tk-button--secondary"
                        data-report-export
                        href={csv(s.section, query.q)}
                        aria-disabled={!model.ready()}
                        tabIndex={model.ready() ? 0 : -1}
                        download
                      >
                        CSV усієї секції
                      </a>
                    </form>
                    {s.section === 'cashiers' ? (
                      <p className="tk-help">
                        Оперативна статистика чинних проведених документів закритих за період змін.
                        На годину — лише для змін від 6 хв.{' '}
                        {summary.can_view_payroll
                          ? 'Бонус пізніх повернень уже нарахований і остаточний; попередні повернення споживають ту саму базу. Рядок із 0 змін може стосуватися повернення старої зміни.'
                          : ''}
                      </p>
                    ) : null}
                    <p className="tk-help">
                      Результати: {query.q || 'без пошуку'}.{' '}
                      {s.q.trim() !== query.q ? 'Новий пошук застосуйте кнопкою «Знайти».' : ''}
                    </p>
                    <Rows data={data!} model={model} />
                    <div className="reports-pager" data-report-pager>
                      <Button
                        data-report-page="previous"
                        isDisabled={!model.ready() || data!.page === 1}
                        onPress={() => void model.page(data!.page - 1)}
                      >
                        Попередня
                      </Button>
                      <span ref={pager} role="status" tabIndex={-1}>
                        Сторінка {data!.page} із {data!.pages} · {data!.total} рядків
                      </span>
                      <Button
                        data-report-page="next"
                        isDisabled={!model.ready() || data!.page === data!.pages}
                        onPress={() => void model.page(data!.page + 1)}
                      >
                        Наступна
                      </Button>
                    </div>
                  </TabPanel>
                </Tabs>
              </>
            ) : null}
            {data && s.view === 'period' && query ? (
              <CurrentDebts
                key={s.epoch + '-' + s.refresh}
                model={model}
                store={query.store}
                epoch={s.epoch}
              />
            ) : null}
          </TabPanel>
        )}
      </Tabs>
    </section>
  );
}
