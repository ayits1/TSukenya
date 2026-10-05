import { flushSync } from 'react-dom';
import type { CommittedReader } from '../../../shared/api/committedReader';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '../../../shared/ui/Button';
import { TextField } from '../../../shared/ui/TextField';
import { Select } from '../../../shared/ui/Select';
import { DirectoryComboBox } from '../../trading/DirectoryComboBox';
import type { TradingApi, TradingBootstrap } from '../../trading/api';
import { openTask } from './TaskEditor';
import * as api from './api';
export function TaskSection({
  customer,
  store,
  bootstrap,
  directoryApi,
  read,
  onDenied,
  onReader,
}: {
  customer: number | null;
  store: number | null;
  bootstrap: TradingBootstrap;
  directoryApi: TradingApi;
  read: (path: string, signal: AbortSignal) => Promise<unknown>;
  onDenied: () => void;
  onReader: (reader: CommittedReader | null) => void;
}) {
  const empty = {
    q: '',
    status: '',
    archived: 'no',
    assignee: '',
    dueFrom: '',
    dueTo: '',
    overdue: '',
  };
  const [raw, setRaw] = useState(empty),
    [filter, setFilter] = useState(empty),
    [page, setPage] = useState(1),
    [value, setValue] = useState<api.TaskPage | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [customerChoice, setCustomerChoice] = useState<
      import('../../trading/api').DirectoryItem | null
    >(null),
    [history, setHistory] = useState<{
      items: { key: string; at: string; actor: string; action: string; revision: number }[];
      page: number;
      pages: number;
      id: string;
    } | null>(null);
  const host = useRef<HTMLElement>(null),
    historyToken = useRef(0),
    historyRequest = useRef<AbortController | null>(null),
    token = useRef(0),
    request = useRef<AbortController | null>(null),
    latest = useRef({ raw, filter, page, customer, store, busy });
  const busyRef = useRef(false);
  useLayoutEffect(() => {
    latest.current = { raw, filter, page, customer, store, busy };
  }, [raw, filter, page, customer, store, busy]);
  const load = useCallback(
    async (external?: AbortSignal) => {
      const generation = ++token.current;
      request.current?.abort();
      const c = (request.current = new AbortController());
      const abort = () => c.abort();
      external?.addEventListener('abort', abort, { once: true });
      busyRef.current = true;
      setBusy(true);
      try {
        const f = latest.current;
        const params = new URLSearchParams({
          ...f.filter,
          page: String(f.page),
          ...(f.customer ? { customer: String(f.customer) } : {}),
          ...(f.store ? { store: String(f.store) } : {}),
        });
        const result = api.page(await read('/api/v1/crm/contact-tasks?' + params, c.signal));
        if (c.signal.aborted || generation !== token.current) return false;
        if (result.scope.store !== (f.store ?? bootstrap.storeId)) api.fail();
        setValue(result);
        setError('');
        return true;
      } catch (e) {
        if (c.signal.aborted || generation !== token.current) return false;
        setValue(null);
        setError(e instanceof Error ? e.message : 'Не вдалося прочитати задачі.');
        if (e && typeof e === 'object' && 'status' in e && (e.status === 401 || e.status === 403))
          onDenied();
        return false;
      } finally {
        external?.removeEventListener('abort', abort);
        if (generation === token.current) {
          busyRef.current = false;
          if (external) flushSync(() => setBusy(false));
          else setBusy(false);
        }
      }
    },
    [bootstrap.storeId, onDenied, read],
  );
  useEffect(() => {
    const counter = token,
      historyCounter = historyToken;
    let alive = true;
    queueMicrotask(() => {
      if (alive) {
        setValue(null);
        setHistory(null);
        void load();
      }
    });
    return () => {
      alive = false;
      counter.current++;
      request.current?.abort();
      historyCounter.current++;
      historyRequest.current?.abort();
    };
  }, [customer, store, filter, page, load]);
  useEffect(() => {
    onReader({
      store: () => latest.current.store,
      stamp: () => token.current,
      blocked: () =>
        busyRef.current ||
        JSON.stringify(latest.current.raw) !== JSON.stringify(latest.current.filter),
      refresh: load,
    });
    return () => onReader(null);
  }, [onReader, load]);
  const showHistory = async (id: string, page = 1) => {
    historyRequest.current?.abort();
    const c = (historyRequest.current = new AbortController()),
      historyGeneration = ++historyToken.current,
      generation = token.current;
    try {
      const x = api.history(
        await read('/api/v1/crm/contact-tasks/' + id + '/history?page=' + page, c.signal),
        id,
      );
      const items = x.items.map((r) => ({
        key: r.request_key,
        at: r.at,
        actor: r.actor,
        action: r.action,
        revision: r.revision,
      }));
      if (
        c.signal.aborted ||
        generation !== token.current ||
        historyGeneration !== historyToken.current
      )
        return;
      setHistory({ id, items, page: api.integer(x.page), pages: api.integer(x.pages) });
    } catch (e) {
      if (
        !c.signal.aborted &&
        generation === token.current &&
        historyGeneration === historyToken.current
      ) {
        setError(String(e));
        if (e && typeof e === 'object' && 'status' in e && (e.status === 401 || e.status === 403))
          onDenied();
      }
    }
  };
  const createCustomer = customer || Number(customerChoice?.id) || null;
  return (
    <section
      ref={host}
      className="contact-task-section"
      aria-label={customer ? 'Задачі контакту' : 'Черга контактних задач'}
    >
      <h3>{customer ? 'Задачі контакту' : 'Черга контактних задач'}</h3>
      <p className="tk-help">
        Задачі конкретних магазинів. Стан роботи не є воронкою продажів або згодою на повідомлення.
      </p>
      <div className="contact-task-filters">
        <TextField label="Пошук задачі" value={raw.q} onChange={(q) => setRaw({ ...raw, q })} />
        <Select
          label="Стан задач у списку"
          selectedKey={raw.status || 'all'}
          onSelectionChange={(key) => setRaw({ ...raw, status: key === 'all' ? '' : String(key) })}
          options={[{ id: 'all', label: 'Усі стани' }, ...api.statuses]}
        />
        <Select
          label="Архів задач"
          selectedKey={raw.archived}
          onSelectionChange={(key) => setRaw({ ...raw, archived: String(key) })}
          options={[
            { id: 'no', label: 'Без архівних' },
            { id: 'yes', label: 'Архівні' },
            { id: 'all', label: 'Усі задачі' },
          ]}
        />
        <Select
          label="Призначення задач"
          selectedKey={raw.assignee || 'all'}
          onSelectionChange={(key) =>
            setRaw({ ...raw, assignee: key === 'all' ? '' : String(key) })
          }
          options={[
            { id: 'all', label: 'Усі виконавці' },
            { id: 'me', label: 'Призначені мені' },
            { id: 'unassigned', label: 'Не призначені' },
          ]}
        />
        <TextField
          label="Дата задач від"
          value={raw.dueFrom}
          onChange={(dueFrom) => setRaw({ ...raw, dueFrom })}
        />
        <TextField
          label="Дата задач до"
          value={raw.dueTo}
          onChange={(dueTo) => setRaw({ ...raw, dueTo })}
        />
        <Select
          label="Строк задач"
          selectedKey={raw.overdue || 'all'}
          onSelectionChange={(key) => setRaw({ ...raw, overdue: key === 'all' ? '' : String(key) })}
          options={[
            { id: 'all', label: 'Будь-який строк' },
            { id: 'yes', label: 'Прострочені' },
          ]}
        />
      </div>
      <div className="customer-actions">
        <Button
          onPress={() => {
            setFilter({ ...raw });
            setPage(1);
          }}
        >
          Знайти задачі
        </Button>
        <Button
          onPress={() => {
            setRaw(empty);
            setFilter(empty);
            setPage(1);
          }}
        >
          Очистити фільтри задач
        </Button>
        <Button isDisabled={busy} onPress={() => void load()}>
          Перечитати задачі
        </Button>
      </div>
      {!customer ? (
        <DirectoryComboBox
          api={directoryApi}
          type="parties"
          query={{ purpose: 'filter', kind: 'customer' }}
          label="Контакт для нової задачі"
          value={customerChoice?.id || ''}
          selected={customerChoice}
          onCommit={setCustomerChoice}
        />
      ) : null}
      <Button
        isDisabled={!createCustomer || !(store ?? bootstrap.storeId)}
        onPress={() => openTask(createCustomer!, store ?? bootstrap.storeId!)}
      >
        Додати задачу контакту
      </Button>
      {!(store ?? bootstrap.storeId) ? (
        <p role="status">Для нової задачі оберіть конкретний магазин у фільтрі клієнтської бази.</p>
      ) : null}
      {busy ? <p role="status">Завантажуємо задачі…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {value && value.scope.store === (store ?? bootstrap.storeId) ? (
        <>
          <p role="status">
            Задач: {value.total}. Сторінка {value.page} з {value.pages}. Заплановано:{' '}
            {value.summary.todo}; у роботі: {value.summary.doing}; завершено: {value.summary.done};
            скасовано: {value.summary.cancelled}; прострочено: {value.summary.overdue}.
          </p>
          <ul className="contact-task-list">
            {value.items.map((t) => (
              <li key={t.id}>
                <strong>{t.terms.title}</strong>
                <p>
                  {t.customerName}
                  {!t.customerActive ? ' · Неактивний контакт' : ''} · {t.storeName} ·{' '}
                  {api.statuses.find((s) => s.id === t.terms.status)?.label} ·{' '}
                  {t.terms.due_on || 'Без дати'} · {t.assigneeName || 'Не призначено'}
                  {t.assigneeActive === false ? ' · Неактивний виконавець' : ''}
                  {t.terms.archived ? ' · Архівна' : ''}
                </p>
                <div className="customer-actions">
                  <Button onPress={() => openTask(t.customer, t.store, t)}>
                    Відкрити задачу {t.terms.title}
                  </Button>
                  <Button onPress={() => void showHistory(t.id)}>
                    Журнал задачі {t.terms.title}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          <nav aria-label="Сторінки задач" className="customer-actions">
            <Button isDisabled={busy || value.page <= 1} onPress={() => setPage(value.page - 1)}>
              Попередні задачі
            </Button>
            <Button
              isDisabled={busy || value.page >= value.pages}
              onPress={() => setPage(value.page + 1)}
            >
              Наступні задачі
            </Button>
          </nav>
        </>
      ) : null}
      {history ? (
        <section aria-label="Журнал задачі">
          <h4>Журнал задачі</h4>
          <ul>
            {history.items.map((h) => (
              <li key={h.key}>
                {h.at} · {h.actor} · {h.action === 'create' ? 'Створено' : 'Змінено'} · Версія{' '}
                {h.revision}
              </li>
            ))}
          </ul>
          <Button
            isDisabled={history.page <= 1}
            onPress={() => void showHistory(history.id, history.page - 1)}
          >
            Попередні події
          </Button>
          <Button
            isDisabled={history.page >= history.pages}
            onPress={() => void showHistory(history.id, history.page + 1)}
          >
            Наступні події
          </Button>
          <Button onPress={() => setHistory(null)}>Закрити журнал задачі</Button>
        </section>
      ) : null}
    </section>
  );
}
