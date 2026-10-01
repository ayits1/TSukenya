import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ModalOverlay, Modal, Dialog, Heading, Form, Checkbox } from 'react-aria-components';
import { TextField } from '../../shared/ui/TextField';
import { MoneyField } from '../../shared/ui/MoneyField';
import { Button } from '../../shared/ui/Button';
import { ApiError } from '../../shared/api/client';
import type { CatalogApi, Product, ProductCreate, ProductPatch } from './api';

function initial(product: Product | undefined, markup: string): Required<ProductCreate> {
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
}: {
  product?: Product;
  defaultMarkup: string;
  api: CatalogApi;
  onClose: () => void;
  onSaved: (product: Product) => void;
  onDeleted: () => void;
  onDirty: (dirty: boolean) => void;
}) {
  const [current, setCurrent] = useState(product);
  const [original, setOriginal] = useState(() => initial(product, defaultMarkup));
  const [draft, setDraft] = useState(original);
  const [notice, setNotice] = useState('');
  const dirty = JSON.stringify(original) !== JSON.stringify(draft);
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
      const payload: ProductCreate | ProductPatch = current
        ? { ...draft, revision: current.revision }
        : draft;
      return api.save(payload, current?.id);
    },
    retry: false,
    onSuccess: onSaved,
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
      const value = initial(fresh, defaultMarkup);
      setCurrent(fresh);
      setOriginal(value);
      setDraft(value);
      mutation.reset();
      setNotice('Завантажено актуальний товар. Повторіть потрібні зміни.');
    },
  });
  const close = () => {
    if (mutation.isPending || reload.isPending || deletion.isPending) return;
    if (!dirty || window.confirm('Відкинути незбережені зміни товару?')) onClose();
  };
  const text = (
    key:
      | 'name'
      | 'type'
      | 'category'
      | 'pack'
      | 'size'
      | 'unit'
      | 'barcode'
      | 'cost'
      | 'markup'
      | 'priceAt'
      | 'minStock',
    label: string,
  ) => (
    <TextField
      key={key}
      label={label}
      value={draft[key]}
      onChange={(value) => setDraft((old) => ({ ...old, [key]: value }))}
      isRequired={key === 'name' || key === 'unit'}
      {...(key === 'name' ? { autoFocus: true, maxLength: 250 } : {})}
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
              mutation.mutate();
            }}
          >
            <header>
              <div>
                <Heading slot="title">{current ? 'Редагувати товар' : 'Новий товар'}</Heading>
                <p>Зміни одразу доступні в каталозі та цінниках.</p>
              </div>
              <Button
                aria-label="Закрити редактор"
                onPress={close}
                isDisabled={mutation.isPending || reload.isPending || deletion.isPending}
              >
                Закрити
              </Button>
            </header>
            <fieldset disabled={mutation.isPending || reload.isPending || deletion.isPending}>
              <legend>Товар</legend>
              {text('name', 'Назва товару')}
              <div className="tk-editor-grid">
                {text('type', 'Група')}
                {text('category', 'Категорія')}
                {text('pack', 'Пакування')}
                {text('size', 'Об’єм / вага')}
                {text('unit', 'Одиниця')}
                {text('barcode', 'Штрихкод')}
                {text('minStock', 'Мінімальний залишок')}
              </div>
            </fieldset>
            <fieldset disabled={mutation.isPending || reload.isPending || deletion.isPending}>
              <legend>Ціни та акція</legend>
              <div className="tk-editor-grid">
                {text('cost', 'Закупівля, грн')}
                {text('markup', 'Націнка, %')}
              </div>
              <Checkbox
                className="tk-editor-checkbox"
                isSelected={draft.manualPrice}
                onChange={(value) =>
                  setDraft((old) => ({
                    ...old,
                    manualPrice: value,
                    price: value ? old.price || current?.salePrice || '' : null,
                  }))
                }
              >
                <span aria-hidden="true" className="tk-checkbox-mark" />
                Задати ціну продажу вручну
              </Checkbox>
              {draft.manualPrice ? (
                <MoneyField
                  label="Продаж"
                  value={draft.price || ''}
                  onChange={(price) => setDraft((old) => ({ ...old, price }))}
                  isRequired
                />
              ) : (
                <p className="tk-help">
                  Ціну розрахує сервер із закупівлі, націнки й налаштування округлення.
                </p>
              )}
              <Checkbox
                className="tk-editor-checkbox"
                isSelected={draft.promotion}
                onChange={(promotion) => setDraft((old) => ({ ...old, promotion }))}
              >
                <span aria-hidden="true" className="tk-checkbox-mark" />
                Акція — показувати позначку на ціннику
              </Checkbox>
              {text('priceAt', 'Дата перевірки ціни (РРРР-ММ-ДД)')}
              <Checkbox
                className="tk-editor-checkbox"
                isSelected={draft.priceReviewed}
                onChange={(priceReviewed) => setDraft((old) => ({ ...old, priceReviewed }))}
              >
                <span aria-hidden="true" className="tk-checkbox-mark" />
                Ціну перевірено сьогодні
              </Checkbox>
            </fieldset>
            {mutation.error || reload.error || deletion.error ? (
              <div className="tk-catalog-error" role="alert">
                <p>{mutation.error?.message || reload.error?.message || deletion.error?.message}</p>
                {mutation.error instanceof ApiError && mutation.error.status === 409 ? (
                  <Button onPress={() => reload.mutate()} isDisabled={reload.isPending}>
                    Завантажити актуальний товар
                  </Button>
                ) : null}
              </div>
            ) : null}
            {notice ? <p role="status">{notice}</p> : null}
            <footer>
              {current ? (
                <Button
                  isDisabled={mutation.isPending || deletion.isPending}
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
              <Button
                onPress={close}
                isDisabled={mutation.isPending || reload.isPending || deletion.isPending}
              >
                Скасувати
              </Button>
              <Button
                type="submit"
                variant="primary"
                isDisabled={mutation.isPending || reload.isPending || deletion.isPending}
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
