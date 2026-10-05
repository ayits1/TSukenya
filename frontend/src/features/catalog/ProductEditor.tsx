import { useCatalogRecovery } from './recovery/session';
import { RecoveryActions } from './recovery/RecoveryActions';
import { decodeProductRaw, type CatalogPayload, type ProductRaw } from './recovery/codec';
import type { Acknowledgement } from './recovery/api';
import { referenceQuery, type SelectedReference } from './referenceDirectoryApi';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ModalOverlay, Modal, Dialog, Heading, Form, Checkbox } from 'react-aria-components';
import { TextField } from '../../shared/ui/TextField';
import { MoneyField } from '../../shared/ui/MoneyField';
import { DatePicker, ukraineToday } from '../../shared/ui/DatePicker';
import { CatalogReferenceField } from './CatalogReferenceField';
import { Button } from '../../shared/ui/Button';
import { ApiError } from '../../shared/api/client';
import { ConflictComparison } from '../../shared/ui/ConflictComparison';
import { compareThreeWay, resolveThreeWay } from '../../shared/merge/threeWay';
import type { MergeChoices } from '../../shared/merge/threeWay';
import { productMergeFields } from './productMerge';
import type { ProductDraft } from './productMerge';
import {
  hasEffectivePromotion,
  type CatalogApi,
  type Product,
  type ProductCreate,
  type ProductPatch,
  type ReferenceField,
  type PricePreview,
  type PricePreviewRequest,
  referenceKey,
} from './api';

const referenceLabels: Record<ReferenceField, string> = {
  type: 'Група',
  category: 'Категорія',
  pack: 'Пакування',
  size: 'Об’єм / вага',
  unit: 'Одиниця',
};
const money = (value: string) =>
  Number(value).toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function initial(product: Product | undefined, markup: string): ProductDraft {
  return {
    name: product?.name || '',
    type: product?.type || '',
    category: product?.category || '',
    pack: product?.pack || '',
    size: product?.size || '',
    unit: product?.unit || 'шт',
    barcode: product?.barcode || '',
    cost: product?.cost || '0',
    markup: product?.markup || markup,
    price: product?.price || null,
    manualPrice: product?.manualPrice || false,
    promotion: product?.promotion || false,
    promotionPrice: product?.promotionPrice || null,
    priceAt: product?.priceAt || '',
    priceReviewed: false,
    minStock: product?.minStock || '0',
    expiryAlertDays: product?.expiryAlertDays == null ? '' : String(product.expiryAlertDays),
  };
}
export function ProductEditor({
  product,
  defaultMarkup,
  api,
  onClose,
  onSaved,
  onDirty,
  onDeleted,
  onVisibilityChanged,
  activatePromotion = false,
  deactivatePromotion = false,
  restoredPayload,
}: {
  product?: Product;
  activatePromotion?: boolean;
  deactivatePromotion?: boolean;
  restoredPayload?: CatalogPayload;
  defaultMarkup: string;
  api: CatalogApi;
  onClose: () => void;
  onSaved: (product: Product) => void;
  onDeleted: () => void;
  onVisibilityChanged?: (product: Product) => void;
  onDirty: (dirty: boolean) => void;
}) {
  const [current, setCurrent] = useState(product);
  const [original, setOriginal] = useState(() =>
    restoredPayload
      ? decodeProductRaw(restoredPayload.baseline.original).values
      : initial(product, defaultMarkup),
  );
  const [draft, setDraft] = useState(() => ({
    ...(restoredPayload ? decodeProductRaw(restoredPayload.draft).values : original),
    ...(!restoredPayload
      ? { promotion: deactivatePromotion ? false : original.promotion || activatePromotion }
      : {}),
  }));
  const [visibilityRecovery, setVisibilityRecovery] = useState(false);
  const [notice, setNotice] = useState('');
  const [manualAmount, setManualAmount] = useState(
    restoredPayload ? decodeProductRaw(restoredPayload.draft).manualAmount : product?.price || '',
  );
  const [comparison, setComparison] = useState<{
    base: ProductDraft;
    mine: ProductDraft;
    server: Product;
    choices: MergeChoices;
  } | null>(null);
  const [preview, setPreview] = useState<
    { key: string; value: PricePreview } | { key: string; error: Error } | null
  >(null);
  const [previewRetry, setPreviewRetry] = useState(0);
  const previewSequence = useRef(0);
  const compareButton = useRef<HTMLButtonElement>(null);
  const noticeElement = useRef<HTMLParagraphElement>(null);
  const focusAfterComparison = useRef<'compare' | 'notice' | null>(null);
  const client = useQueryClient();
  const referenceButtons = useRef<Partial<Record<ReferenceField, HTMLButtonElement>>>({});
  const focusAfterCreation = useRef<ReferenceField | null>(null);
  const [creation, setCreation] = useState<{ field: ReferenceField; value: string } | null>(() =>
    restoredPayload ? decodeProductRaw(restoredPayload.draft).creation : null,
  );
  const enabled = api.durableRecovery === true;
  const [restoring, setRestoring] = useState(
    !!restoredPayload?.baseline.target &&
      !restoredPayload.firstIntent &&
      !restoredPayload.confirmation,
  );
  const recordTarget = current?.id || restoredPayload?.baseline.target || null;
  const recordRevision = current?.revision || restoredPayload?.baseline.revision || null;
  const baseline = () => ({
    kind: 'product' as const,
    store: api.priceStore ?? null,
    target: recordTarget,
    revision: recordRevision,
    hidden: current?.hidden ?? restoredPayload?.baseline.hidden ?? false,
    referenceIds: { ...(current?.referenceIds || restoredPayload?.baseline.referenceIds) },
    defaultMarkup,
    original: {
      values: original,
      manualAmount: original.price || '',
      creation: null,
    } as ProductRaw,
  });
  const raw: ProductRaw = { values: draft, manualAmount, creation };
  const recovery = useCatalogRecovery(baseline(), raw, restoredPayload, enabled);
  const currentRead = (id: string) =>
    recovery.read(async (signal) => {
      const fresh = await api.product(id, true, signal);
      if (!fresh.canEdit) throw new ApiError(403, 'Поточні права не дозволяють редагувати товар.');
      return fresh;
    });
  const acknowledged = async (ack: Acknowledgement, exact = false): Promise<Product | null> => {
    if (ack.outcome === 'deleted') {
      if (!exact) {
        recovery.discard();
        onDeleted();
      } else
        setNotice(
          'Первісне видалення підтверджено. Новіші поля залишились у локальній чернетці; товар видалено.',
        );
      return null;
    }
    if (ack.operation === 'reference_create') {
      const confirmation = recovery.value().confirmation!;
      const request = confirmation.envelope.request;
      const field = request.field as ReferenceField;
      const result = await recovery.read(async (signal) => {
        const details = await api.referenceDirectory.details(
          [
            {
              id: ack.target!,
              field,
              value: String(request.value),
              ...(field === 'category' ? { parentType: String(request.parentType || '') } : {}),
            },
          ],
          signal,
        );
        const item = details.items[0]?.item;
        if (!details.canEdit || !item || item.id !== ack.target)
          throw new Error('Підтверджений запис довідника не доступний для вибору.');
        return item;
      });
      if (result) {
        if (exact) {
          setNotice(
            `Первісний запис «${result.value}» створено. Новіші поля збережено. Щоб вибрати його, натисніть «Використати підтверджений запис довідника».`,
          );
        } else selectConfirmedReference(result.field, result.value);
      }
      return null;
    }
    const fresh = await currentRead(ack.target!);
    if (fresh && ack.operation === 'product_visibility') onVisibilityChanged?.(fresh);
    if (fresh && exact) {
      setComparison({ base: original, mine: draft, server: fresh, choices: {} });
      setNotice(
        'Первісну дію підтверджено. Актуальні поля доступні лише для порівняння; застосуйте їх локально перед окремим збереженням.',
      );
    }
    return fresh;
  };
  const selectConfirmedReference = (field: ReferenceField, value: string) => {
    const values = {
      ...draft,
      [field]: value,
      ...(field === 'type' && referenceKey(value) !== referenceKey(draft.type)
        ? { category: '' }
        : {}),
    };
    const next = { values, manualAmount, creation: null };
    if (!recovery.adopt(baseline(), next)) return;
    setDraft(values);
    setCreation(null);
    setNotice(`Вибрано підтверджений запис: ${value}`);
    focusReference(field);
    void client.invalidateQueries({ queryKey: ['catalog-reference-details'] });
  };
  const exactRetry = async () => {
    const ack = await recovery.exactRetry();
    if (ack) await acknowledged(ack, true);
  };
  const confirmedRead = async () => {
    const confirmation = recovery.value().confirmation;
    if (confirmation) await acknowledged(confirmation.ack, true);
  };
  const restoreRecord = useEffectEvent(() => {
    const stored = recovery.value(),
      id =
        stored.confirmation?.ack.operation === 'reference_create'
          ? stored.baseline.target
          : stored.confirmation?.ack.target || stored.baseline.target;
    if (!id) return;
    void currentRead(id).then((fresh) => {
      if (!fresh) return;
      const old = stored.baseline;
      const originalTerms = decodeProductRaw(old.original).values;
      const { expiryAlertDays: threshold, ...terms } = originalTerms;
      setCurrent(
        old.target
          ? {
              ...fresh,
              ...terms,
              expiryAlertDays: threshold === '' ? null : Number(threshold),
              id: old.target,
              revision: old.revision!,
              hidden: old.hidden,
              referenceIds: old.referenceIds,
            }
          : fresh,
      );
      setComparison({
        base: decodeProductRaw(old.original).values,
        mine: decodeProductRaw(stored.draft).values,
        server: fresh,
        choices: {},
      });
      setRestoring(false);
      setNotice(
        'Відновлено саме локальні поля. Актуальна версія відкрита для порівняння, без автоматичного збереження.',
      );
    });
  });
  useEffect(() => {
    if (restoring && recovery.private && !recovery.busy) restoreRecord();
  }, [restoring, recovery.private, recovery.busy]);
  const selectedReferences: SelectedReference[] = (
    ['type', 'category', 'pack', 'size', 'unit'] as const
  ).map((field) => ({
    field,
    value: draft[field],
    ...(field === 'category' ? { parentType: draft.type } : {}),
    ...((current?.referenceIds || restoredPayload?.baseline.referenceIds)?.[field] &&
    referenceKey(current?.[field] ?? original[field]) === referenceKey(draft[field]) &&
    (field !== 'category' ||
      referenceKey(current?.type ?? original.type) === referenceKey(draft.type))
      ? { id: (current?.referenceIds || restoredPayload!.baseline.referenceIds)![field]! }
      : {}),
  }));
  const references = useQuery({
    queryKey: ['catalog-reference-details', selectedReferences],
    queryFn: ({ signal }) => api.referenceDirectory.details(selectedReferences, signal),
    retry: false,
    staleTime: 0,
  });
  const metadata = (field: ReferenceField) =>
    references.data?.items.find((row) => row.selected.field === field)?.item || null;
  const chooseReference = (field: ReferenceField, value: string) => {
    setDraft((old) => ({
      ...old,
      [field]: value,
      ...(field === 'type' && referenceKey(value) !== referenceKey(old.type)
        ? { category: '' }
        : {}),
    }));
  };
  const focusReference = (field: ReferenceField) => {
    focusAfterCreation.current = field;
  };
  const addReference = useMutation({
    mutationFn: async () => {
      if (!creation) throw new Error('Виберіть довідник для додавання.');
      const body = {
        field: creation.field,
        value: creation.value,
        ...(creation.field === 'category' ? { parentType: draft.type } : {}),
      };
      if (!enabled) return api.createReference(body);
      const ack = await recovery.send('reference_create', body, null);
      if (ack) await acknowledged(ack);
      return null;
    },
    retry: false,
    onSuccess: (item) => {
      if (!item) return;
      chooseReference(item.field, item.value);
      setCreation(null);
      setNotice(`Вибрано з довідника: ${item.value}`);
      void client.invalidateQueries({ queryKey: ['catalog-reference-details'] });
      focusReference(item.field);
    },
  });
  const dirty = JSON.stringify(original) !== JSON.stringify(draft) || !!creation?.value;
  useEffect(() => {
    onDirty(dirty);
    return () => onDirty(false);
  }, [dirty, onDirty]);
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty]);
  const mutation = useMutation({
    mutationFn: async () => {
      if (!activePreview || comparison || visibilityRecovery || (current && !current.canEdit))
        throw new Error('Дочекайтеся актуального розрахунку ціни та узгодьте зміни.');
      const rawThreshold = draft.expiryAlertDays.trim();
      if (rawThreshold && (!/^\d+$/.test(rawThreshold) || Number(rawThreshold) > 3650))
        throw new Error(
          'Поріг придатності: ціле число днів від 0 до 3650 або порожнє поле для типових 7 днів.',
        );
      const expiryAlertDays = rawThreshold === '' ? null : Number(rawThreshold);
      const values = { ...draft, expiryAlertDays };
      const payload: ProductCreate | ProductPatch = recordTarget
        ? { ...values, revision: recordRevision!, pricingRevision: activePreview.pricingRevision }
        : { ...values, pricingRevision: activePreview.pricingRevision };
      if (!enabled) return api.save(payload, current?.id);
      const ack = await recovery.send(
        recordTarget ? 'product_update' : 'product_create',
        payload,
        recordTarget,
      );
      return ack ? acknowledged(ack) : null;
    },
    retry: false,
    onSuccess: (saved) => {
      if (saved && (!enabled || recovery.isLive())) {
        if (enabled) recovery.discard();
        onSaved(saved);
      }
    },
  });
  const deletion = useMutation({
    mutationFn: async () => {
      if (!enabled) return api.remove(current!);
      const ack = await recovery.send(
        'product_delete',
        { revision: current!.revision },
        current!.id,
      );
      if (ack) await acknowledged(ack);
      return false;
    },
    retry: false,
    onSuccess: (deleted) => {
      if (deleted) onDeleted();
    },
  });
  const visibility = useMutation({
    mutationFn: async (intent: { product: Product; hidden: boolean }) => {
      if (!enabled) return api.visibility(intent.product, intent.hidden);
      const ack = await recovery.send(
        'product_visibility',
        { revision: intent.product.revision, hidden: intent.hidden },
        intent.product.id,
      );
      if (ack) await acknowledged(ack, true);
      return null;
    },
    retry: false,
    onSuccess: (saved) => {
      if (!saved) return;
      setCurrent(saved);
      setOriginal(initial(saved, defaultMarkup));
      setNotice(
        saved.hidden
          ? 'Товар приховано. Незбережені поля залишилися в чернетці.'
          : 'Товар відновлено. Незбережені поля залишилися в чернетці.',
      );
      onVisibilityChanged?.(saved);
    },
    onError: () => setVisibilityRecovery(true),
  });
  const reload = useMutation({
    mutationFn: () =>
      enabled ? currentRead(current?.id || '') : api.product(current?.id || '', true),
    retry: false,
    onSuccess: (fresh) => {
      if (!fresh) return;
      if (!fresh.canEdit) {
        setVisibilityRecovery(true);
        setNotice('Поточні права не дозволяють редагувати товар. Чернетку збережено.');
        return;
      }
      setComparison({ base: original, mine: draft, server: fresh, choices: {} });
      setNotice('Актуальну версію завантажено для порівняння. Чернетку збережено.');
    },
  });
  const close = () => {
    if (
      mutation.isPending ||
      reload.isPending ||
      deletion.isPending ||
      addReference.isPending ||
      visibility.isPending ||
      (enabled && recovery.busy)
    )
      return;
    if (comparison) {
      focusAfterComparison.current = 'compare';
      setComparison(null);
      return;
    }
    if (enabled) {
      onClose();
      return;
    }
    if (!dirty || window.confirm('Відкинути незбережені зміни товару?')) onClose();
  };
  const text = (key: 'name' | 'barcode' | 'markup' | 'minStock', label: string) => (
    <TextField
      key={key}
      label={label}
      value={draft[key]}
      onChange={(value) => setDraft((old) => ({ ...old, [key]: value }))}
      isRequired={key === 'name'}
      {...(key === 'name' ? { autoFocus: true, maxLength: 250 } : {})}
    />
  );
  const networkBusy =
    mutation.isPending ||
    reload.isPending ||
    deletion.isPending ||
    addReference.isPending ||
    visibility.isPending ||
    (enabled && recovery.busy);
  const referenceBusy =
    networkBusy || !!comparison || (enabled && (!recovery.private || restoring));
  const previewInput: PricePreviewRequest = {
    ...(recordTarget ? { id: recordTarget, revision: recordRevision! } : {}),
    cost: draft.cost,
    markup: draft.markup,
    manualPrice: draft.manualPrice,
    price: draft.price,
    promotion: draft.promotion,
    promotionPrice: draft.promotionPrice,
    priceReviewed: draft.priceReviewed,
  };
  const previewKey = JSON.stringify(previewInput);
  const activePreview = preview?.key === previewKey && 'value' in preview ? preview.value : null;
  const previewError = preview?.key === previewKey && 'error' in preview ? preview.error : null;
  useEffect(() => {
    const token = ++previewSequence.current,
      controller = new AbortController();
    const timer = setTimeout(() => {
      void api.previewPrice(JSON.parse(previewKey), controller.signal).then(
        (value) => {
          if (!controller.signal.aborted && token === previewSequence.current)
            setPreview({ key: previewKey, value });
        },
        (cause: unknown) => {
          if (!controller.signal.aborted && token === previewSequence.current)
            setPreview({
              key: previewKey,
              error:
                cause instanceof Error
                  ? cause
                  : new Error('Не вдалося розрахувати ціну. Спробуйте ще раз.'),
            });
        },
      );
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [api, previewKey, previewRetry]);
  const comparisonRows = comparison
    ? compareThreeWay(
        comparison.base,
        comparison.mine,
        initial(comparison.server, defaultMarkup),
        productMergeFields,
      )
    : [];
  const applyComparison = () => {
    if (!comparison || networkBusy || (enabled && recovery.intent)) return;
    const fresh = initial(comparison.server, defaultMarkup);
    const merged = resolveThreeWay(
      comparison.base,
      comparison.mine,
      fresh,
      productMergeFields,
      comparison.choices,
    );
    if (!merged) return;
    if (
      enabled &&
      !recovery.adopt(
        {
          ...baseline(),
          target: comparison.server.id,
          revision: comparison.server.revision,
          hidden: comparison.server.hidden,
          referenceIds: { ...comparison.server.referenceIds },
          original: { values: fresh, manualAmount: fresh.price || '', creation: null },
        },
        { values: merged, manualAmount: merged.price || '', creation: null },
      )
    )
      return;
    setCurrent(comparison.server);
    setOriginal(fresh);
    setDraft(merged);
    setManualAmount(merged.price || '');
    focusAfterComparison.current = 'notice';
    setComparison(null);
    mutation.reset();
    reload.reset();
    visibility.reset();
    deletion.reset();
    setVisibilityRecovery(false);
    setNotice('Узгоджені зміни перенесено в чернетку. Перевірте їх і збережіть товар.');
  };
  const revisionConflict = (error: unknown) =>
    error instanceof ApiError && error.status === 409 && error.code === 'revision_conflict';
  useEffect(() => {
    if (comparison || !focusAfterComparison.current) return;
    const target = focusAfterComparison.current;
    focusAfterComparison.current = null;
    const frame = requestAnimationFrame(() =>
      (target === 'compare' ? compareButton.current : noticeElement.current)?.focus(),
    );
    return () => cancelAnimationFrame(frame);
  }, [comparison]);
  useEffect(() => {
    if (!referenceBusy && !creation && focusAfterCreation.current) {
      const button = referenceButtons.current[focusAfterCreation.current];
      if (button && !button.disabled) {
        button.focus();
        focusAfterCreation.current = null;
      }
    }
  }, [
    referenceBusy,
    creation,
    references.isPending,
    references.isFetching,
    references.data,
    references.error,
  ]);
  const archivedSelection = (field: ReferenceField) => metadata(field)?.state === 'archived';
  const archivedNewValue =
    !current && (['type', 'category', 'pack', 'size', 'unit'] as const).some(archivedSelection);
  const reference = (field: ReferenceField) => (
    <CatalogReferenceField
      label={referenceLabels[field]}
      archived={archivedSelection(field)}
      value={draft[field]}
      api={api.referenceDirectory}
      selected={metadata(field)}
      query={referenceQuery(
        field,
        field === 'category'
          ? {
              parentId: metadata('type')?.id || null,
              parentType: metadata('type') ? null : draft.type,
            }
          : {},
      )}
      onChange={(value) => chooseReference(field, value)}
      addButtonRef={(button) => {
        if (button) referenceButtons.current[field] = button;
      }}
      isRequired={field === 'unit'}
      isDisabled={
        referenceBusy ||
        references.isPending ||
        !!references.error ||
        !!creation ||
        (field === 'category' && !draft.type)
      }
      canAdd={
        !!references.data?.canEdit &&
        !referenceBusy &&
        !references.error &&
        !creation &&
        (field !== 'category' || metadata('type')?.state === 'active')
      }
      {...(selectedReferences.find((row) => row.field === field)?.id &&
      !metadata(field) &&
      !references.isPending
        ? {
            description:
              'ID цього збереженого значення не знайдено. Це не означає архівування; виберіть чинний запис перед зміною.',
          }
        : field === 'category'
          ? {
              description: draft.type
                ? `Категорії групи «${draft.type}»`
                : 'Спочатку виберіть групу',
            }
          : {})}
      onAdd={() => {
        addReference.reset();
        setCreation({ field, value: '' });
      }}
      {...(creation?.field === field
        ? {
            creation: {
              value: creation.value,
              error: addReference.error?.message || '',
              pending: addReference.isPending,
              onChange: (value: string) => {
                addReference.reset();
                setCreation({ field, value });
              },
              onSave: () => addReference.mutate(),
              onCancel: () => {
                setCreation(null);
                addReference.reset();
                focusReference(field);
              },
            },
          }
        : {})}
    />
  );
  return (
    <ModalOverlay
      className="tk-editor-overlay"
      isOpen
      isDismissable
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <Modal className="tk-editor-modal">
        <Dialog className="tk-editor-dialog">
          {enabled ? (
            <RecoveryActions
              recovery={recovery}
              onCurrent={() => void confirmedRead()}
              onExact={() => void exactRetry()}
            />
          ) : null}
          {!enabled || recovery.private ? (
            <Form
              onSubmit={(event) => {
                event.preventDefault();
                if (
                  referenceBusy ||
                  creation ||
                  !references.data ||
                  references.error ||
                  !activePreview ||
                  archivedNewValue ||
                  visibilityRecovery ||
                  (enabled &&
                    (recovery.intent || recovery.confirmed || recovery.blocked || restoring)) ||
                  !references.data?.canEdit ||
                  !!(current && !current.canEdit)
                )
                  return;
                mutation.mutate();
              }}
            >
              <header>
                <div>
                  <Heading slot="title">{current ? 'Редагувати товар' : 'Новий товар'}</Heading>
                  <p>
                    {current?.hidden
                      ? 'Прихований товар — недоступний для вибору цінників і переоцінки.'
                      : 'Зміни одразу доступні в каталозі та цінниках.'}
                  </p>
                </div>
                <Button aria-label="Закрити редактор" onPress={close} isDisabled={referenceBusy}>
                  Закрити
                </Button>
              </header>
              {enabled &&
              recovery.confirmed &&
              recovery.value().confirmation?.ack.operation === 'reference_create' ? (
                <Button
                  type="button"
                  isDisabled={recovery.busy}
                  onPress={() => {
                    const c = recovery.value().confirmation!;
                    void recovery
                      .read(async (signal) => {
                        const r = c.envelope.request;
                        const details = await api.referenceDirectory.details(
                          [
                            {
                              id: c.ack.target!,
                              field: r.field as ReferenceField,
                              value: String(r.value),
                              ...(r.field === 'category'
                                ? { parentType: String(r.parentType || '') }
                                : {}),
                            },
                          ],
                          signal,
                        );
                        const item = details.items[0]?.item;
                        if (!details.canEdit || item?.id !== c.ack.target)
                          throw Error('Підтверджений запис недоступний.');
                        return item;
                      })
                      .then((item) => {
                        if (item) selectConfirmedReference(item.field, item.value);
                      });
                  }}
                >
                  Використати підтверджений запис довідника
                </Button>
              ) : null}
              {enabled && current && !recovery.intent ? (
                <Button
                  ref={compareButton}
                  type="button"
                  isDisabled={networkBusy || (enabled && (recovery.intent || recovery.confirmed))}
                  onPress={() => reload.mutate()}
                >
                  Порівняти актуальні зміни
                </Button>
              ) : null}
              <fieldset disabled={referenceBusy}>
                <legend>Товар</legend>
                {text('name', 'Назва товару')}
                {references.isPending ? <p role="status">Завантажуємо довідники…</p> : null}
                {references.error ? (
                  <div className="tk-catalog-error" role="alert">
                    <p>{references.error.message}</p>
                    <Button
                      onPress={() => {
                        void references.refetch();
                      }}
                    >
                      Завантажити довідники повторно
                    </Button>
                  </div>
                ) : null}
                <div className="tk-editor-grid">
                  {reference('type')}
                  {reference('category')}
                  {reference('pack')}
                  {reference('size')}
                  {reference('unit')}
                  {text('barcode', 'Штрихкод')}
                  {text('minStock', 'Мінімальний залишок')}
                  <TextField
                    label="Сповіщення про придатність, днів"
                    inputMode="numeric"
                    value={draft.expiryAlertDays}
                    onChange={(value) => setDraft((old) => ({ ...old, expiryAlertDays: value }))}
                    description="Порожньо — типовий поріг 7 днів. 0 — дата придатності; прострочені партії включаються завжди."
                  />
                </div>
              </fieldset>
              <fieldset disabled={referenceBusy}>
                <legend>Ціни та акція</legend>
                <div className="tk-editor-grid">
                  <MoneyField
                    label="Закупівля"
                    value={draft.cost}
                    onChange={(cost) => setDraft((old) => ({ ...old, cost }))}
                  />
                  {text('markup', 'Націнка, %')}
                </div>
                <Checkbox
                  className="tk-editor-checkbox"
                  isSelected={draft.manualPrice}
                  isDisabled={!draft.manualPrice && !manualAmount && !activePreview}
                  onChange={(value) => {
                    const amount = manualAmount || activePreview?.regularPrice || '';
                    if (value) setManualAmount(amount);
                    setDraft((old) => ({
                      ...old,
                      manualPrice: value,
                      price: value ? amount : null,
                    }));
                  }}
                >
                  <span aria-hidden="true" className="tk-checkbox-mark" />
                  Задати ціну продажу вручну
                </Checkbox>
                {draft.manualPrice ? (
                  <MoneyField
                    label="Звичайна ціна"
                    value={draft.price || ''}
                    onChange={(price) => {
                      setManualAmount(price);
                      setDraft((old) => ({ ...old, price }));
                    }}
                    isRequired
                  />
                ) : (
                  <div className="tk-editor-regular-price">
                    {current ? (
                      <p>
                        Збережена звичайна ціна:{' '}
                        <strong>
                          {Number(current.regularPrice).toLocaleString('uk-UA', {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })}{' '}
                          грн
                        </strong>
                      </p>
                    ) : null}
                    <p className="tk-help">
                      Звичайна ціна розраховується із закупівлі, націнки й округлення. Акційна ціна
                      її не замінює.
                    </p>
                  </div>
                )}
                <Checkbox
                  className="tk-editor-checkbox"
                  isSelected={draft.promotion}
                  onChange={(promotion) => setDraft((old) => ({ ...old, promotion }))}
                >
                  <span aria-hidden="true" className="tk-checkbox-mark" />
                  Акція — окрема ціна та позначка на ціннику
                </Checkbox>
                {draft.promotion ? (
                  <div className="tk-editor-promotion-price">
                    <MoneyField
                      label="Акційна ціна"
                      value={draft.promotionPrice || ''}
                      onChange={(promotionPrice) => setDraft((old) => ({ ...old, promotionPrice }))}
                      isRequired
                    />
                    <p className="tk-help">
                      Має бути меншою за звичайну ціну. Під час акції продаж і цінник використовують
                      цю суму; звичайна ціна зберігається.
                    </p>
                    {current?.promotion && current.promotionPrice === null ? (
                      <p className="tk-error">
                        Для цієї акції ще не задано окрему ціну. Вкажіть її перед збереженням.
                      </p>
                    ) : current?.promotion && !hasEffectivePromotion(current) ? (
                      <p className="tk-error">
                        Збережена акційна ціна більше не є дійсною знижкою. Змініть її або вимкніть
                        акцію.
                      </p>
                    ) : null}
                  </div>
                ) : null}
                <DatePicker
                  label="Дата перевірки ціни"
                  value={draft.priceAt}
                  maxValue={ukraineToday()}
                  isDisabled={mutation.isPending || reload.isPending || deletion.isPending}
                  onChange={(priceAt) =>
                    setDraft((old) => ({ ...old, priceAt, priceReviewed: false }))
                  }
                />
                <Checkbox
                  className="tk-editor-checkbox"
                  isSelected={draft.priceReviewed}
                  onChange={(priceReviewed) => setDraft((old) => ({ ...old, priceReviewed }))}
                >
                  <span aria-hidden="true" className="tk-checkbox-mark" />
                  Ціну перевірено сьогодні
                </Checkbox>
                <div
                  className="tk-editor-price-preview"
                  aria-busy={!activePreview && !previewError}
                  aria-live="polite"
                  aria-atomic="true"
                >
                  {activePreview ? (
                    <>
                      <p>
                        Звичайна ціна після збереження:{' '}
                        <strong>{money(activePreview.regularPrice)} грн</strong>
                      </p>
                      <p>
                        Ціна продажу: <strong>{money(activePreview.salePrice)} грн</strong>
                      </p>
                      {activePreview.effectivePromotion?.source === 'campaign' ? (
                        <p className="tk-help">
                          Кампанія «{activePreview.effectivePromotion.name}» діє{' '}
                          {activePreview.effectivePromotion.startsOn} —{' '}
                          {activePreview.effectivePromotion.endsOn}, для{' '}
                          {activePreview.priceContext?.storeName || 'мережі'}. Її умови змінюються в
                          розділі акцій; збереження товару не переносить їх у його власну акцію.
                        </p>
                      ) : null}
                      <p className="tk-help">
                        {draft.manualPrice
                          ? 'Ручна ціна — без округлення до кроку.'
                          : `Закупівля × (1 + націнка / 100), округлення вгору до ${money(activePreview.config.rounding)} грн.`}{' '}
                        Під час акції стара ціна на ціннику — звичайна ціна перед знижкою.
                      </p>
                      {activePreview.warnings.map((warning) => (
                        <p className="tk-error" key={warning}>
                          {warning}
                        </p>
                      ))}
                    </>
                  ) : previewError ? (
                    <div role="alert">
                      <p className="tk-error">{previewError.message}</p>
                      <Button
                        type="button"
                        onPress={() => {
                          setPreview(null);
                          setPreviewRetry((old) => old + 1);
                        }}
                        isDisabled={referenceBusy}
                      >
                        Повторити розрахунок ціни
                      </Button>
                    </div>
                  ) : (
                    <p>Розраховуємо актуальну ціну…</p>
                  )}
                </div>
              </fieldset>
              {mutation.error || reload.error || deletion.error || visibility.error ? (
                <div className="tk-catalog-error" role="alert">
                  <p>
                    {reload.error?.message ||
                      mutation.error?.message ||
                      deletion.error?.message ||
                      visibility.error?.message}
                  </p>
                  {mutation.error instanceof ApiError &&
                  mutation.error.code === 'pricing_revision_conflict' ? (
                    <Button
                      type="button"
                      onPress={() => {
                        mutation.reset();
                        setPreview(null);
                        setPreviewRetry((old) => old + 1);
                      }}
                      isDisabled={referenceBusy}
                    >
                      Оновити розрахунок ціни
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {!enabled &&
              (visibilityRecovery ||
                revisionConflict(mutation.error) ||
                revisionConflict(previewError) ||
                revisionConflict(deletion.error)) &&
              current &&
              !comparison ? (
                <Button
                  type="button"
                  ref={compareButton}
                  onPress={() => reload.mutate()}
                  isDisabled={networkBusy || (enabled && (recovery.intent || recovery.confirmed))}
                >
                  {reload.isPending ? 'Завантажуємо версії…' : 'Порівняти зміни'}
                </Button>
              ) : null}
              {comparison ? (
                <>
                  <p>
                    Поточний стан на сервері: {comparison.server.hidden ? 'прихований' : 'активний'}
                    . Застосування змін оновлює лише чернетку; приховування чи відновлення
                    виконується окремою кнопкою.
                  </p>
                  <ConflictComparison
                    rows={comparisonRows}
                    choices={comparison.choices}
                    onChoice={(id, choice) =>
                      setComparison((old) =>
                        old ? { ...old, choices: { ...old.choices, [id]: choice } } : old,
                      )
                    }
                    onApply={applyComparison}
                    onCancel={() => {
                      focusAfterComparison.current = 'compare';
                      setComparison(null);
                    }}
                    isDisabled={networkBusy || (enabled && recovery.intent)}
                  />
                </>
              ) : null}
              {notice ? (
                <p role="status" ref={noticeElement} tabIndex={-1}>
                  {notice}
                </p>
              ) : null}
              <footer>
                {current ? (
                  <Button
                    type="button"
                    isDisabled={
                      referenceBusy ||
                      visibilityRecovery ||
                      !current.canEdit ||
                      (enabled && (recovery.intent || recovery.confirmed))
                    }
                    onPress={() => {
                      if (
                        window.confirm(
                          current.hidden
                            ? 'Відновити товар у каталозі? Незбережені поля не записуватимуться.'
                            : 'Приховати товар із каталогу та вибору цінників? Незбережені поля не записуватимуться.',
                        )
                      )
                        visibility.mutate({ product: current, hidden: !current.hidden });
                    }}
                  >
                    {current.hidden ? 'Відновити товар' : 'Приховати товар'}
                  </Button>
                ) : null}
                {current ? (
                  <Button
                    isDisabled={
                      referenceBusy ||
                      visibilityRecovery ||
                      !current.canEdit ||
                      (enabled && (recovery.intent || recovery.confirmed))
                    }
                    onPress={() => {
                      if (
                        window.confirm(
                          'Видалити цей товар? Товари, використані в обліку або рецептурі, видалити не можна.',
                        )
                      )
                        deletion.mutate();
                    }}
                  >
                    Видалити товар
                  </Button>
                ) : null}
                <Button onPress={close} isDisabled={referenceBusy}>
                  Скасувати
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  isDisabled={
                    referenceBusy ||
                    !!creation ||
                    references.isPending ||
                    !!references.error ||
                    !activePreview ||
                    archivedNewValue ||
                    visibilityRecovery ||
                    (enabled &&
                      (recovery.intent || recovery.confirmed || recovery.blocked || restoring)) ||
                    !references.data?.canEdit ||
                    !!(current && !current.canEdit)
                  }
                >
                  {mutation.isPending ? 'Зберігаємо…' : 'Зберегти товар'}
                </Button>
              </footer>
            </Form>
          ) : (
            <>
              <Heading slot="title">Чернетка каталогу</Heading>
              <Button type="button" onPress={onClose}>
                Закрити редактор
              </Button>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
