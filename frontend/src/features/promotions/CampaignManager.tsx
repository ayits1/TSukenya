import './promotions.css';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { Button } from '../../shared/ui/Button';
import { ComboBox } from '../../shared/ui/ComboBox';
import { Select } from '../../shared/ui/Select';
import { CampaignEditor } from './CampaignEditor';
import { takeCampaignRestore } from './recovery/session';
import type { CampaignPayload } from './recovery/codec';
import { emptyFilters, type CatalogApi, type Product } from '../catalog/api';
import type { Campaign, PromotionApi, PromotionContext } from './api';
const statuses = {
  active: 'Діє',
  scheduled: 'Заплановано',
  expired: 'Завершено',
  disabled: 'Вимкнено',
  archived: 'Архів',
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
  const [dirty, setDirty] = useState(false);
  const [restored, setRestored] = useState<CampaignPayload | undefined>();
  const [editorKey, setEditorKey] = useState(0);
  const busy = false;
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
  const reset = (campaign: Campaign | null) => {
    if (dirty && !confirm('Закрити редактор? Чернетка залишиться у локальному відновленні.'))
      return;
    setEditing(campaign);
    setRestored(undefined);
    setDirty(false);
    setEditorKey((k) => k + 1);
    setOpen(true);
  };
  useEffect(() => {
    const restore = () => {
      const value = takeCampaignRestore();
      if (!value) return;
      setRestored(value);
      setEditing(null);
      setEditorKey((k) => k + 1);
      setOpen(true);
    };
    restore();
    window.addEventListener('tsukenya:campaign-draft-restore', restore);
    return () => window.removeEventListener('tsukenya:campaign-draft-restore', restore);
  }, []);
  const changed = () => {
    void cache.invalidateQueries({ queryKey: ['campaigns'] });
    void cache.invalidateQueries({ queryKey: ['price-history'] });
    onChanged();
  };
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
      {context.canManage && campaigns.error ? (
        <>
          <p role="alert">{campaigns.error.message}</p>
          <Button onPress={() => void campaigns.refetch()}>Повторити список акцій</Button>
        </>
      ) : null}
      {context.canManage && !open && !campaigns.error ? (
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
        <CampaignEditor
          key={editorKey}
          campaign={editing}
          restored={restored}
          api={api}
          catalog={catalog}
          context={context}
          onDirty={setDirty}
          onChanged={changed}
          onClose={() => {
            setOpen(false);
            setDirty(false);
          }}
        />
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
