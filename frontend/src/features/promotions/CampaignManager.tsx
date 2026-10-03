import './promotions.css';
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { Button } from '../../shared/ui/Button';
import { ComboBox } from '../../shared/ui/ComboBox';
import { TextField } from '../../shared/ui/TextField';
import { DatePicker, ukraineToday } from '../../shared/ui/DatePicker';
import { MoneyField } from '../../shared/ui/MoneyField';
import { Select } from '../../shared/ui/Select';
import { ApiError } from '../../shared/api/client';
import { emptyFilters, type CatalogApi, type Product } from '../catalog/api';
import type { Campaign, CampaignInput, PromotionApi, PromotionContext } from './api';
const statuses = {
  active: 'Діє',
  scheduled: 'Заплановано',
  expired: 'Завершено',
  disabled: 'Вимкнено',
  archived: 'Архів',
};
const empty = (): CampaignInput => ({
  name: '',
  startsOn: ukraineToday(),
  endsOn: ukraineToday(),
  active: true,
  scope: 'network',
  stores: [],
  prices: [],
  reason: '',
});
type Row = { product: string; name: string; price: string };
type Intent = {
  input: CampaignInput;
  identity: { id: string; revision: number } | { idempotencyKey: string };
  draftKey: string;
};
export function CampaignManager({
  api,
  catalog,
  context,
  onDirty,
  onChanged,
}: {
  api: PromotionApi;
  catalog: CatalogApi;
  context: PromotionContext;
  onDirty: (value: boolean) => void;
  onChanged: () => void;
}) {
  const cache = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Campaign | null>(null);
  const [draft, setDraft] = useState(empty);
  const [rows, setRows] = useState<Row[]>([]);
  const [search, setSearch] = useState('');
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [dirty, setDirty] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const intent = useRef<Intent | null>(null);
  const mounted = useRef(true);
  const [showHistory, setShowHistory] = useState(false);
  const [campaignPage, setCampaignPage] = useState(1);
  const [campaignScope, setCampaignScope] = useState<'' | 'network' | 'stores'>('');
  const [historyNavigation, setHistoryNavigation] = useState({ store: context.storeId, page: 1 });
  if (historyNavigation.store !== context.storeId)
    setHistoryNavigation({ store: context.storeId, page: 1 });
  const historyPage = historyNavigation.store === context.storeId ? historyNavigation.page : 1;
  const [historyProduct, setHistoryProduct] = useState<Product | null>(null);
  const [historySearch, setHistorySearch] = useState('');
  const [historySearchTerm, setHistorySearchTerm] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setHistorySearchTerm(historySearch), 200);
    return () => clearTimeout(id);
  }, [historySearch]);
  const historyChoices = useQuery({
    queryKey: ['history-products', context.storeId, historySearchTerm],
    queryFn: ({ signal }) =>
      catalog.list({ ...emptyFilters, q: historySearchTerm, limit: 50 }, signal),
    enabled: showHistory,
    retry: false,
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    onDirty(dirty);
    const guard = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty, onDirty]);
  useEffect(() => {
    const id = setTimeout(() => setSearchTerm(search), 200);
    return () => clearTimeout(id);
  }, [search]);
  const campaigns = useQuery({
    queryKey: ['campaigns', campaignPage, campaignScope],
    queryFn: ({ signal }) => api.campaigns(signal, { page: campaignPage, scope: campaignScope }),
    placeholderData: keepPreviousData,
    enabled: context.canManage,
    retry: false,
  });
  const history = useQuery({
    queryKey: ['price-history', context.storeId, historyPage, historyProduct?.id],
    queryFn: ({ signal }) =>
      api.history(context.storeId, signal, {
        page: historyPage,
        ...(historyProduct ? { product: historyProduct.id } : {}),
      }),
    enabled: showHistory,
    retry: false,
  });
  const products = useQuery({
    queryKey: ['campaign-products', searchTerm, context.storeId],
    queryFn: ({ signal }) => catalog.list({ ...emptyFilters, q: searchTerm, limit: 50 }, signal),
    enabled: open && context.canManage,
    retry: false,
  });
  const change = (patch: Partial<CampaignInput>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setDirty(true);
  };
  const input = (): CampaignInput => ({
    ...draft,
    prices: rows.map(({ product, price }) => ({ product, price })),
  });
  const reset = (campaign: Campaign | null) => {
    if (busy) return;
    if (dirty && !confirm('Закрити чернетку акції без збереження?')) return;
    setEditing(campaign);
    setDraft(
      campaign
        ? {
            name: campaign.name,
            startsOn: campaign.startsOn,
            endsOn: campaign.endsOn,
            active: campaign.active,
            scope: campaign.scope,
            stores: campaign.stores,
            prices: campaign.prices,
            reason: '',
          }
        : empty(),
    );
    setRows(campaign ? campaign.prices : []);
    intent.current = null;
    setBlocked(false);
    setDirty(false);
    setNotice('');
    setSearch('');
    setSelectedProduct(null);
    setOpen(true);
  };
  async function save() {
    if (busy || blocked) return;
    const current = input();
    const pending = intent.current || {
      input: current,
      identity: editing
        ? { id: editing.id, revision: editing.revision }
        : { idempotencyKey: crypto.randomUUID() },
      draftKey: JSON.stringify(current),
    };
    intent.current = pending;
    setBusy(true);
    setNotice('');
    try {
      const saved = await api.save(pending.input, pending.identity);
      if (!mounted.current) return;
      // An ambiguous result retries the same intent. Newly entered text remains a separate draft.
      const unchanged = JSON.stringify(input()) === pending.draftKey;
      intent.current = null;
      setEditing(saved);
      setNotice(
        unchanged
          ? 'Акцію збережено. Змінені ціни додано до журналу та задач передруку.'
          : 'Первісну акцію збережено. Нові введені умови лишилися в чернетці; збережіть їх окремо.',
      );
      if (unchanged) {
        setDirty(false);
        setOpen(false);
      } else setDirty(true);
      await cache.invalidateQueries({ queryKey: ['campaigns'] });
      await cache.invalidateQueries({ queryKey: ['price-history'] });
      onChanged();
    } catch (error) {
      if (!mounted.current) return;
      setNotice(error instanceof Error ? error.message : 'Не вдалося зберегти акцію.');
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
        intent.current = null;
        if (error.status === 409) {
          setBlocked(true);
          void campaigns.refetch();
        }
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function archive() {
    if (!editing || busy) return;
    if (!draft.reason.trim()) {
      setNotice('Вкажіть причину архівування.');
      return;
    }
    if (!confirm('Архівувати акцію? Її історія залишиться доступною.')) return;
    setBusy(true);
    try {
      await api.archive(editing, draft.reason);
      if (!mounted.current) return;
      setOpen(false);
      setDirty(false);
      setNotice('Акцію архівовано.');
      await cache.invalidateQueries({ queryKey: ['campaigns'] });
      await cache.invalidateQueries({ queryKey: ['price-history'] });
      onChanged();
    } catch (error) {
      if (mounted.current)
        setNotice(error instanceof Error ? error.message : 'Не вдалося архівувати акцію.');
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <section className="tk-root tk-promotions" aria-label="Акції та журнал цін">
      <h2>Акції та журнал цін</h2>
      <p className="tk-help">
        Перемагає найнижча чинна ціна для вибраного магазину. Акція товару також враховується; її
        поля не змінюються кампанією.
      </p>
      <div className="tk-promotion-actions">
        {context.canManage ? (
          <Button onPress={() => reset(null)} isDisabled={busy}>
            Створити акцію
          </Button>
        ) : null}
        <Button onPress={() => setShowHistory((v) => !v)}>
          {showHistory ? 'Сховати журнал цін' : 'Журнал цін'}
        </Button>
      </div>
      {notice ? <p role="status">{notice}</p> : null}
      {context.canManage && campaigns.error ? (
        <>
          <p role="alert">{campaigns.error.message}</p>
          <Button onPress={() => void campaigns.refetch()}>Повторити список акцій</Button>
        </>
      ) : null}
      {context.canManage && !open ? (
        <div>
          <Select
            label="Показати кампанії"
            value={campaignScope || 'all'}
            options={[
              { id: 'all', label: 'Усі кампанії' },
              { id: 'network', label: 'Для мережі' },
              { id: 'stores', label: 'Для обраних магазинів' },
            ]}
            onChange={(key) => {
              if (key === 'all' || key === 'network' || key === 'stores') {
                setCampaignScope(key === 'all' ? '' : key);
                setCampaignPage(1);
              }
            }}
          />
          {campaigns.data?.items.map((c) => (
            <div className="tk-promotion-row" key={c.id}>
              <strong>
                {c.name}
                <small className="tk-help">
                  {statuses[c.status]} · {c.startsOn} — {c.endsOn} ·{' '}
                  {c.scope === 'network'
                    ? 'Мережа'
                    : c.stores
                        .map(
                          (id) => context.stores.find((s) => s.id === id)?.name || `Магазин №${id}`,
                        )
                        .join(', ')}
                </small>
              </strong>
              <span>{c.prices.length} товарів</span>
              <Button onPress={() => reset(c)} isDisabled={c.archived}>
                {c.archived ? 'Архів' : 'Умови акції'}
              </Button>
            </div>
          ))}
          {campaigns.data ? (
            <Pagination
              page={campaigns.data}
              busy={campaigns.isFetching}
              label="Кампанії"
              onPage={setCampaignPage}
            />
          ) : null}
        </div>
      ) : null}
      {open ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          aria-label="Умови акції"
          aria-busy={busy}
        >
          <h3>{editing ? 'Редагування акції' : 'Нова акція'}</h3>
          <div className="tk-promotion-grid">
            <TextField
              label="Назва акції"
              value={draft.name}
              onChange={(name) => change({ name })}
              maxLength={160}
              isDisabled={busy}
            />
            <TextField
              label="Причина зміни"
              value={draft.reason}
              onChange={(reason) => change({ reason })}
              maxLength={500}
              isDisabled={busy}
            />
            <DatePicker
              label="Початок акції"
              value={draft.startsOn}
              onChange={(startsOn) => change({ startsOn })}
              isDisabled={busy}
            />
            <DatePicker
              label="Закінчення акції включно"
              value={draft.endsOn}
              onChange={(endsOn) => change({ endsOn })}
              isDisabled={busy}
            />
            <Select
              label="Де діє акція"
              value={draft.scope}
              options={[
                { id: 'network', label: 'Уся мережа' },
                { id: 'stores', label: 'Обрані магазини' },
              ]}
              onChange={(key) => {
                if (key === 'network' || key === 'stores')
                  change({ scope: key, stores: key === 'network' ? [] : draft.stores });
              }}
              isDisabled={busy}
            />
            <label className="tk-promotion-check">
              <input
                type="checkbox"
                checked={draft.active}
                disabled={busy}
                onChange={(e) => change({ active: e.target.checked })}
              />
              Акція увімкнена
            </label>
          </div>
          {draft.scope === 'stores' ? (
            <fieldset disabled={busy}>
              <legend>Магазини акції</legend>
              {context.stores.map((s) => (
                <label key={s.id} className="tk-promotion-check">
                  <input
                    type="checkbox"
                    checked={draft.stores.includes(s.id)}
                    onChange={(e) =>
                      change({
                        stores: e.target.checked
                          ? [...draft.stores, s.id]
                          : draft.stores.filter((id) => id !== s.id),
                      })
                    }
                  />
                  {s.name}
                </label>
              ))}
            </fieldset>
          ) : null}
          <ComboBox
            label="Додати товар акції"
            search="server"
            options={products.data?.items.map((p) => ({ id: p.id, label: p.name })) || []}
            selectedKey={selectedProduct?.id || null}
            selectedOption={
              selectedProduct ? { id: selectedProduct.id, label: selectedProduct.name } : null
            }
            inputValue={search}
            onInputChange={(value) => {
              setSearch(value);
              setSelectedProduct((p) => (p && p.name === value ? p : null));
            }}
            isLoading={products.isFetching || search !== searchTerm}
            isDisabled={busy}
            onSelectionChange={(key) => {
              const p = products.data?.items.find((p) => p.id === key);
              if (p) {
                setSelectedProduct(p);
                setSearch(p.name);
              }
            }}
          />
          <div className="tk-promotion-actions">
            <Button
              isDisabled={
                busy || !selectedProduct || rows.some((r) => r.product === selectedProduct.id)
              }
              onPress={() => {
                if (!selectedProduct) return;
                setRows((r) =>
                  r.some((p) => p.product === selectedProduct.id)
                    ? r
                    : [
                        ...r,
                        { product: selectedProduct.id, name: selectedProduct.name, price: '' },
                      ],
                );
                setDirty(true);
                setSelectedProduct(null);
                setSearch('');
              }}
            >
              Додати вибраний товар
            </Button>
          </div>
          {products.error ? <p role="alert">{products.error.message}</p> : null}
          {rows.map((row) => (
            <div className="tk-promotion-row" key={row.product}>
              <strong>{row.name}</strong>
              <MoneyField
                label={`Акційна ціна: ${row.name}`}
                value={row.price}
                isDisabled={busy}
                onChange={(price) => {
                  setRows((rows) =>
                    rows.map((r) => (r.product === row.product ? { ...r, price } : r)),
                  );
                  setDirty(true);
                }}
              />
              <Button
                isDisabled={busy}
                onPress={() => {
                  setRows((r) => r.filter((item) => item.product !== row.product));
                  setDirty(true);
                }}
              >
                Прибрати {row.name}
              </Button>
            </div>
          ))}
          <div className="tk-promotion-actions">
            <Button
              type="submit"
              variant="primary"
              isDisabled={
                busy ||
                blocked ||
                !draft.name.trim() ||
                !draft.reason.trim() ||
                !draft.startsOn ||
                !draft.endsOn ||
                !rows.length
              }
            >
              {busy ? 'Зберігаємо…' : 'Зберегти акцію'}
            </Button>
            <Button
              isDisabled={busy}
              onPress={() => {
                if (!dirty || confirm('Закрити чернетку акції без збереження?')) {
                  setOpen(false);
                  setDirty(false);
                  intent.current = null;
                }
              }}
            >
              Закрити чернетку
            </Button>
            {blocked ? (
              <Button
                isDisabled={busy}
                onPress={() => {
                  if (
                    !editing ||
                    (dirty && !confirm('Відкрити актуальні умови замість локальної чернетки?'))
                  )
                    return;
                  setBusy(true);
                  void api
                    .campaign(editing.id)
                    .then((fresh) => {
                      if (!mounted.current) return;
                      setEditing(fresh);
                      setDraft({ ...fresh, reason: '' });
                      setRows(fresh.prices);
                      setDirty(false);
                      setBlocked(fresh.archived);
                      setNotice(
                        fresh.archived
                          ? 'Акцію архівовано. Історія доступна в журналі цін.'
                          : 'Актуальні умови завантажено.',
                      );
                      intent.current = null;
                    })
                    .catch((error: unknown) => {
                      if (mounted.current)
                        setNotice(
                          error instanceof Error
                            ? error.message
                            : 'Не вдалося завантажити актуальні умови. Чернетку збережено.',
                        );
                    })
                    .finally(() => {
                      if (mounted.current) setBusy(false);
                    });
                }}
              >
                Відкрити актуальні умови
              </Button>
            ) : null}
            {editing ? (
              <Button isDisabled={busy} onPress={() => void archive()}>
                Архівувати акцію
              </Button>
            ) : null}
          </div>
          <p className="tk-help">
            Дати включні, часовий пояс Київ. Для скасування не видаляємо історію. Після конфлікту
            збереження чернетка лишається на екрані; відкрийте актуальні умови окремо.
          </p>
        </form>
      ) : null}
      {showHistory ? (
        <>
          <h3>Журнал цін: {context.storeName || 'Мережа'}</h3>
          <ComboBox
            label="Товар у журналі цін"
            search="server"
            selectedKey={historyProduct?.id || 'all'}
            selectedOption={
              historyProduct ? { id: historyProduct.id, label: historyProduct.name } : null
            }
            options={[
              { id: 'all', label: 'Усі товари' },
              ...(historyChoices.data?.items.map((p) => ({ id: p.id, label: p.name })) || []),
            ]}
            inputValue={historySearch}
            onInputChange={setHistorySearch}
            isLoading={historyChoices.isFetching || historySearch !== historySearchTerm}
            onSelectionChange={(key) => {
              const p = historyChoices.data?.items.find((p) => p.id === key) || null;
              setHistoryProduct(p);
              setHistorySearch(p?.name || '');
              setHistoryNavigation({ store: context.storeId, page: 1 });
            }}
          />
          <Button
            onPress={() => {
              setHistoryProduct(null);
              setHistorySearch('');
              setHistoryNavigation({ store: context.storeId, page: 1 });
            }}
          >
            Усі товари в журналі
          </Button>
          {historyChoices.error ? <p role="alert">{historyChoices.error.message}</p> : null}
          {history.error ? (
            <>
              <p role="alert">{history.error.message}</p>
              <Button onPress={() => void history.refetch()}>Повторити журнал</Button>
            </>
          ) : history.isPending ? (
            <p role="status">Завантажуємо журнал…</p>
          ) : (
            <ul className="tk-price-history">
              {history.data?.items.map((h) => (
                <li key={h.id}>
                  <strong>
                    {h.name}: {h.before.salePrice} → {h.after.salePrice} грн
                  </strong>
                  <p className="tk-help">
                    {new Date(h.at).toLocaleString('uk-UA')} · {h.author} · {h.reason}
                  </p>
                </li>
              ))}
              {!history.data?.items.length ? <li>Змін ціни ще немає.</li> : null}
            </ul>
          )}
          {history.data ? (
            <Pagination
              page={history.data}
              busy={history.isFetching}
              label="Журнал цін"
              onPage={(page) => setHistoryNavigation({ store: context.storeId, page })}
            />
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function Pagination({
  page,
  busy,
  label,
  onPage,
}: {
  page: { page: number; pages: number; total: number };
  busy: boolean;
  label: string;
  onPage: (page: number) => void;
}) {
  return (
    <nav className="tk-promotion-actions" aria-label={`Сторінки: ${label}`}>
      <Button isDisabled={busy || page.page <= 1} onPress={() => onPage(page.page - 1)}>
        Попередня
      </Button>
      <span role="status">
        Сторінка {page.page} з {page.pages} · записів {page.total}
      </span>
      <Button isDisabled={busy || page.page >= page.pages} onPress={() => onPage(page.page + 1)}>
        Далі
      </Button>
    </nav>
  );
}
