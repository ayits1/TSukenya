import { useState, useRef, useCallback, useEffect } from 'react';
import { Button } from '../../shared/ui/Button';
import { TextField } from '../../shared/ui/TextField';
import { Select } from '../../shared/ui/Select';
import { DatePicker } from '../../shared/ui/DatePicker';
import { DirectoryComboBox } from '../trading/DirectoryComboBox';
import type { DirectoryItem } from '../trading/api';
import { ApiError } from '../../shared/api/client';
import { moneyText, type Pages, type Queries } from '../finance/api';
import type { ReportsModel } from './state';
import { ReportTable } from './Table';
const filters = (store: number | null): Queries['debts'] => ({
  store,
  q: '',
  party: null,
  from: '',
  to: '',
  due_from: '',
  due_to: '',
  status: '',
});
export function CurrentDebts({
  model,
  store,
  epoch,
}: {
  model: ReportsModel;
  store: number | null;
  epoch: number;
}) {
  const [draft, setDraft] = useState(() => filters(store)),
    [selected, setSelected] = useState<DirectoryItem | null>(null),
    [data, setData] = useState<Pages['debts'] | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const abort = useRef<AbortController | null>(null),
    sequence = useRef(0),
    intent = useRef({ query: filters(store), page: 1 }),
    committed = useRef<typeof intent.current | null>(null),
    pager = useRef<HTMLSpanElement>(null),
    retry = useRef<HTMLButtonElement>(null);
  const load = useCallback(
    async (query: Queries['debts'], page = 1, focus = false) => {
      abort.current?.abort();
      const c = new AbortController();
      abort.current = c;
      const token = ++sequence.current;
      intent.current = { query: { ...query }, page };
      const live = () => !c.signal.aborted && token === sequence.current && model.isCurrent(epoch);
      setBusy(true);
      setError('');
      setData(null);
      try {
        const auth = await model.options!.directoryApi.bootstrap(c.signal);
        if (!live()) return;
        const result = await model.finance.read('debts', query, page, c.signal);
        if (!live()) return;
        if (result.policy.role !== auth.role || result.policy.store !== auth.storeId)
          throw new ApiError(403, 'Права на борги змінилися.');
        committed.current = { query: { ...query }, page: result.page };
        setData(result);
      } catch (e) {
        if (!live() || (e instanceof Error && e.name === 'AbortError')) return;
        model.privacy(e);
        if (!model.state.denied)
          setError(e instanceof Error ? e.message : 'Не вдалося прочитати борги.');
      } finally {
        if (live()) {
          setBusy(false);
          if (focus)
            requestAnimationFrame(() => {
              if (live()) (retry.current ?? pager.current)?.focus();
            });
        }
      }
    },
    [model, epoch],
  );
  useEffect(() => {
    let live = true;
    const requests = sequence,
      controller = abort;
    void Promise.resolve().then(() => {
      if (live) void load(filters(store));
    });
    return () => {
      live = false;
      requests.current++;
      controller.current?.abort();
    };
  }, [load, store]);
  const disabled = busy || model.state.busy || model.state.actionBusy || model.state.denied,
    edit = (patch: Partial<typeof draft>) => setDraft((old) => ({ ...old, ...patch }));
  const valid =
    (!draft.from || !draft.to || draft.from <= draft.to) &&
    (!draft.due_from || !draft.due_to || draft.due_from <= draft.due_to);
  return (
    <section
      className="reports-debts"
      aria-label="Поточна заборгованість"
      data-report-current-debts
    >
      <h2>Поточна заборгованість</h2>
      <p className="tk-help">Незалежно від періоду звіту. Історичні борги — у «Залишки на дату».</p>
      <form
        className="reports-filters"
        onSubmit={(event) => {
          event.preventDefault();
          if (!disabled && valid) void load({ ...draft, q: draft.q.trim() }, 1, true);
        }}
      >
        <TextField
          label="Пошук за документом або контрагентом"
          value={draft.q}
          onChange={(q) => edit({ q })}
          isDisabled={disabled}
          maxLength={250}
        />
        <DirectoryComboBox
          api={model.options!.directoryApi}
          type="parties"
          label="Контрагент"
          query={{ purpose: 'filter', ...(store ? { store } : {}) }}
          value={draft.party ? String(draft.party) : ''}
          selected={selected}
          emptyLabel="Усі контрагенти"
          disabled={disabled}
          onCommit={(item) => {
            setSelected(item);
            edit({ party: item ? Number(item.id) : null });
          }}
        />
        <DatePicker
          label="Документи з дати"
          value={draft.from}
          onChange={(from) => edit({ from })}
          isDisabled={disabled}
        />
        <DatePicker
          label="По дату документів"
          value={draft.to}
          onChange={(to) => edit({ to })}
          isDisabled={disabled}
        />
        <DatePicker
          label="Строк оплати з"
          value={draft.due_from}
          onChange={(due_from) => edit({ due_from })}
          isDisabled={disabled}
        />
        <DatePicker
          label="Строк оплати по"
          value={draft.due_to}
          onChange={(due_to) => edit({ due_to })}
          isDisabled={disabled}
        />
        <Select
          label="Стан оплати"
          selectedKey={draft.status || 'all'}
          onSelectionChange={(key) =>
            edit({ status: key === 'overdue' || key === 'not_overdue' ? key : '' })
          }
          options={[
            { id: 'all', label: 'Усі борги' },
            { id: 'overdue', label: 'Прострочені' },
            { id: 'not_overdue', label: 'Без прострочення' },
          ]}
          isDisabled={disabled}
        />
        <div className="reports-actions">
          <Button type="submit" isDisabled={disabled || !valid}>
            Показати борги
          </Button>
          <Button
            isDisabled={disabled}
            onPress={() => {
              setDraft(filters(store));
              setSelected(null);
              void load(filters(store), 1, true);
            }}
          >
            Скинути
          </Button>
        </div>
      </form>
      {!valid ? <p className="tk-error">Початкова дата має бути не пізніше кінцевої.</p> : null}
      <p role="status" aria-live="polite">
        {busy
          ? 'Завантаження боргів…'
          : data
            ? `Борги за застосованими умовами · ${data.total} записів`
            : ''}
      </p>
      {error ? (
        <div>
          <p role="alert" className="tk-error">
            {error}
          </p>
          <Button
            ref={retry}
            onPress={() => void load(intent.current.query, intent.current.page, true)}
          >
            Повторити читання боргів
          </Button>
        </div>
      ) : null}
      {data ? (
        <>
          <div className="reports-cards">
            <div>
              <span>Нам винні · усі знайдені</span>
              <strong>{moneyText(data.totals.owedToUs)} грн</strong>
            </div>
            <div>
              <span>Ми винні · усі знайдені</span>
              <strong>{moneyText(data.totals.owedByUs)} грн</strong>
            </div>
          </div>
          <ReportTable
            label="Поточні борги"
            headers={[
              'Документ',
              'Дата / магазин',
              'Контрагент',
              'Сума боргу',
              'Строк оплати',
              'Дія',
            ]}
            rows={data.items.map((r) => ({
              key: String(r.id),
              cells: [
                <>
                  № {r.number}
                  <span className="tk-help">{r.kind === 'receipt' ? 'Ми винні' : 'Нам винні'}</span>
                </>,
                <>
                  {r.date}
                  <span className="tk-help">{r.storeName}</span>
                </>,
                r.partyName,
                moneyText(r.amount) + ' грн',
                <>
                  {r.dueDate || 'Не задано'}
                  {r.overdue ? <strong className="tk-error">Прострочено</strong> : null}
                </>,
                <Button
                  isDisabled={disabled || !!error}
                  aria-label={'Оплатити борг за документом № ' + r.number}
                  onPress={(event) => void model.payDebt(r.id, event.target)}
                >
                  Оплатити
                </Button>,
              ],
            }))}
          />
          <div className="reports-pager">
            <Button
              isDisabled={disabled || data.page <= 1}
              onPress={() => void load(committed.current!.query, data.page - 1, true)}
            >
              Попередня сторінка боргів
            </Button>
            <span ref={pager} role="status" tabIndex={-1}>
              Сторінка {data.page} з {data.pages} · {data.total} записів
            </span>
            <Button
              isDisabled={disabled || data.page >= data.pages}
              onPress={() => void load(committed.current!.query, data.page + 1, true)}
            >
              Наступна сторінка боргів
            </Button>
          </div>
        </>
      ) : null}
    </section>
  );
}
