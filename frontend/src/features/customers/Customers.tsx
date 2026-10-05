import { TaskSection } from './tasks/TaskSection';
import type { CommittedReader } from '../../shared/api/committedReader';
import { useCallback } from 'react';
import { registerTradingReader, type TradingResource } from '../../shared/api/tradingFreshness';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '../../shared/ui/Button';
import { TextField } from '../../shared/ui/TextField';
import { Select } from '../../shared/ui/Select';
import { DirectoryComboBox } from '../trading/DirectoryComboBox';
import type { TradingApi, DirectoryItem, TradingBootstrap } from '../trading/api';
import { CustomerProfile } from './CustomerProfile';
import { emptyCustomerFilters, type CustomerApi, type CustomerFilters } from './api';
import './customers.css';

export type CustomerOptions = {
  bootstrap?: TradingBootstrap;
  onDenied?: () => void;
  taskRead?: (path: string, signal: AbortSignal) => Promise<unknown>;
  stores: { id: number; name: string }[];
  store: number | null;
  onEdit: (id?: number) => Promise<void>;
  onHistory: (id: number, store: number | null, name: string) => Promise<void>;
  onStore?: (store: number | null) => void;
  directoryApi?: TradingApi;
  selectedStore?: DirectoryItem | null;
};
export function Customers({
  api,
  bootstrap,
  onDenied,
  taskRead,
  stores,
  store,
  onEdit,
  onHistory,
  onStore,
  directoryApi,
  selectedStore,
  initialFilters = emptyCustomerFilters,
  onFilters = () => {},
  initialCustomer = null,
  onSelected = () => {},
}: CustomerOptions & {
  api: CustomerApi;
  initialFilters?: CustomerFilters;
  onFilters?: (value: CustomerFilters) => void;
  initialCustomer?: number | null;
  onSelected?: (value: number) => void;
}) {
  const client = useQueryClient();
  const [view, setView] = useState<'customers' | 'tasks'>('customers');
  const taskReader = useRef<CommittedReader | null>(null);
  const onTaskReader = useCallback((reader: CommittedReader | null) => {
    taskReader.current = reader;
  }, []);
  const canTasks = !!bootstrap && ['owner', 'manager', 'accountant'].includes(bootstrap.role);
  const [filters, setFilters] = useState({ ...initialFilters, store });
  const [selected, setSelected] = useState<number | null>(initialCustomer);
  const host = useRef<HTMLDivElement>(null);
  const focusProfile = useRef(false);
  const historyButton = useRef<HTMLButtonElement>(null);
  const actionErrorNode = useRef<HTMLParagraphElement>(null);
  const [query, setQuery] = useState(filters.q);
  const [actionError, setActionError] = useState('');
  const [historyBusy, setHistoryBusy] = useState(false);
  const [storeChoice, setStoreChoice] = useState(selectedStore || null);
  useEffect(() => {
    if (!directoryApi || filters.store === null) return;
    const controller = new AbortController();
    void directoryApi
      .details(
        [{ type: 'stores', id: String(filters.store) }],
        { purpose: 'filter' },
        controller.signal,
      )
      .then((result) => {
        if (!controller.signal.aborted) setStoreChoice(result.items[0] || null);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [directoryApi, filters.store]);
  const searchPending = query !== filters.q;
  useEffect(() => {
    if (actionError) {
      actionErrorNode.current?.focus({ preventScroll: true });
      actionErrorNode.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [actionError]);
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(filters.q), 250);
    return () => clearTimeout(timer);
  }, [filters.q]);
  useEffect(() => {
    const refresh = (event: Event) => {
      const domains: unknown = event instanceof CustomEvent ? event.detail?.domains : undefined;
      if (Array.isArray(domains) && !domains.includes('customers')) return;
      void client.invalidateQueries({ queryKey: ['customers'] });
    };
    window.addEventListener('tsukenya:data-changed', refresh);
    return () => window.removeEventListener('tsukenya:data-changed', refresh);
  }, [client]);
  const list = useQuery({
    queryKey: ['customers', 'list', { ...filters, q: query }],
    queryFn: ({ signal }) => api.list({ ...filters, q: query }, signal),
    enabled: !searchPending && view === 'customers',
    retry: false,
  });
  const profile = useQuery({
    queryKey: ['customers', 'profile', selected, filters.store],
    queryFn: ({ signal }) => api.profile(selected!, filters.store, signal),
    enabled: selected !== null && view === 'customers',
    retry: false,
  });
  const reader = useRef({ filters, selected, searchPending, historyBusy, list, profile, view });
  useLayoutEffect(() => {
    reader.current = { filters, selected, searchPending, historyBusy, list, profile, view };
  }, [filters, selected, searchPending, historyBusy, list, profile, view]);
  const readStamp = useRef(0);
  useEffect(() => {
    readStamp.current++;
  }, [filters, selected, view]);
  useEffect(() => {
    if (!bootstrap || !directoryApi || !host.current) return;
    return registerTradingReader({
      name: 'customers',
      host: host.current,
      identity: { role: bootstrap.role, scopeStore: bootstrap.storeId },
      context: () => ({
        store: reader.current.filters.store ?? bootstrap.storeId,
        resources:
          reader.current.view === 'tasks'
            ? ['customers_tasks']
            : [
                'customers_contacts',
                'customers_metrics',
                ...(['owner', 'manager', 'accountant'].includes(bootstrap.role)
                  ? ([
                      'customers_debts',
                      ...(taskReader.current ? ['customers_tasks'] : []),
                    ] as TradingResource[])
                  : []),
              ],
      }),
      readStamp: () => readStamp.current + (taskReader.current?.stamp() || 0),
      blocked: () =>
        (reader.current.view === 'customers' && reader.current.searchPending) ||
        reader.current.historyBusy ||
        Boolean(taskReader.current?.blocked()) ||
        client.isFetching({ queryKey: ['customers'] }) > 0,
      revalidate: async (signal) => {
        const fresh = await directoryApi.bootstrap(signal);
        if (signal.aborted) return;
        if (fresh.role !== bootstrap.role || fresh.storeId !== bootstrap.storeId)
          throw Object.assign(Error('Доступ до клієнтів змінився.'), { status: 403 });
      },
      refresh: async (signal) => {
        const cancel = () => {
          void client.cancelQueries({ queryKey: ['customers'] });
        };
        signal.addEventListener('abort', cancel, { once: true });
        try {
          if (signal.aborted) return false;
          await client.refetchQueries(
            { queryKey: ['customers'], type: 'active' },
            { throwOnError: true },
          );
          if (taskReader.current && !(await taskReader.current.refresh(signal))) return false;
          return !signal.aborted;
        } finally {
          signal.removeEventListener('abort', cancel);
        }
      },
      deny: () => {
        onDenied?.();
      },
    });
  }, [bootstrap, directoryApi, client, onDenied]);
  const change = (next: Partial<CustomerFilters>) => {
    const value = { ...filters, page: 1, ...next };
    setFilters(value);
    onFilters(value);
    if ('store' in next) onStore?.(value.store);
    setActionError('');
  };
  useEffect(() => {
    if (focusProfile.current && profile.data && !profile.isFetching && !profile.error) {
      focusProfile.current = false;
      const title = host.current?.querySelector<HTMLElement>('#customer-profile-title');
      title?.focus({ preventScroll: true });
      if (window.matchMedia('(max-width: 700px)').matches)
        title?.scrollIntoView({ block: 'start' });
    }
  }, [profile.data, profile.isFetching, profile.error]);
  const history = async () => {
    if (selected === null || historyBusy) return;
    setHistoryBusy(true);
    setActionError('');
    try {
      await onHistory(selected, filters.store, profile.data?.customer.name || 'Клієнт');
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Не вдалося відкрити історію.');
    } finally {
      setHistoryBusy(false);
      // The native browser closes before this disabled React trigger is re-enabled.
      requestAnimationFrame(() => {
        if (!document.querySelector('dialog[open]')) historyButton.current?.focus();
      });
    }
  };
  const edit = async (id?: number) => {
    if (historyBusy) return;
    setHistoryBusy(true);
    setActionError('');
    try {
      await onEdit(id);
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : 'Не вдалося відкрити редактор клієнта.',
      );
    } finally {
      setHistoryBusy(false);
    }
  };
  const storeName =
    filters.store === null
      ? 'Усі доступні магазини'
      : storeChoice?.id === String(filters.store)
        ? storeChoice.name
        : stores.find((s) => s.id === filters.store)?.name || 'Магазин';
  return (
    <div className="panel tk-root customers-workspace" ref={host}>
      <div className="customer-toolbar">
        <h2>Клієнтська база</h2>
        {list.data?.canEdit ? (
          <Button
            variant="primary"
            isDisabled={historyBusy}
            onPress={() => {
              void edit();
            }}
          >
            Додати клієнта
          </Button>
        ) : null}
        <Button
          isDisabled={list.isFetching || profile.isFetching}
          onPress={() => {
            void client.invalidateQueries({ queryKey: ['customers'] });
          }}
        >
          Оновити дані
        </Button>
        {view === 'customers' && filters.q ? (
          <Button
            onPress={() => {
              change({ q: '' });
              setQuery('');
              host.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
            }}
          >
            Очистити пошук
          </Button>
        ) : null}
      </div>
      <div className="customer-filters">
        {view === 'customers' ? (
          <>
            <TextField
              label="Пошук клієнта"
              placeholder="Ім’я, телефон або email"
              value={filters.q}
              onChange={(q) => change({ q })}
              maxLength={250}
              type="search"
            />
            <Select
              label="Стан клієнта"
              selectedKey={filters.active || 'all'}
              onSelectionChange={(key) =>
                change({ active: key === 'all' ? '' : (key as 'yes' | 'no') })
              }
              options={[
                { id: 'all', label: 'Усі клієнти' },
                { id: 'yes', label: 'Активні' },
                { id: 'no', label: 'Неактивні' },
              ]}
            />
          </>
        ) : null}
        {directoryApi ? (
          <DirectoryComboBox
            api={directoryApi}
            type="stores"
            query={{ purpose: 'filter' }}
            label="Магазин для аналітики"
            emptyLabel="Усі магазини"
            value={filters.store === null ? '' : String(filters.store)}
            selected={storeChoice?.id === String(filters.store) ? storeChoice : null}
            onCommit={(item) => {
              setStoreChoice(item);
              change({ store: item ? Number(item.id) : null });
            }}
          />
        ) : (
          <Select
            label="Магазин для аналітики"
            selectedKey={filters.store === null ? 'all' : String(filters.store)}
            onSelectionChange={(key) => change({ store: key === 'all' ? null : Number(key) })}
            options={[
              { id: 'all', label: 'Усі доступні магазини' },
              ...stores.map((s) => ({ id: String(s.id), label: s.name })),
            ]}
          />
        )}
      </div>
      <p className="tk-help">
        Контакти — спільний довідник. Аналітика враховує лише документи доступних магазинів.
      </p>
      {canTasks ? (
        <div className="customer-actions" aria-label="Режими клієнтської бази">
          <Button onPress={() => setView('customers')} aria-pressed={view === 'customers'}>
            Клієнти
          </Button>
          <Button onPress={() => setView('tasks')} aria-pressed={view === 'tasks'}>
            Контактні задачі
          </Button>
        </div>
      ) : null}
      {view === 'tasks' && bootstrap && directoryApi && taskRead ? (
        <TaskSection
          customer={null}
          store={filters.store}
          bootstrap={bootstrap}
          directoryApi={directoryApi}
          read={taskRead}
          onDenied={onDenied || (() => {})}
          onReader={onTaskReader}
        />
      ) : null}
      {view === 'customers' ? (
        <div className="customer-layout">
          <section aria-label="Список клієнтів" aria-busy={list.isFetching}>
            {list.error ? (
              <div role="alert">
                <p>{list.error.message}</p>
                <Button
                  onPress={() => {
                    void list.refetch();
                  }}
                >
                  Повторити завантаження
                </Button>
              </div>
            ) : null}
            {list.isFetching || searchPending ? <p role="status">Завантажуємо клієнтів…</p> : null}
            {list.data && !list.error && !searchPending ? (
              <>
                <p role="status">
                  Клієнтів: {list.data.total}. Сторінка {list.data.page} з {list.data.pages}.
                </p>
                <ul className="customer-list">
                  {list.data.items.map((customer) => (
                    <li key={customer.id} data-selected={customer.id === selected}>
                      <Button
                        onPress={() => {
                          focusProfile.current = true;
                          setSelected(customer.id);
                          onSelected(customer.id);
                          setActionError('');
                        }}
                        aria-pressed={customer.id === selected}
                      >
                        <strong>{customer.name}</strong>
                        <span>{customer.phone || customer.email || 'Контакти не вказано'}</span>
                        {!customer.active ? (
                          <span className="customer-eyebrow">Неактивний</span>
                        ) : null}
                      </Button>
                    </li>
                  ))}
                </ul>
                {list.data.items.length === 0 ? (
                  <p>
                    {filters.q || filters.active
                      ? 'Клієнтів за цим пошуком не знайдено. Очистіть або змініть пошук.'
                      : 'Клієнтів ще немає.'}
                  </p>
                ) : null}
                <nav className="customer-actions" aria-label="Сторінки клієнтів">
                  <Button
                    isDisabled={list.isFetching || list.data.page <= 1}
                    onPress={() => change({ page: list.data!.page - 1 })}
                  >
                    Попередня
                  </Button>
                  <Button
                    isDisabled={list.isFetching || list.data.page >= list.data.pages}
                    onPress={() => change({ page: list.data!.page + 1 })}
                  >
                    Наступна
                  </Button>
                </nav>
              </>
            ) : null}
          </section>
          <div aria-busy={profile.isFetching}>
            {selected === null ? (
              <section className="customer-profile">
                <h3>Картка клієнта</h3>
                <p>
                  Виберіть клієнта зі списку, щоб переглянути покупки та доступні фінансові дані.
                </p>
              </section>
            ) : null}
            {profile.isFetching ? <p role="status">Завантажуємо картку клієнта…</p> : null}
            {profile.error ? (
              <div role="alert">
                <p>{profile.error.message}</p>
                <Button
                  onPress={() => {
                    void profile.refetch();
                  }}
                >
                  Повторити завантаження картки
                </Button>
              </div>
            ) : null}
            {profile.data && !profile.error && !profile.isFetching ? (
              <CustomerProfile
                data={profile.data}
                storeName={storeName}
                onHistory={() => {
                  void history();
                }}
                onEdit={() => {
                  void edit(profile.data.customer.id);
                }}
                onBack={() => {
                  const item = host.current?.querySelector<HTMLElement>(
                    '.customer-list [aria-pressed="true"]',
                  );
                  const target =
                    item || host.current?.querySelector<HTMLElement>('input[type="search"]');
                  target?.focus();
                  target?.scrollIntoView({ block: 'nearest' });
                }}
                busy={historyBusy}
                historyRef={historyButton}
              />
            ) : null}
            {canTasks && profile.data && !profile.error && bootstrap && directoryApi && taskRead ? (
              <TaskSection
                key={profile.data.customer.id}
                customer={profile.data.customer.id}
                store={filters.store}
                bootstrap={bootstrap}
                directoryApi={directoryApi}
                read={taskRead}
                onDenied={onDenied || (() => {})}
                onReader={onTaskReader}
              />
            ) : null}
            {actionError ? (
              <p role="alert" tabIndex={-1} ref={actionErrorNode}>
                {actionError}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
