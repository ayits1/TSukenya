import { useEffect, useRef, useState } from 'react';
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
  type ReferenceData,
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
  activatePromotion = false,
}: {
  product?: Product;
  activatePromotion?: boolean;
  defaultMarkup: string;
  api: CatalogApi;
  onClose: () => void;
  onSaved: (product: Product) => void;
  onDeleted: () => void;
  onDirty: (dirty: boolean) => void;
}) {
  const [current, setCurrent] = useState(product);
  const [original, setOriginal] = useState(() => initial(product, defaultMarkup));
  const [draft, setDraft] = useState(() => ({
    ...original,
    promotion: original.promotion || activatePromotion,
  }));
  const [notice, setNotice] = useState('');
  const [manualAmount, setManualAmount] = useState(product?.price || '');
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
  const [creation, setCreation] = useState<{ field: ReferenceField; value: string } | null>(null);
  const references = useQuery({
    queryKey: ['catalog-references'],
    queryFn: ({ signal }) => api.references(signal),
    staleTime: 15_000,
    retry: false,
  });
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
    mutationFn: () => {
      if (!creation) throw new Error('Виберіть довідник для додавання.');
      return api.createReference({
        field: creation.field,
        value: creation.value,
        ...(creation.field === 'category' ? { parentType: draft.type } : {}),
      });
    },
    retry: false,
    onSuccess: (item) => {
      client.setQueryData<ReferenceData>(['catalog-references'], (data) =>
        data
          ? {
              ...data,
              items: [...data.items.filter((old) => old.id !== item.id), item],
            }
          : data,
      );
      chooseReference(item.field, item.value);
      setCreation(null);
      setNotice(`Вибрано з довідника: ${item.value}`);
      void client.invalidateQueries({ queryKey: ['catalog-references'] });
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
    mutationFn: () => {
      if (!activePreview || comparison)
        throw new Error('Дочекайтеся актуального розрахунку ціни та узгодьте зміни.');
      const payload: ProductCreate | ProductPatch = current
        ? { ...draft, revision: current.revision, pricingRevision: activePreview.pricingRevision }
        : { ...draft, pricingRevision: activePreview.pricingRevision };
      return api.save(payload, current?.id);
    },
    retry: false,
    onSuccess: (saved) => onSaved(saved),
  });
  const deletion = useMutation({
    mutationFn: () => api.remove(current!),
    retry: false,
    onSuccess: onDeleted,
  });
  const reload = useMutation({
    mutationFn: () => api.product(current?.id || ''),
    retry: false,
    onSuccess: (fresh) => {
      setComparison({ base: original, mine: draft, server: fresh, choices: {} });
      setNotice('Актуальну версію завантажено для порівняння. Чернетку збережено.');
    },
  });
  const close = () => {
    if (mutation.isPending || reload.isPending || deletion.isPending || addReference.isPending)
      return;
    if (comparison) {
      focusAfterComparison.current = 'compare';
      setComparison(null);
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
    mutation.isPending || reload.isPending || deletion.isPending || addReference.isPending;
  const referenceBusy = networkBusy || !!comparison;
  const previewInput: PricePreviewRequest = {
    ...(current ? { id: current.id, revision: current.revision } : {}),
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
    if (!comparison || networkBusy) return;
    const fresh = initial(comparison.server, defaultMarkup);
    const merged = resolveThreeWay(
      comparison.base,
      comparison.mine,
      fresh,
      productMergeFields,
      comparison.choices,
    );
    if (!merged) return;
    setCurrent(comparison.server);
    setOriginal(fresh);
    setDraft(merged);
    setManualAmount(merged.price || '');
    focusAfterComparison.current = 'notice';
    setComparison(null);
    mutation.reset();
    reload.reset();
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
      referenceButtons.current[focusAfterCreation.current]?.focus();
      focusAfterCreation.current = null;
    }
  }, [referenceBusy, creation]);
  const archivedSelection = (field: ReferenceField) =>
    (references.data?.archivedItems || []).some(
      (item) =>
        item.field === field &&
        referenceKey(item.value) === referenceKey(draft[field]) &&
        (field !== 'category' || referenceKey(item.parentType) === referenceKey(draft.type)) &&
        (!current?.referenceIds?.[field] || current.referenceIds[field] === item.id),
    );
  const archivedNewValue =
    !current && (['type', 'category', 'pack', 'size', 'unit'] as const).some(archivedSelection);
  const reference = (field: ReferenceField) => (
    <CatalogReferenceField
      label={referenceLabels[field]}
      archived={archivedSelection(field)}
      value={draft[field]}
      options={(references.data?.items || []).filter(
        (item) =>
          item.field === field &&
          (field !== 'category' || referenceKey(item.parentType) === referenceKey(draft.type)),
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
        (field !== 'category' ||
          !!references.data?.items.some(
            (item) =>
              item.field === 'type' && referenceKey(item.value) === referenceKey(draft.type),
          ))
      }
      {...(field === 'category'
        ? {
            description: draft.type ? `Категорії групи «${draft.type}»` : 'Спочатку виберіть групу',
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
          <Form
            onSubmit={(event) => {
              event.preventDefault();
              if (
                referenceBusy ||
                creation ||
                !references.data ||
                references.error ||
                !activePreview ||
                archivedNewValue
              )
                return;
              mutation.mutate();
            }}
          >
            <header>
              <div>
                <Heading slot="title">{current ? 'Редагувати товар' : 'Новий товар'}</Heading>
                <p>Зміни одразу доступні в каталозі та цінниках.</p>
              </div>
              <Button aria-label="Закрити редактор" onPress={close} isDisabled={referenceBusy}>
                Закрити
              </Button>
            </header>
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
                    Звичайна ціна розраховується із закупівлі, націнки й округлення. Акційна ціна її
                    не замінює.
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
            {mutation.error || reload.error || deletion.error ? (
              <div className="tk-catalog-error" role="alert">
                <p>{mutation.error?.message || reload.error?.message || deletion.error?.message}</p>
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
            {(revisionConflict(mutation.error) ||
              revisionConflict(previewError) ||
              revisionConflict(deletion.error)) &&
            current &&
            !comparison ? (
              <Button
                type="button"
                ref={compareButton}
                onPress={() => reload.mutate()}
                isDisabled={networkBusy}
              >
                {reload.isPending ? 'Завантажуємо версії…' : 'Порівняти зміни'}
              </Button>
            ) : null}
            {comparison ? (
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
                isDisabled={networkBusy}
              />
            ) : null}
            {notice ? (
              <p role="status" ref={noticeElement} tabIndex={-1}>
                {notice}
              </p>
            ) : null}
            <footer>
              {current ? (
                <Button
                  isDisabled={referenceBusy}
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
                  archivedNewValue
                }
              >
                {mutation.isPending ? 'Зберігаємо…' : 'Зберегти товар'}
              </Button>
            </footer>
          </Form>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
