import { useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { Tabs, TabList, Tab, TabPanel } from 'react-aria-components';
import type { components } from '../../shared/api/documentDetails.generated';
import { Button } from '../../shared/ui/Button';
import { Select } from '../../shared/ui/Select';
import { DocumentModel } from './state';
import { decimalText, titles, positive, type Header, type Page, type Section } from './api';
import './document-details.css';
const money = (v: string | null) => (v === null ? '—' : decimalText(v) + ' грн');
const states = {
  draft: 'Чернетка',
  posted: 'Проведено',
  reversed: 'Скасовано',
  approved: 'Погоджено',
  partial: 'Частково виконано',
  fulfilled: 'Виконано',
  closed: 'Закрито',
  cancelled: 'Скасовано',
};
function DetailHeader({ data, onAction }: { data: Header; onAction: (target: Element) => void }) {
  const d = data.document,
    fields: [string, ReactNode][] = [
      ['Документ', '№ ' + d.number],
      ['Дата', d.date],
      ['Стан', states[d.status]],
      ['Магазин', d.store.name],
      ['Склад', d.warehouse?.name ?? '—'],
      ['Контрагент', d.party?.name ?? '—'],
      ['Працівник', d.employee?.name ?? '—'],
      ['Сума', money(d.total)],
    ];
  if (d.cost !== null) fields.push(['Собівартість руху', money(d.cost)]);
  if (d.outstanding !== null) fields.push(['Залишок боргу', money(d.outstanding)]);
  if (d.unallocated !== null) fields.push(['Невикористаний аванс', money(d.unallocated)]);
  return (
    <>
      <dl className="document-detail-facts">
        {fields.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {d.note && <p>{d.note}</p>}
      {d.reference && (
        <p>
          Пов’язаний документ{' '}
          {d.kind === 'payment' ? (
            <>№ {d.reference}</>
          ) : (
            <Button
              onPress={(event) => onAction(event.target)}
              data-document-native-action
              data-trade="view"
              data-id={d.reference}
            >
              № {d.reference}
            </Button>
          )}
        </p>
      )}
      {d.fiscalRef && <p>Чек ПРРО: {d.fiscalRef}</p>}
      {d.expenseScope && (
        <p>
          Належність витрати: {d.expenseScope === 'network' ? 'мережева, без розподілу' : 'магазин'}
          . Рахунок оплати належить магазину документа.
        </p>
      )}
      {d.order && (
        <p data-order-panel>
          Стан замовлення: <strong>{states[d.order.state]}</strong>
          {d.order.expectedDate && ` · очікувана поставка ${d.order.expectedDate}`}
          {d.order.minimumAmount !== null &&
            ` · мінімум постачальника ${money(d.order.minimumAmount)}`}
        </p>
      )}
      {d.production && (
        <section aria-label="Виробництво">
          <h3>Виробництво</h3>
          <dl className="document-detail-facts">
            {Object.entries({
              Рецептура:
                d.production.source === 'version'
                  ? `Версія № ${d.production.version}`
                  : 'Знімок документа',
              'Норма виходу': d.production.outputQuantity,
              'Плановий вихід': d.production.plannedOutput,
              'Фактичний вихід': d.production.actualOutput,
              Втрати: d.production.lossQuantity,
              Перевитрата: d.production.overrunQuantity,
              'Вартість сировини':
                d.production.materialCost === null ? null : money(d.production.materialCost),
              'Придатний до': d.production.expiry,
              'Джерело терміну': d.production.expirySource,
              'Причина відхилення': d.production.varianceReason,
              'Причина ручного терміну': d.production.expiryReason,
              Погодив: d.production.expiryApprovedBy,
            })
              .filter(([, v]) => v !== null)
              .map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
          </dl>
        </section>
      )}
    </>
  );
}
function Rows({ data, onAction }: { data: Page; onAction: (target: Element) => void }) {
  type S = components['schemas'];
  let columns: string[], rows: { id: number; cells: ReactNode[] }[];
  const items = data.page.items;
  switch (data.page.section) {
    case 'lines':
      columns = [
        'Товар',
        'Партія / придатний до',
        'Кількість',
        'Ціна',
        'Сума',
        ...(data.document.cost === null ? [] : ['Собівартість']),
      ];
      rows = (items as S['Line'][]).map((r) => ({
        id: r.id,
        cells: [
          r.name,
          <>
            {r.lot || '—'}
            {r.originKnown === false ? ' · походження не встановлено' : ''}
            {r.expiry ? ' / ' + r.expiry : ''}
            {r.referenceLine ? ' · вихідний рядок № ' + r.referenceLine : ''}
          </>,
          decimalText(r.quantity) + ' ' + r.unit,
          money(r.price),
          money(r.amount),
          ...(data.document.cost === null ? [] : [money(r.cost)]),
        ],
      }));
      break;
    case 'stock_movements':
      columns = [
        'Склад',
        'Партія',
        'Кількість',
        ...(data.document.cost === null ? [] : ['Вартість']),
        'Операція',
      ];
      rows = (items as S['StockMovement'][]).map((r) => ({
        id: r.id,
        cells: [
          r.warehouse.name,
          r.lot || '—',
          decimalText(r.quantity),
          ...(data.document.cost === null ? [] : [money(r.value)]),
          r.reversal ? 'Скасування' : 'Проведення',
        ],
      }));
      break;
    case 'cash_movements':
      columns = ['Рахунок', 'Сума', 'Операція'];
      rows = (items as S['CashMovement'][]).map((r) => ({
        id: r.id,
        cells: [r.account.name, money(r.amount), r.reversal ? 'Скасування' : 'Проведення'],
      }));
      break;
    case 'allocations':
      columns = ['Документ', 'Сума'];
      rows = (items as S['Allocation'][]).map((r) => ({
        id: r.id,
        cells: [
          <Button
            onPress={(event) => onAction(event.target)}
            data-document-native-action
            data-trade="view"
            data-id={r.source}
          >
            № {r.number}
          </Button>,
          money(r.amount),
        ],
      }));
      break;
    case 'payroll_calculation':
      columns = ['Зміна', 'Ставка × зміни', 'Відсоток', 'Виторг для %', 'Нараховано'];
      rows = (items as S['PayrollCalculation'][]).map((r) => ({
        id: r.id,
        cells: [
          <>
            {r.date}
            <small>
              Табель № {r.workShift}
              {r.cashShift ? ' · Касова зміна № ' + r.cashShift : ''}
            </small>
          </>,
          <>
            {money(r.baseAmount)}
            <small>
              {decimalText(r.rate)} × {decimalText(r.units)}
            </small>
          </>,
          decimalText(r.percent) + ' %',
          money(r.basisAmount),
          money(r.accrued),
        ],
      }));
      break;
    case 'production_components':
      columns = ['Сировина', 'План', 'Факт', 'Партія'];
      rows = (items as S['ProductionComponent'][]).map((r) => ({
        id: r.id,
        cells: [
          r.name,
          decimalText(r.expectedQuantity) + ' ' + r.unit,
          decimalText(r.quantity) + ' ' + r.unit,
          r.lot || 'FEFO',
        ],
      }));
      break;
    case 'order_lines':
      columns = ['Товар', 'Замовлено', 'Виконано', 'Залишилось', 'Зарезервовано'];
      rows = (items as S['OrderLine'][]).map((r) => ({
        id: r.id,
        cells: [
          r.name,
          decimalText(r.quantity) + ' ' + r.unit,
          decimalText(r.fulfilled),
          decimalText(r.remaining),
          decimalText(r.reserved),
        ],
      }));
      break;
    case 'reservations':
      columns = ['Товар / партія', 'Строк', 'Кількість', 'Використано', 'Звільнено', 'Стан / дія'];
      rows = (items as S['Reservation'][]).map((r) => ({
        id: r.id,
        cells: [
          <>
            {r.name}
            <small>
              {r.code || 'Без коду'}
              {r.lotExpiry ? ' · придатний до ' + r.lotExpiry : ''}
            </small>
          </>,
          <>
            {r.expiresOn}
            <small>Створив: {r.owner}</small>
          </>,
          decimalText(r.quantity),
          decimalText(r.used),
          decimalText(r.released),
          <>
            {r.active ? 'Чинний' : 'Завершений'}
            {data.document.actions.includes('order_expire') &&
              positive(difference(r.quantity, r.used, r.released)) && (
                <Button
                  onPress={(event) => onAction(event.target)}
                  data-document-native-action
                  data-trade="order-release"
                  data-id={data.document.id}
                  data-order-revision={data.document.order!.revision}
                  data-reservation={r.id}
                >
                  Звільнити
                </Button>
              )}
          </>,
        ],
      }));
      break;
  }
  return rows.length ? (
    <table className="document-detail-table">
      <caption className="tk-sr-only">{titles[data.page.section]}</caption>
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c} scope="col">
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} data-document-row={r.id}>
            {r.cells.map((cell, i) => (
              <td key={columns[i]} data-label={columns[i]}>
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  ) : (
    <p>У цій секції немає записів.</p>
  );
}
// Visibility only: PostgreSQL rechecks authority and quantities on every action.
function difference(...values: string[]) {
  const scaled = (v: string) => {
    const [a = '', b = ''] = v.split('.');
    return BigInt(a) * 1000n + BigInt(b.padEnd(3, '0'));
  };
  return String(scaled(values[0]!) - scaled(values[1]!) - scaled(values[2]!));
}
export function DocumentDetails({
  model,
  initial,
  portalContainer,
}: {
  model: DocumentModel;
  initial: Header;
  portalContainer?: Element;
}) {
  const state = useSyncExternalStore(model.subscribe, model.snapshot),
    host = useRef<HTMLDivElement>(null),
    focus = useRef(false);
  useLayoutEffect(() => {
    if (focus.current && !state.busy) {
      focus.current = false;
      host.current
        ?.querySelector<HTMLElement>(
          state.error ? '[data-document-retry]' : '[data-document-page-status]',
        )
        ?.focus();
    }
  }, [state.busy, state.error]);
  const data = state.data,
    sections = data?.sections ?? initial.sections;
  return (
    <div className="document-details" ref={host} data-document-details aria-busy={state.busy}>
      {data && <DetailHeader data={data} onAction={model.nativeAction} />}
      <Tabs
        selectedKey={state.section}
        onSelectionChange={(k) => {
          focus.current = true;
          void model.select(k as Section);
        }}
      >
        <TabList aria-label="Секції документа" className="document-detail-tabs">
          {sections.map((s) => (
            <Tab key={s.key} id={s.key} isDisabled={state.busy || state.denied}>
              {titles[s.key]} · {s.total}
            </Tab>
          ))}
        </TabList>
        <TabPanel key={state.section} id={state.section}>
          <div className="document-detail-toolbar">
            <Select
              label="Записів на сторінці"
              options={[
                { id: '10', label: '10' },
                { id: '30', label: '30' },
              ]}
              selectedKey={String(state.limit)}
              isDisabled={state.busy || state.denied}
              onSelectionChange={(k) => {
                focus.current = true;
                void model.size(k === '10' ? 10 : 30);
              }}
              {...(portalContainer ? { portalContainer } : {})}
            />
            <Button
              isDisabled={state.busy || state.denied}
              onPress={() => {
                focus.current = true;
                void model.read();
              }}
            >
              Оновити документ
            </Button>
          </div>
          {state.busy && <p role="status">Читаємо документ…</p>}
          {state.error && (
            <>
              <p role="alert">{state.error}</p>
              {!state.denied && (
                <Button
                  data-document-retry
                  onPress={() => {
                    focus.current = true;
                    void model.read();
                  }}
                >
                  Повторити читання
                </Button>
              )}
            </>
          )}
          {data && (
            <>
              <Rows data={data} onAction={model.nativeAction} />
              <nav className="document-detail-pager" aria-label="Сторінки секції">
                <Button
                  isDisabled={data.page.page === 1}
                  onPress={() => {
                    focus.current = true;
                    void model.page(data.page.page - 1);
                  }}
                >
                  Назад
                </Button>
                <span role="status" tabIndex={-1} data-document-page-status>
                  {data.page.page} / {data.page.pages} · записів {data.page.total}
                </span>
                <Button
                  isDisabled={data.page.page === data.page.pages}
                  onPress={() => {
                    focus.current = true;
                    void model.page(data.page.page + 1);
                  }}
                >
                  Далі
                </Button>
              </nav>
            </>
          )}
        </TabPanel>
      </Tabs>
    </div>
  );
}
