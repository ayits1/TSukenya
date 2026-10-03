import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ModalOverlay, Modal, Dialog, Heading } from 'react-aria-components';
import { Button } from '../../shared/ui/Button';
import { Select } from '../../shared/ui/Select';
import { TextField } from '../../shared/ui/TextField';
import { ApiError } from '../../shared/api/client';
import { referenceFields, referenceKey, type ReferenceField } from './api';
import {
  createReferenceManagementApi,
  type ReferenceManagementApi,
  type ReferenceMutation,
  type ReferenceCommit,
  type ReferenceImpact,
  type ManagedReference,
} from './referenceManagementApi';
import './referenceManagement.css';

const labels: Record<ReferenceField, string> = {
  type: 'Група',
  category: 'Категорія',
  pack: 'Пакування',
  size: 'Об’єм / вага',
  unit: 'Одиниця обліку',
};
const states = { active: 'Активний', archived: 'Архівований', merged: 'Об’єднаний' };
const operations = {
  rename: 'Перейменувати',
  merge: 'Об’єднати',
  archive: 'Архівувати',
  restore: 'Відновити',
};
const caption = (item: ManagedReference) =>
  `${item.value}${item.parentType ? ` · ${item.parentType}` : ''} · ${states[item.state]}`;

export function ReferenceManager({
  onClose,
  onChanged,
  api: injectedApi,
}: {
  onClose: () => void;
  onChanged: () => void;
  api?: ReferenceManagementApi;
}) {
  const [api] = useState(() => injectedApi || createReferenceManagementApi());
  const client = useQueryClient();
  const data = useQuery({
    queryKey: ['catalog-reference-management'],
    queryFn: ({ signal }) => api.list(signal),
    retry: false,
    staleTime: 0,
  });
  const [field, setField] = useState<ReferenceField>('type');
  const [sourceId, setSourceId] = useState('');
  const [operation, setOperation] = useState<ReferenceMutation['operation']>('rename');
  const [name, setName] = useState('');
  const [targetId, setTargetId] = useState('');
  const [reviewed, setReviewed] = useState<{
    key: string;
    impact: ReferenceImpact;
    body: ReferenceCommit;
  } | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [notice, setNotice] = useState('');
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const source = data.data?.items.find((item) => item.id === sourceId);
  const choices = (data.data?.items || []).filter((item) => item.field === field);
  const targets = choices.filter(
    (item) =>
      item.id !== sourceId &&
      item.state === 'active' &&
      (field !== 'category' ||
        (item.parentId === source?.parentId &&
          referenceKey(item.parentType) === referenceKey(source?.parentType || ''))),
  );
  const target = targets.find((item) => item.id === targetId);
  const request: ReferenceMutation | null =
    source && source.state !== 'merged'
      ? {
          sourceId: source.id,
          revision: source.revision,
          operation,
          ...(operation === 'rename' ? { value: name } : operation === 'merge' ? { targetId } : {}),
        }
      : null;
  const key = JSON.stringify(request);
  const impact = reviewed?.key === key ? reviewed.impact : null;
  const reviewKey = impact ? key : null;
  useEffect(() => {
    if (reviewKey) reviewHeading.current?.focus();
  }, [reviewKey]);
  useEffect(
    () => () => {
      controller.current?.abort();
      generation.current += 1;
    },
    [],
  );
  const canEdit = data.data?.canEdit === true && !data.isFetching && !data.error;
  const valid =
    !!source &&
    source.state !== 'merged' &&
    (operation === 'restore' ? source.state === 'archived' : source.state === 'active') &&
    (operation !== 'rename' || !!name.trim()) &&
    (operation !== 'merge' || !!target);
  const invalidate = () => {
    generation.current += 1;
    controller.current?.abort();
    setPreviewBusy(false);
    setReviewed(null);
    setPreviewError('');
    setNotice('');
    commit.reset();
  };
  const commit = useMutation({
    mutationFn: (body: ReferenceCommit) => api.commit(body),
    retry: false,
    onSuccess: () => {
      setReviewed(null);
      setSourceId('');
      setName('');
      setTargetId('');
      setOperation('rename');
      setNotice('Зміну довідника збережено. Каталог і цінники оновлено.');
      void client.invalidateQueries({ queryKey: ['catalog-reference-management'] });
      void client.invalidateQueries({ queryKey: ['catalog-references'] });
      void client.invalidateQueries({ queryKey: ['catalog'] });
      onChanged();
    },
    onError: (error) => {
      if (error instanceof ApiError && [401, 403, 409].includes(error.status)) {
        setReviewed(null);
        void data.refetch();
      }
    },
  });
  const preview = async () => {
    if (!request || !valid || !canEdit || commit.isPending) return;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const current = ++generation.current;
    setPreviewBusy(true);
    setPreviewError('');
    setReviewed(null);
    commit.reset();
    setNotice('');
    try {
      const result = await api.preview(request, abort.signal);
      if (current !== generation.current || abort.signal.aborted) return;
      setReviewed({
        key,
        impact: result,
        body: { ...request, snapshot: result.snapshot, idempotencyKey: crypto.randomUUID() },
      });
    } catch (error) {
      if (current !== generation.current || abort.signal.aborted) return;
      setPreviewError(error instanceof Error ? error.message : 'Не вдалося перевірити вплив.');
      if (error instanceof ApiError && [401, 403, 409].includes(error.status)) void data.refetch();
    } finally {
      if (current === generation.current) setPreviewBusy(false);
    }
  };
  const close = () => {
    if (!commit.isPending) {
      controller.current?.abort();
      generation.current += 1;
      onClose();
    }
  };
  return (
    <ModalOverlay
      className="tk-editor-overlay"
      isOpen
      isDismissable={!commit.isPending}
      isKeyboardDismissDisabled={commit.isPending}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <Modal className="tk-editor-modal tk-reference-modal">
        <Dialog className="tk-editor-dialog tk-reference-manager">
          <header>
            <div>
              <Heading slot="title">Керування довідниками</Heading>
              <p>Зміни назв у поточному каталозі потребують перегляду впливу.</p>
            </div>
            <Button onPress={close} isDisabled={commit.isPending} aria-label="Закрити довідники">
              Закрити
            </Button>
          </header>
          {data.isPending ? <p role="status">Завантажуємо довідники…</p> : null}
          {data.error ? (
            <div role="alert">
              <p>{data.error.message}</p>
              <Button onPress={() => void data.refetch()}>Оновити довідники</Button>
            </div>
          ) : null}
          {data.data ? (
            <>
              {!data.data.canEdit ? <p>Вашій ролі доступний перегляд довідників.</p> : null}
              <div className="tk-reference-grid">
                <Select
                  label="Довідник"
                  options={referenceFields.map((id) => ({ id, label: labels[id] }))}
                  selectedKey={field}
                  isDisabled={commit.isPending}
                  onSelectionChange={(value) => {
                    invalidate();
                    setField(value as ReferenceField);
                    setSourceId('');
                    setTargetId('');
                    setName('');
                    setOperation('rename');
                  }}
                />
                <Select
                  label="Запис довідника"
                  options={choices.map((item) => ({ id: item.id, label: caption(item) }))}
                  selectedKey={sourceId || null}
                  isDisabled={commit.isPending}
                  onSelectionChange={(value) => {
                    invalidate();
                    const item = choices.find((item) => item.id === value);
                    setSourceId(String(value));
                    setName(item?.value || '');
                    setTargetId('');
                    setOperation(item?.state === 'archived' ? 'restore' : 'rename');
                  }}
                />
              </div>
              {source ? (
                <p className="tk-help">
                  Стан: {states[source.state]}.{' '}
                  {source.parentType ? `Група: ${source.parentType}.` : ''}
                </p>
              ) : null}
              {source?.state === 'merged' ? (
                <p>
                  Запис об’єднано з «
                  {data.data.items.find((item) => item.id === source.mergedInto)?.value ||
                    source.mergedInto}
                  ». Для нових значень виберіть цільовий активний запис.
                </p>
              ) : null}
              {source && source.state !== 'merged' && data.data.canEdit ? (
                <>
                  <div className="tk-reference-grid">
                    <Select
                      label="Дія"
                      options={(source.state === 'archived'
                        ? ['restore']
                        : ['rename', 'merge', 'archive']
                      ).map((id) => ({
                        id,
                        label: operations[id as ReferenceMutation['operation']],
                      }))}
                      selectedKey={operation}
                      isDisabled={commit.isPending}
                      onSelectionChange={(value) => {
                        invalidate();
                        setOperation(value as ReferenceMutation['operation']);
                        setTargetId('');
                      }}
                    />
                    {operation === 'rename' ? (
                      <TextField
                        label="Нова назва"
                        value={name}
                        maxLength={field === 'unit' ? 30 : 160}
                        isReadOnly={commit.isPending}
                        onChange={(value) => {
                          invalidate();
                          setName(value);
                        }}
                      />
                    ) : null}
                    {operation === 'merge' ? (
                      <Select
                        label={field === 'type' ? 'Цільова група' : 'Цільовий запис'}
                        options={targets.map((item) => ({ id: item.id, label: caption(item) }))}
                        selectedKey={targetId || null}
                        isDisabled={commit.isPending}
                        onSelectionChange={(value) => {
                          invalidate();
                          setTargetId(String(value));
                        }}
                      />
                    ) : null}
                  </div>
                  {operation === 'archive' ? (
                    <p>
                      Архівований запис зникне з нового вибору. Наявні значення товарів залишаться
                      читабельними.
                    </p>
                  ) : null}
                  {operation === 'merge' ? (
                    <p>
                      Товари перейдуть до вибраного цільового запису.{' '}
                      {field === 'type'
                        ? 'Однойменні категорії в цільовій групі об’єднаються; інші категорії збережуть свої ID.'
                        : ''}
                    </p>
                  ) : null}
                  <Button
                    onPress={() => void preview()}
                    isDisabled={!canEdit || !valid || previewBusy || commit.isPending}
                  >
                    {previewBusy ? 'Перевіряємо вплив…' : 'Переглянути вплив'}
                  </Button>
                  {previewBusy ? (
                    <p role="status">Перевіряємо поточні товари та залежності…</p>
                  ) : null}
                </>
              ) : null}
              {previewError ? (
                <p role="alert" className="tk-error">
                  {previewError}
                </p>
              ) : null}
              {impact ? (
                <section className="tk-reference-impact" aria-label="Вплив зміни">
                  <h3 ref={reviewHeading} tabIndex={-1}>
                    Перевірений вплив
                  </h3>
                  <p>
                    <strong>
                      {operations[impact.operation]}: {impact.source.value}
                    </strong>
                    {impact.target
                      ? ` → ${impact.target.value}`
                      : impact.operation === 'rename'
                        ? ` → ${name.trim()}`
                        : ''}
                  </p>
                  <dl>
                    <div>
                      <dt>Товарів із цим записом</dt>
                      <dd>{impact.usageCount}</dd>
                    </div>
                    <div>
                      <dt>Товарів буде оновлено</dt>
                      <dd>{impact.productCount}</dd>
                    </div>
                    <div>
                      <dt>Записів буде змінено</dt>
                      <dd>{impact.referenceCount}</dd>
                    </div>
                  </dl>
                  {impact.examples.length ? (
                    <>
                      <h4>Приклади товарів</h4>
                      <ul>
                        {impact.examples.map((item) => (
                          <li key={item.id}>{item.name}</li>
                        ))}
                      </ul>
                      <p className="tk-help">Показано до 10 товарів із {impact.productCount}.</p>
                    </>
                  ) : null}
                  {impact.coalescedCategories.length ? (
                    <>
                      <h4>Категорії, які об’єднаються у вибраній групі</h4>
                      <ul>
                        {impact.coalescedCategories.map((item) => (
                          <li key={item.sourceId}>
                            {item.value} → {impact.target?.value}
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                  {impact.warnings.map((warning, index) => (
                    <p key={index}>{warning}</p>
                  ))}
                  {impact.blockedCount ? (
                    <div role="alert">
                      <h4>Заблоковано: {impact.blockedCount}</h4>
                      <ul>
                        {impact.blocked.map((reason, index) => (
                          <li key={index}>{reason}</li>
                        ))}
                      </ul>
                      <p>Жодна зміна не буде збережена.</p>
                    </div>
                  ) : null}
                  <Button
                    variant="primary"
                    onPress={() => {
                      if (reviewed && canEdit && valid) commit.mutate(reviewed.body);
                    }}
                    isDisabled={!canEdit || !valid || !!impact.blockedCount || commit.isPending}
                  >
                    {commit.isPending
                      ? 'Зберігаємо…'
                      : commit.error
                        ? 'Повторити підтвердження'
                        : 'Підтвердити зміну довідника'}
                  </Button>
                </section>
              ) : null}
            </>
          ) : null}
          {commit.error ? (
            <p role="alert" className="tk-error">
              {commit.error.message}
              {commit.error instanceof ApiError && commit.error.status === 409
                ? ' Перегляньте вплив знову.'
                : ''}
            </p>
          ) : null}
          <p role="status" aria-live="polite">
            {notice}
          </p>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
