import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ModalOverlay, Modal, Dialog, Heading } from 'react-aria-components';
import { Button } from '../../shared/ui/Button';
import { Select } from '../../shared/ui/Select';
import { TextField } from '../../shared/ui/TextField';
import { ApiError } from '../../shared/api/client';
import { referenceFields, referenceKey, type ReferenceField } from './api';
import { ReferencePicker } from './ReferencePicker';
import { referenceQuery, type ImpactSection } from './referenceDirectoryApi';
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
  const [field, setField] = useState<ReferenceField>('type');
  const [recordState, setRecordState] = useState<ManagedReference['state']>('active');
  const [source, setSource] = useState<ManagedReference | null>(null);
  const [target, setTarget] = useState<ManagedReference | null>(null);
  const sourceQuery = referenceQuery(field, { state: recordState });
  const data = useQuery({
    queryKey: ['catalog-reference-management', sourceQuery],
    queryFn: ({ signal }) => api.list(sourceQuery, 1, signal),
    retry: false,
    staleTime: 0,
  });
  const [operation, setOperation] = useState<ReferenceMutation['operation']>('rename');
  const [name, setName] = useState('');
  const targetId = target?.id || '';
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
    (operation !== 'merge' ||
      (!!target &&
        target.id !== source?.id &&
        target.state === 'active' &&
        target.field === source.field &&
        (field !== 'category' ||
          (target.parentId === source.parentId &&
            referenceKey(target.parentType) === referenceKey(source.parentType)))));
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
      setSource(null);
      setName('');
      setTarget(null);
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
                    setSource(null);
                    setTarget(null);
                    setName('');
                    setOperation('rename');
                  }}
                />
                <Select
                  label="Стан записів"
                  options={Object.entries(states).map(([id, label]) => ({ id, label }))}
                  selectedKey={recordState}
                  isDisabled={commit.isPending}
                  onSelectionChange={(key) => {
                    invalidate();
                    setRecordState(String(key) as ManagedReference['state']);
                    setSource(null);
                    setTarget(null);
                    setName('');
                  }}
                />
                <ReferencePicker
                  api={api.directory}
                  query={sourceQuery}
                  label="Запис довідника"
                  selected={source}
                  value={source?.value || ''}
                  disabled={commit.isPending || data.isPending || !!data.error}
                  onCommit={(item) => {
                    invalidate();
                    setSource(item);
                    setName(item.value);
                    setTarget(null);
                    setOperation(item.state === 'archived' ? 'restore' : 'rename');
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
                <p>Запис об’єднано. Для нових значень виберіть цільовий активний запис.</p>
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
                        setTarget(null);
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
                      <ReferencePicker
                        api={api.directory}
                        query={referenceQuery(
                          field,
                          field === 'category'
                            ? {
                                parentId: source.parentId,
                                parentType: source.parentId ? null : source.parentType,
                              }
                            : {},
                        )}
                        label={field === 'type' ? 'Цільова група' : 'Цільовий запис'}
                        selected={target}
                        value={target?.value || ''}
                        disabled={commit.isPending}
                        onCommit={(item) => {
                          if (item.id === source.id) return;
                          invalidate();
                          setTarget(item);
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
                  {reviewed && request ? (
                    <ImpactDetails api={api} request={request} impact={impact} />
                  ) : null}
                  {impact.coalescedCount > impact.coalescedCategories.length ? (
                    <p className="tk-help">
                      Показано приклади: {impact.coalescedCategories.length} із{' '}
                      {impact.coalescedCount}. Усі об’єднання доступні в деталях впливу.
                    </p>
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

function ImpactDetails({
  api,
  request,
  impact,
}: {
  api: ReferenceManagementApi;
  request: ReferenceMutation;
  impact: ReferenceImpact;
}) {
  const [section, setSection] = useState<ImpactSection>('products'),
    [page, setPage] = useState(1),
    [open, setOpen] = useState(false);
  const result = useQuery({
    queryKey: ['catalog-reference-impact', impact.snapshot, section, page],
    queryFn: ({ signal }) => api.directory.impact(request, impact.snapshot, section, page, signal),
    enabled: open,
    retry: false,
    staleTime: 0,
  });
  const labels: Record<ImpactSection, string> = {
    products: 'Усі товари',
    references: 'Усі записи довідника',
    coalesced: 'Усі об’єднання категорій',
    blocked: 'Усі блокування',
  };
  return (
    <section aria-label="Деталі повного впливу">
      <Button onPress={() => setOpen((value) => !value)}>
        {open ? 'Згорнути деталі впливу' : 'Показати весь вплив'}
      </Button>
      {open ? (
        <>
          <Select
            label="Розділ впливу"
            options={Object.entries(labels).map(([id, label]) => ({ id, label }))}
            selectedKey={section}
            onSelectionChange={(key) => {
              setSection(String(key) as ImpactSection);
              setPage(1);
            }}
          />
          {result.isFetching ? (
            <p role="status">Читаємо сторінку впливу…</p>
          ) : result.error ? (
            <div role="alert">
              <p>{result.error.message}</p>
              <Button onPress={() => void result.refetch()}>Повторити читання впливу</Button>
            </div>
          ) : result.data ? (
            <>
              <ul>
                {result.data.items.map((row, index) => {
                  if ('before' in row)
                    return (
                      <li key={row.before.id}>
                        {row.before.value} → {row.after.value}
                        {row.after.parentType ? ` · ${row.after.parentType}` : ''} ·{' '}
                        {states[row.after.state]}
                      </li>
                    );
                  if ('name' in row) return <li key={row.id}>{row.name}</li>;
                  if ('reason' in row) return <li key={row.id}>{row.reason}</li>;
                  return (
                    <li key={index}>
                      {row.value} → {impact.target?.value}
                    </li>
                  );
                })}
              </ul>
              <p role="status">
                Сторінка {result.data.page} із {result.data.pages} · {result.data.total} записів
              </p>
              <Button
                isDisabled={result.data.page <= 1}
                onPress={() => setPage((value) => value - 1)}
              >
                Попередня сторінка впливу
              </Button>
              <Button
                isDisabled={result.data.page >= result.data.pages}
                onPress={() => setPage((value) => value + 1)}
              >
                Наступна сторінка впливу
              </Button>
            </>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
