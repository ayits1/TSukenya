import { flushSync } from 'react-dom';
import type { CommittedReader } from '../../shared/api/committedReader';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '../../shared/ui/Button';
import { TextField } from '../../shared/ui/TextField';
import { Select } from '../../shared/ui/Select';
import { DatePicker, ukraineToday } from '../../shared/ui/DatePicker';
import { DirectoryComboBox } from '../trading/DirectoryComboBox';
import type { DirectoryItem, TradingApi } from '../trading/api';
import { abcParams, thresholdValue, type ABCApi, type ABCFilters, type ABCReportData } from './api';
import './abc.css';
const labels = { A: 'A', B: 'B', C: 'C', unclassified: 'Без класу' };
export const initialABC = (store = ''): ABCFilters => {
  const date = ukraineToday();
  return {
    from: date.slice(0, 8) + '01',
    to: date,
    store,
    aThreshold: '80',
    bThreshold: '95',
    q: '',
    class: '',
  };
};
export const formatMoney = (value: string) => {
  const negative = value.startsWith('-'),
    [whole, fraction] = value.replace(/^-/, '').split('.');
  return (
    (negative ? '−' : '') + new Intl.NumberFormat('uk-UA').format(BigInt(whole!)) + ',' + fraction
  );
};
type Props = {
  api: ABCApi;
  directories: TradingApi;
  initial?: ABCFilters;
  onFilters?: (filters: ABCFilters) => void;
  onReader?: (reader: CommittedReader | null) => void;
};
export function ABCReport({
  api,
  directories,
  initial = initialABC(),
  onFilters,
  onReader,
}: Props) {
  const [draft, setDraft] = useState(initial),
    [result, setResult] = useState<{ data: ABCReportData; filters: ABCFilters } | null>(null);
  const [locked, setLocked] = useState(false),
    [storeItem, setStoreItem] = useState<DirectoryItem | null>(null);
  const [pending, setPending] = useState(true),
    [ready, setReady] = useState(false),
    [error, setError] = useState('');
  const request = useRef(0),
    controller = useRef<AbortController | null>(null),
    intent = useRef({ filters: initial, page: 1 });
  const confirmed = useRef<typeof result>(null),
    errorHost = useRef<HTMLParagraphElement>(null);
  const onFiltersRef = useRef(onFilters);
  useEffect(() => {
    onFiltersRef.current = onFilters;
  }, [onFilters]);
  const read = useCallback(
    async (filters: ABCFilters, page = 1, signal?: AbortSignal) => {
      controller.current?.abort();
      const abort = new AbortController();
      controller.current = abort;
      const cancel = () => abort.abort();
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) abort.abort();
      const token = ++request.current;
      intent.current = { filters: { ...filters }, page };
      setPending(true);
      setError('');
      if (confirmed.current?.filters.store !== filters.store) setResult(null);
      try {
        const data = await api.read(filters, page, abort.signal);
        if (abort.signal.aborted || token !== request.current) return false;
        const value = { data, filters: { ...filters } };
        confirmed.current = value;
        setResult(value);
        onFiltersRef.current?.(filters);
        return true;
      } catch (caught) {
        if (abort.signal.aborted || token !== request.current) return false;
        const failure = caught as Error & { status?: number; protocol?: boolean };
        if (failure.status === 401) {
          confirmed.current = null;
          setResult(null);
          location.assign('/');
          return;
        }
        const safe =
          failure.status !== 403 &&
          !failure.protocol &&
          confirmed.current?.filters.store === filters.store;
        if (!safe) {
          confirmed.current = null;
          setResult(null);
        }
        setError(failure.message || 'Не вдалося прочитати звіт.');
        requestAnimationFrame(() => {
          if (token === request.current && !abort.signal.aborted) errorHost.current?.focus();
        });
        return false;
      } finally {
        signal?.removeEventListener('abort', cancel);
        if (token === request.current) {
          if (signal) flushSync(() => setPending(false));
          else setPending(false);
        }
      }
    },
    [api],
  );
  const initialize = useCallback(async () => {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const token = ++request.current;
    setPending(true);
    setError('');
    setReady(false);
    try {
      const current = await directories.bootstrap(abort.signal);
      if (token !== request.current || abort.signal.aborted) return;
      if (!['owner', 'manager', 'accountant'].includes(current.role))
        throw Object.assign(Error('ABC-звіт недоступний за чинними правами.'), { status: 403 });
      const filters = {
        ...intent.current.filters,
        store: current.storeId ? String(current.storeId) : intent.current.filters.store,
      };
      let selected: DirectoryItem | null = null;
      if (filters.store) {
        const detail = await directories.details(
          [{ type: 'stores', id: filters.store }],
          { purpose: 'filter' },
          abort.signal,
        );
        if (token !== request.current || abort.signal.aborted) return;
        selected = detail.items[0] || null;
      }
      setLocked(current.storeId !== null);
      setStoreItem(selected);
      setDraft(filters);
      setReady(true);
      if (filters.store && !selected) {
        intent.current = { filters, page: 1 };
        setPending(false);
        setError(
          'Обраний магазин недоступний. Виберіть доступний контекст і натисніть «Показати ABC».',
        );
        return;
      }
      void read(filters);
    } catch (caught) {
      if (token !== request.current || abort.signal.aborted) return;
      const failure = caught as Error & { status?: number };
      if (failure.status === 401) {
        location.assign('/');
        return;
      }
      setError(failure.message);
      setPending(false);
    }
  }, [directories, read]);
  useEffect(() => {
    let active = true;
    const sequence = request,
      abort = controller;
    void Promise.resolve().then(() => {
      if (active) void initialize();
    });
    return () => {
      active = false;
      sequence.current++;
      abort.current?.abort();
    };
  }, [initialize]);
  const update = (key: keyof ABCFilters, value: string) =>
    setDraft((previous) => ({ ...previous, [key]: value }));
  const valid =
    !!draft.from &&
    !!draft.to &&
    draft.from <= draft.to &&
    draft.to <= ukraineToday() &&
    thresholdValue(draft.aThreshold) > 0 &&
    thresholdValue(draft.aThreshold) < thresholdValue(draft.bThreshold) &&
    thresholdValue(draft.bThreshold) < 100;
  const readerState = useRef({ draft, pending, ready });
  useLayoutEffect(() => {
    readerState.current = { draft, pending, ready };
  }, [draft, pending, ready]);
  useEffect(() => {
    if (!onReader) return;
    onReader({
      store: () =>
        confirmed.current?.filters.store ? Number(confirmed.current.filters.store) : null,
      stamp: () => request.current,
      blocked: () =>
        !confirmed.current ||
        !readerState.current.ready ||
        readerState.current.pending ||
        JSON.stringify(readerState.current.draft) !== JSON.stringify(confirmed.current.filters),
      refresh: (signal) => {
        const saved = confirmed.current;
        return saved
          ? read(saved.filters, saved.data.page, signal).then(Boolean)
          : Promise.resolve(false);
      },
    });
    return () => onReader(null);
  }, [onReader, read]);
  const data = result?.data;
  return (
    <section className="tk-abc" aria-label="ABC-аналітика товарів">
      <h2>ABC-аналітика товарів</h2>
      <p className="tk-help">
        Лише проведені в цій системі продажі й повернення. Повноту касових вигрузок звіт не
        перевіряє. Собівартість береться з проведених рядків; повноту історичних закупівель не
        оцінюємо.
      </p>
      <p className="tk-help">
        Класи за чистим виторгом продажів після повернень і сторно. Межі 80% / 95% — початкові
        аналітичні значення; їх можна змінити для цього перегляду.
      </p>
      {ready && !locked && draft.store && !storeItem ? (
        <Button
          isDisabled={pending}
          onPress={() => {
            update('store', '');
            setError('');
          }}
        >
          Очистити недоступний магазин
        </Button>
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!pending && ready && valid) void read({ ...draft, q: draft.q.trim() });
        }}
        aria-busy={pending}
      >
        <div className="tk-abc-filters">
          <DatePicker
            label="З"
            value={draft.from}
            onChange={(value) => update('from', value)}
            maxValue={ukraineToday()}
            isDisabled={pending || !ready}
          />
          <DatePicker
            label="По"
            value={draft.to}
            onChange={(value) => update('to', value)}
            maxValue={ukraineToday()}
            isDisabled={pending || !ready}
          />
          {locked ? (
            <div className="tk-field">
              <span className="tk-label">Магазин</span>
              <p>{storeItem?.name}</p>
            </div>
          ) : (
            <DirectoryComboBox
              api={directories}
              type="stores"
              query={{ purpose: 'filter' }}
              label="Магазин"
              emptyLabel={
                draft.store && !storeItem
                  ? 'Недоступний магазин № ' + draft.store
                  : 'Усі доступні магазини'
              }
              value={draft.store}
              selected={storeItem}
              disabled={pending || !ready}
              onCommit={(item) => {
                setStoreItem(item);
                update('store', item?.id || '');
              }}
            />
          )}
          <TextField
            label="Межа A, %"
            value={draft.aThreshold}
            onChange={(value) => update('aThreshold', value)}
            isDisabled={pending || !ready}
            inputMode="decimal"
          />
          <TextField
            label="Межа B, %"
            value={draft.bThreshold}
            onChange={(value) => update('bThreshold', value)}
            isDisabled={pending || !ready}
            inputMode="decimal"
          />
          <TextField
            label="Пошук товару"
            value={draft.q}
            onChange={(value) => update('q', value)}
            isDisabled={pending || !ready}
            maxLength={250}
          />
          <Select
            label="Клас"
            selectedKey={draft.class || 'all'}
            onSelectionChange={(key) => update('class', key === 'all' ? '' : String(key))}
            options={[
              { id: 'all', label: 'Усі класи' },
              ...Object.entries(labels).map(([id, label]) => ({ id, label })),
            ]}
            isDisabled={pending || !ready}
          />
        </div>
        {!valid && ready ? (
          <p className="tk-error">
            Виберіть коректний період і межі 0 &lt; A &lt; B &lt; 100 (до двох десяткових знаків).
          </p>
        ) : null}
        <Button type="submit" variant="primary" isDisabled={pending || !ready || !valid}>
          Показати ABC
        </Button>
      </form>
      <p role="status">
        {pending
          ? 'Обчислення ABC-звіту…'
          : error && data
            ? 'Показано попередній підтверджений звіт нижче. Нові умови не застосовано. CSV вимкнено до успішного читання.'
            : data
              ? 'Підсумки охоплюють усі товари контексту; пошук і клас фільтрують лише список.'
              : ''}
      </p>
      {error ? (
        <>
          <p role="alert" tabIndex={-1} ref={errorHost} className="tk-error">
            {error}
          </p>
          <Button
            onPress={() =>
              ready ? void read(intent.current.filters, intent.current.page) : void initialize()
            }
            isDisabled={pending}
          >
            Повторити читання ABC
          </Button>
        </>
      ) : null}
      {data ? (
        <>
          <div className="tk-abc-confirmed">
            <strong>Підтверджений контекст: {data.scopeName}</strong>
            <p>
              {data.from} — {data.to} · Межі A {data.aThreshold}% / B {data.bThreshold}% ·{' '}
              {data.generatedAt}
            </p>
            <p>{data.snapshotNotice}</p>
          </div>
          <dl className="tk-abc-summary">
            <div>
              <dt>Чистий виторг усіх SKU</dt>
              <dd>{formatMoney(data.summary.netRevenue)} грн</dd>
            </div>
            <div>
              <dt>Позитивний пул для ABC</dt>
              <dd>{formatMoney(data.summary.positivePoolRevenue)} грн</dd>
            </div>
            <div>
              <dt>Валовий прибуток</dt>
              <dd>{formatMoney(data.summary.grossProfit)} грн</dd>
            </div>
          </dl>
          <p className="tk-help">
            Покриття: {data.summary.positiveCount} з {data.summary.productCount} товарів
            класифіковано; нульовий виторг — {data.summary.zeroCount}, від’ємний —{' '}
            {data.summary.negativeCount} ({formatMoney(data.summary.negativeRevenue)} грн).
            Прихованих зараз — {data.summary.hiddenCount}; різні історичні одиниці —{' '}
            {data.summary.mixedUnitCount}.
          </p>
          {data.summary.positiveCount === 0 ? (
            <p>Позитивного чистого виторгу немає. ABC-класи не визначено.</p>
          ) : null}
          <ul className="tk-abc-classes">
            {Object.entries(data.summary.classes).map(([label, c]) => (
              <li key={label}>
                <strong>{labels[label as keyof typeof labels]}</strong>
                <span>
                  {c.count} товарів · {formatMoney(c.netRevenue)} грн ·{' '}
                  {c.share === null ? '—' : c.share.replace('.', ',') + '%'}
                </span>
              </li>
            ))}
          </ul>
          <p className="tk-help">
            Рівні виторги залишаються в одному класі за накопиченням до групи. A може перевищити
            межу. Назви — з першого рядка проведення, прихованість — поточна. Кількість із різними
            одиницями не складаємо.
          </p>
          {!pending && !error ? (
            <a
              className="tk-button tk-abc-export"
              href={'/api/v1/trading/reports/abc/export.csv?' + abcParams(result!.filters)}
              download
            >
              CSV усієї вибірки
            </a>
          ) : (
            <span className="tk-help">CSV недоступний під час читання або помилки.</span>
          )}
          <p>
            {data.q ? 'Пошук: ' + data.q + '. ' : ''}
            {data.class ? 'Клас: ' + labels[data.class] + '. ' : ''}Знайдено: {data.total}.
          </p>
          <div className="tk-abc-rows">
            {data.items.map((row) => (
              <article key={row.product} className="tk-abc-row">
                <header>
                  <strong>{row.name}</strong>
                  <span className="tk-abc-badge">{labels[row.classification]}</span>
                </header>
                <p className="tk-help">
                  {row.product}
                  {row.hiddenCurrent ? ' · прихований зараз' : ''}
                </p>
                <dl>
                  <div>
                    <dt>Чистий виторг</dt>
                    <dd>{formatMoney(row.netRevenue)} грн</dd>
                  </div>
                  <div>
                    <dt>Частка пулу</dt>
                    <dd>{row.share === null ? '—' : row.share.replace('.', ',') + '%'}</dd>
                  </div>
                  <div>
                    <dt>Чиста кількість</dt>
                    <dd>
                      {row.unitConflicted
                        ? 'Різні одиниці — без підсумку'
                        : row.quantity?.replace('.', ',') +
                          ' ' +
                          (row.unit || 'одиницю не вказано')}
                    </dd>
                  </div>
                </dl>
                <details>
                  <summary>Розрахунок і накопичення</summary>
                  <p>
                    Собівартість {formatMoney(row.netCogs)} грн · Валовий прибуток{' '}
                    {formatMoney(row.grossProfit)} грн
                  </p>
                  <p>
                    Група рівного виторгу:{' '}
                    {row.cumulativeBefore === null
                      ? '—'
                      : row.cumulativeBefore + '% → ' + row.cumulativeAfter + '%'}
                  </p>
                </details>
              </article>
            ))}
          </div>
          {!data.items.length ? <p>За цими умовами товарів немає.</p> : null}
          <nav aria-label="Сторінки ABC" className="tk-abc-pager">
            <Button
              isDisabled={pending || !!error || data.page <= 1}
              onPress={() => void read(result!.filters, data.page - 1)}
            >
              Попередня
            </Button>
            <span>
              Сторінка {data.page} з {data.pages}
            </span>
            <Button
              isDisabled={pending || !!error || data.page >= data.pages}
              onPress={() => void read(result!.filters, data.page + 1)}
            >
              Далі
            </Button>
          </nav>
        </>
      ) : null}
    </section>
  );
}
