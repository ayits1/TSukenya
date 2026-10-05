import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '../../shared/ui/Button';
import { TextField } from '../../shared/ui/TextField';
import { DatePicker, ukraineToday } from '../../shared/ui/DatePicker';
import { MoneyField } from '../../shared/ui/MoneyField';
import { Select } from '../../shared/ui/Select';
import { ComboBox } from '../../shared/ui/ComboBox';
import { ConflictComparison } from '../../shared/ui/ConflictComparison';
import {
  compareThreeWay,
  resolveThreeWay,
  type MergeField,
  type MergeChoices,
} from '../../shared/merge/threeWay';
import { emptyFilters, type CatalogApi, type Product } from '../catalog/api';
import type { Campaign, CampaignInput, PromotionApi, PromotionContext } from './api';
import { createRecoveryApi, type Operation } from './recovery/api';
import { useCampaignRecovery } from './recovery/session';
import { RecoveryActions } from './recovery/RecoveryActions';
import type { Raw, CampaignPayload } from './recovery/codec';
export function campaignProjection(c: Campaign): CampaignInput {
  return {
    name: c.name,
    startsOn: c.startsOn,
    endsOn: c.endsOn,
    active: c.active,
    scope: c.scope,
    stores: [...c.stores],
    prices: c.prices.map(({ product, price }) => ({ product, price })),
    reason: '',
  };
}
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
export const campaignFields: MergeField<CampaignInput>[] = [
  {
    id: 'terms',
    label: 'Назва, дати, магазини, стан і всі ціни акції',
    read: ({ reason, ...terms }) => {
      void reason;
      return terms;
    },
    write: (target, { reason, ...terms }) => {
      void reason;
      return { ...terms, reason: target.reason };
    },
    format: (value) => JSON.stringify(value),
  },
  {
    id: 'reason',
    label: 'Причина зміни',
    read: (v) => v.reason,
    write: (target, source) => ({ ...target, reason: source.reason }),
  },
];
const recoveryApi = createRecoveryApi();
export function CampaignEditor({
  campaign,
  restored,
  api,
  catalog,
  context,
  onDirty,
  onChanged,
  onClose,
}: {
  campaign: Campaign | null;
  restored?: CampaignPayload | undefined;
  api: PromotionApi;
  catalog: CatalogApi;
  context: PromotionContext;
  onDirty: (v: boolean) => void;
  onChanged: () => void;
  onClose: () => void;
}) {
  const initial = restored?.draft || {
    input: campaign ? campaignProjection(campaign) : empty(),
    names: Object.fromEntries(campaign?.prices.map((p) => [p.product, p.name]) || []),
    search: '',
  };
  const [raw, setRaw] = useState<Raw>(initial),
    rawRef = useRef(raw);
  useLayoutEffect(() => {
    rawRef.current = raw;
  }, [raw]);
  const baseline = restored?.baseline || {
    target: campaign?.id || null,
    revision: campaign?.revision || null,
    archived: campaign?.archived || false,
    original: initial,
  };
  const recovery = useCampaignRecovery(baseline, raw, restored, !!api.durableRecovery);
  const legacyIntent = useRef<{
    input: CampaignInput;
    identity: { id: string; revision: number } | { idempotencyKey: string };
    draftKey: string;
  } | null>(null);
  const [legacyTarget, setLegacyTarget] = useState(campaign);
  const [legacyBlocked, setLegacyBlocked] = useState(false);
  const [legacyBusy, setLegacyBusy] = useState(false),
    [notice, setNotice] = useState(''),
    [dirty, setDirty] = useState(!!restored),
    [current, setCurrent] = useState<Campaign | null>(null),
    [choices, setChoices] = useState<MergeChoices>({}),
    [searchTerm, setSearchTerm] = useState(''),
    [selected, setSelected] = useState<Product | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const privateAllowed = api.durableRecovery ? recovery.private : true,
    busy = legacyBusy || recovery.busy;
  useEffect(() => {
    onDirty(dirty || recovery.intent || recovery.confirmed);
  }, [dirty, recovery.intent, recovery.confirmed, onDirty]);
  useEffect(() => {
    const timer = setTimeout(() => setSearchTerm(raw.search), 200);
    return () => clearTimeout(timer);
  }, [raw.search]);
  const products = useQuery({
    queryKey: ['campaign-editor-products', context.storeId, searchTerm],
    queryFn: ({ signal }) => catalog.list({ ...emptyFilters, q: searchTerm, limit: 50 }, signal),
    enabled: privateAllowed,
    retry: false,
  });
  const handleProductError = useEffectEvent(() => {
    if (products.error) void recovery.refuseAuthRead(products.error, recovery.readFence());
  });
  useEffect(() => {
    handleProductError();
  }, [products.error]);
  const patch = (input: Partial<CampaignInput>) => {
    setRaw((v) => ({ ...v, input: { ...v.input, ...input } }));
    setDirty(true);
    setCurrent(null);
  };
  async function perform(operation: Operation) {
    if (busy) return;
    if (api.durableRecovery) {
      const b = recovery.value().baseline;
      const key = crypto.randomUUID();
      const request =
        operation === 'archive'
          ? { revision: b.revision!, reason: rawRef.current.input.reason }
          : {
              ...rawRef.current.input,
              ...(b.target ? { revision: b.revision! } : { idempotencyKey: key }),
            };
      const ack = await recovery.send(operation, request, b.target, key);
      if (ack) {
        onChanged();
        setNotice(
          'Первісний результат підтверджено. Прочитайте запис окремо; новіші поля збережено.',
        );
      }
    } else {
      setLegacyBusy(true);
      try {
        const pending = legacyIntent.current || {
          input: rawRef.current.input,
          identity: legacyTarget
            ? { id: legacyTarget.id, revision: legacyTarget.revision }
            : { idempotencyKey: crypto.randomUUID() },
          draftKey: JSON.stringify(rawRef.current.input),
        };
        legacyIntent.current = pending;
        const saved =
          operation === 'archive' && legacyTarget
            ? await api.archive(legacyTarget, pending.input.reason)
            : await api.save(pending.input, pending.identity);
        if (live.current) {
          legacyIntent.current = null;
          setLegacyTarget(saved);
          onChanged();
          if (JSON.stringify(rawRef.current.input) === pending.draftKey) {
            setDirty(false);
            onClose();
          } else
            setNotice(
              'Первісну акцію збережено. Нові введені умови лишилися в чернетці; збережіть їх окремо.',
            );
        }
      } catch (error) {
        if (error instanceof Error && 'status' in error && error.status === 409) {
          legacyIntent.current = null;
          setLegacyBlocked(true);
        }
        if (live.current)
          setNotice(error instanceof Error ? error.message : 'Запит не підтверджено.');
      } finally {
        if (live.current) setLegacyBusy(false);
      }
    }
  }
  async function compare() {
    if (busy) return;
    if (!api.durableRecovery) {
      if (!legacyTarget) return;
      setLegacyBusy(true);
      try {
        const c = await api.campaign(legacyTarget.id);
        if (live.current) setCurrent(c);
      } catch (error) {
        if (live.current)
          setNotice(error instanceof Error ? error.message : 'Читання не підтверджено.');
      } finally {
        if (live.current) setLegacyBusy(false);
      }
      return;
    }
    const b = recovery.value(),
      target = b.confirmation?.ack.target || b.baseline.target;
    if (!target) return;
    setCurrent(null);
    setChoices({});
    const value = await recovery.read((signal) =>
      recoveryApi.current(target, signal, recovery.readFence()),
    );
    if (value && recovery.isLive()) setCurrent(value.campaign);
  }
  function apply() {
    if (!current || current.archived || !privateAllowed || busy || recovery.intent) return;
    const value = recovery.value(),
      base = value.baseline.original.input,
      mine = rawRef.current.input,
      server = campaignProjection(current);
    const merged = resolveThreeWay(base, mine, server, campaignFields, choices);
    if (!merged) return;
    const next: Raw = {
      ...rawRef.current,
      input: merged,
      names: {
        ...rawRef.current.names,
        ...Object.fromEntries(current.prices.map((p) => [p.product, p.name])),
      },
    };
    if (
      recovery.adopt(
        {
          target: current.id,
          revision: current.revision,
          archived: current.archived,
          original: { ...next, input: server },
        },
        next,
      )
    ) {
      setRaw(next);
      setCurrent(null);
      setDirty(true);
      setNotice('Узгоджені поля застосовано локально. Збережіть окремою дією.');
    }
  }
  const d = raw.input,
    rows = d.prices,
    blocked =
      busy ||
      !privateAllowed ||
      recovery.blocked ||
      recovery.intent ||
      recovery.confirmed ||
      recovery.value().baseline.archived ||
      current?.archived ||
      legacyBlocked;
  return (
    <section aria-label="Редактор акції">
      {api.durableRecovery ? (
        <RecoveryActions
          recovery={recovery}
          onExact={() =>
            void recovery.exactRetry().then((ack) => {
              if (ack) onChanged();
            })
          }
          onCurrent={() => void compare()}
        />
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      {privateAllowed ? (
        <form
          aria-label="Умови акції"
          aria-busy={busy}
          onSubmit={(e) => {
            e.preventDefault();
            if (!blocked) void perform(recovery.value().baseline.target ? 'update' : 'create');
          }}
        >
          <h3>{recovery.value().baseline.target ? 'Редагування акції' : 'Нова акція'}</h3>
          <div className="tk-promotion-grid">
            <TextField
              label="Назва акції"
              value={d.name}
              onChange={(name) => patch({ name })}
              maxLength={160}
            />
            <TextField
              label="Причина зміни"
              value={d.reason}
              onChange={(reason) => patch({ reason })}
              maxLength={500}
            />
            <DatePicker
              label="Початок акції"
              value={d.startsOn}
              onChange={(startsOn) => patch({ startsOn })}
            />
            <DatePicker
              label="Закінчення акції включно"
              value={d.endsOn}
              onChange={(endsOn) => patch({ endsOn })}
            />
            <Select
              label="Де діє акція"
              value={d.scope}
              options={[
                { id: 'network', label: 'Уся мережа' },
                { id: 'stores', label: 'Обрані магазини' },
              ]}
              onChange={(key) => {
                if (key === 'network' || key === 'stores')
                  patch({ scope: key, stores: key === 'network' ? [] : d.stores });
              }}
            />
            <label className="tk-promotion-check">
              <input
                type="checkbox"
                checked={d.active}
                onChange={(e) => patch({ active: e.target.checked })}
              />
              Акція увімкнена
            </label>
          </div>
          {d.scope === 'stores' ? (
            <fieldset>
              <legend>Магазини акції</legend>
              {context.stores.map((s) => (
                <label key={s.id} className="tk-promotion-check">
                  <input
                    type="checkbox"
                    checked={d.stores.includes(s.id)}
                    onChange={(e) =>
                      patch({
                        stores: e.target.checked
                          ? [...d.stores, s.id]
                          : d.stores.filter((id) => id !== s.id),
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
            selectedKey={selected?.id || null}
            selectedOption={selected ? { id: selected.id, label: selected.name } : null}
            inputValue={raw.search}
            onInputChange={(search) => {
              setRaw((v) => ({ ...v, search }));
              setSelected((p) => (p && p.name === search ? p : null));
            }}
            isLoading={products.isFetching || raw.search !== searchTerm}
            onSelectionChange={(key) => {
              const p = products.data?.items.find((p) => p.id === key);
              if (p) {
                setSelected(p);
                setRaw((v) => ({ ...v, search: p.name }));
              }
            }}
          />
          <Button
            isDisabled={!selected || rows.some((r) => r.product === selected.id)}
            onPress={() => {
              if (!selected) return;
              setRaw((v) => ({
                ...v,
                search: '',
                names: { ...v.names, [selected.id]: selected.name },
                input: {
                  ...v.input,
                  prices: [...v.input.prices, { product: selected.id, price: '' }],
                },
              }));
              setSelected(null);
              setDirty(true);
              setCurrent(null);
            }}
          >
            Додати вибраний товар
          </Button>
          {products.error ? <p role="alert">{products.error.message}</p> : null}
          {rows.map((row) => (
            <div className="tk-promotion-row" key={row.product}>
              <strong>{raw.names[row.product] || row.product}</strong>
              <MoneyField
                label={`Акційна ціна: ${raw.names[row.product] || row.product}`}
                value={row.price}
                onChange={(price) =>
                  patch({
                    prices: rows.map((r) => (r.product === row.product ? { ...r, price } : r)),
                  })
                }
              />
              <Button
                onPress={() => patch({ prices: rows.filter((r) => r.product !== row.product) })}
              >
                Прибрати {raw.names[row.product] || row.product}
              </Button>
            </div>
          ))}
          <div className="tk-promotion-actions">
            <Button
              type="submit"
              variant="primary"
              isDisabled={
                blocked ||
                !d.name.trim() ||
                !d.reason.trim() ||
                !d.startsOn ||
                !d.endsOn ||
                !rows.length
              }
            >
              Зберегти акцію
            </Button>
            {(
              api.durableRecovery
                ? recovery.value().baseline.target && !recovery.intent
                : legacyBlocked
            ) ? (
              <Button isDisabled={busy} onPress={() => void compare()}>
                {api.durableRecovery ? 'Порівняти актуальні умови' : 'Відкрити актуальні умови'}
              </Button>
            ) : null}
            {recovery.value().baseline.target ? (
              <Button
                isDisabled={blocked || !d.reason.trim()}
                onPress={() => {
                  if (confirm('Архівувати акцію? Її історія залишиться доступною.'))
                    void perform('archive');
                }}
              >
                Архівувати акцію
              </Button>
            ) : null}
          </div>
          {current ? (
            <>
              <p>
                {current.archived
                  ? 'Акцію архівовано. Локальні поля збережено; запис лише для читання.'
                  : 'Актуальні умови прочитано без зміни первісної версії.'}
              </p>
              <ConflictComparison
                rows={compareThreeWay(
                  recovery.value().baseline.original.input,
                  raw.input,
                  campaignProjection(current),
                  campaignFields,
                )}
                choices={choices}
                onChoice={(id, choice) => setChoices((v) => ({ ...v, [id]: choice }))}
                onApply={apply}
                onCancel={() => setCurrent(null)}
                isDisabled={busy || current.archived || recovery.intent || !privateAllowed}
              />
            </>
          ) : null}
          <p className="tk-help">
            Дати включні, часовий пояс Київ. Узгодження змінює лише локальну чернетку. Збереження та
            архівування — окремі явні дії.
          </p>
        </form>
      ) : null}
      <div className="tk-promotion-actions">
        <Button
          isDisabled={busy}
          onPress={() => {
            if (
              !dirty ||
              confirm('Закрити редактор? Чернетка залишиться у локальному відновленні.')
            )
              onClose();
          }}
        >
          Закрити чернетку
        </Button>
        {api.durableRecovery ? (
          <Button
            isDisabled={busy}
            onPress={() => {
              if (confirm('Назавжди видалити лише локальну чернетку?')) {
                recovery.discard();
                onClose();
              }
            }}
          >
            Відкинути локальну чернетку
          </Button>
        ) : null}
      </div>
    </section>
  );
}
