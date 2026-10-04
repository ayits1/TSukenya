import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Checkbox } from 'react-aria-components';
import { Button } from '../../shared/ui/Button';
import { Select } from '../../shared/ui/Select';
import type {
  OperationPriceResult,
  OperationPriceResultPage,
  PriceResultGroup,
} from '../../shared/api/operationPrices';
import type { Product } from '../catalog/api';
import type { PromotionApi, PromotionContext } from '../promotions/api';
import { createSelectionApi, mergedSelection } from './operationSelection';
import type { PriceOperation, SelectionApi, SelectionReview } from './operationSelection';
import './operation-selection.css';
export function OperationSelectionReview({
  operation,
  selection,
  context,
  promotions,
  api: supplied,
  isDisabled,
  onApply,
  onCancel,
}: {
  operation: PriceOperation;
  selection: Record<string, number>;
  context: PromotionContext;
  promotions: Pick<PromotionApi, 'context'>;
  api?: SelectionApi;
  isDisabled: boolean;
  onApply: (
    selection: Record<string, number>,
    products: Product[],
    context: PromotionContext,
  ) => void;
  onCancel: () => void;
}) {
  const api = useMemo(
    () => supplied || createSelectionApi(() => context.csrf),
    [supplied, context.csrf],
  );
  const [group, setGroup] = useState<PriceResultGroup>('retail'),
    [page, setPage] = useState(1),
    [result, setResult] = useState<OperationPriceResultPage | null>(null),
    [chosen, setChosen] = useState<Record<number, OperationPriceResult>>({}),
    [review, setReview] = useState<SelectionReview | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(true),
    [notice, setNotice] = useState(''),
    [ack, setAck] = useState(false);
  const controller = useRef<AbortController | null>(null),
    generation = useRef(0),
    alive = useRef(true),
    heading = useRef<HTMLHeadingElement>(null),
    currentSignature = JSON.stringify([selection, context.storeId]),
    signature = useRef(currentSignature),
    baseline = useRef(currentSignature);
  useLayoutEffect(() => {
    signature.current = currentSignature;
  }, [currentSignature]);
  const start = () => {
    controller.current?.abort();
    const abort = new AbortController(),
      token = ++generation.current;
    controller.current = abort;
    setBusy(true);
    setError('');
    return {
      abort,
      current: () => alive.current && token === generation.current && !abort.signal.aborted,
    };
  };
  const load = async (nextGroup: PriceResultGroup = group, nextPage = page) => {
    const request = start();
    setReview(null);
    setAck(false);
    setNotice('');
    try {
      const data = await api.result(
        operation.kind,
        operation.id,
        { group: nextGroup, page: nextPage },
        request.abort.signal,
      );
      if (!request.current()) return;
      setResult(data);
      setGroup(nextGroup);
      setPage(data.page);
    } catch (e) {
      if (request.current())
        setError(e instanceof Error ? e.message : 'Не вдалося прочитати результат.');
    } finally {
      if (request.current()) {
        setBusy(false);
        requestAnimationFrame(() => heading.current?.focus());
      }
    }
  };
  // Each mount is a distinct operation. StrictMode replay starts a fresh read.
  useEffect(() => {
    const abort = new AbortController(),
      token = ++generation.current;
    const active = alive,
      sequence = generation;
    active.current = true;
    controller.current = abort;
    const current = () => active.current && sequence.current === token && !abort.signal.aborted;
    api
      .result(operation.kind, operation.id, { group: 'retail', page: 1 }, abort.signal)
      .then((data) => {
        if (current()) {
          setResult(data);
          setBusy(false);
          requestAnimationFrame(() => heading.current?.focus());
        }
      })
      .catch((e) => {
        if (current()) {
          setError(e instanceof Error ? e.message : 'Не вдалося прочитати результат.');
          setBusy(false);
        }
      });
    return () => {
      active.current = false;
      sequence.current++;
      abort.abort();
      controller.current?.abort();
    };
  }, [api, operation.kind, operation.id]);
  const readReview = async (nextPage = 1) => {
    const ordinals = Object.keys(chosen).map(Number);
    if (!ordinals.length) return;
    const request = start(),
      atStart = signature.current;
    setAck(false);
    setReview(null);
    try {
      const data = await api.preview(operation, { ordinals, page: nextPage }, request.abort.signal);
      if (!request.current()) return;
      if (signature.current !== atStart)
        throw Error('Вибір Studio або магазин змінився. Прочитайте перегляд повторно.');
      baseline.current = atStart;
      setReview(data);
    } catch (e) {
      if (request.current())
        setError(e instanceof Error ? e.message : 'Не вдалося прочитати поточні ціни.');
    } finally {
      if (request.current()) setBusy(false);
    }
  };
  const apply = async (mode: 'replace' | 'add') => {
    if (!review?.canApply || busy || isDisabled || (review.counts.changedAfterOperation && !ack))
      return;
    const request = start(),
      original = review,
      atStart = signature.current;
    try {
      if (atStart !== baseline.current)
        throw Error('Вибір Studio або магазин змінився. Прочитайте перегляд повторно.');
      const currentContext = await promotions.context(
        original.priceContext.storeId,
        request.abort.signal,
      );
      if (currentContext.storeId !== original.priceContext.storeId)
        throw Error('Сервер повернув інший магазин ціни.');
      const finalApi = supplied || createSelectionApi(() => currentContext.csrf);
      const products: Product[] = [];
      let latest = original;
      for (let n = 1; n <= original.pages; n++) {
        latest = await finalApi.preview(
          operation,
          { ordinals: original.ordinals, page: n, snapshot: original.snapshot },
          request.abort.signal,
        );
        if (!request.current()) return;
        if (
          !latest.canApply ||
          currentContext.storeName !== latest.priceContext.storeName ||
          currentContext.effectiveDay !== latest.effectiveDay
        )
          throw Error('Магазин, день або доступність змінилися. Прочитайте перегляд повторно.');
        products.push(...latest.items.map((row) => row.current!));
      }
      if (!request.current()) return;
      if (signature.current !== atStart)
        throw Error('Вибір Studio або магазин змінився. Прочитайте перегляд повторно.');
      const next = mergedSelection(
        selection,
        latest.selection.map((r) => r.id),
        mode,
      );
      onApply(next, products, currentContext);
    } catch (e) {
      if (request.current()) {
        setError(e instanceof Error ? e.message : 'Не вдалося підтвердити вибір.');
        setReview(null);
        setAck(false);
      }
    } finally {
      if (request.current()) setBusy(false);
    }
  };
  const choose = (rows: OperationPriceResult[], add: boolean) => {
    controller.current?.abort();
    generation.current++;
    setBusy(false);
    setReview(null);
    setAck(false);
    setNotice('');
    const next = { ...chosen };
    for (const row of rows) {
      if (add) next[row.ordinal] = row;
      else delete next[row.ordinal];
    }
    if (Object.keys(next).length > 1000)
      setNotice('Максимум 1000 товарів у пакеті. Зменште вибір.');
    else setChosen(next);
  };
  const ordinals = Object.keys(chosen).map(Number),
    blocked = busy || isDisabled;
  return (
    <section className="tk-operation-review" aria-busy={busy}>
      <h2 ref={heading} tabIndex={-1}>
        Цінники за результатом операції
      </h2>
      <p className="tk-help">
        Збережена операція {operation.id}. Ціни операції — історія. До вибору потраплять поточні
        ціни після вашого підтвердження.
      </p>
      {error ? <p role="alert">{error} Чернетку й вибір Studio збережено.</p> : null}
      {busy ? <p role="status">Читаємо та перевіряємо пакет…</p> : null}
      <Select
        label="Які цінники підготувати"
        value={group}
        options={[
          { id: 'retail', label: 'Змінена діюча ціна' },
          { id: 'display', label: 'Лише звичайна / перекреслена ціна або позначка акції' },
          { id: 'new', label: 'Нові товари — перший друк' },
        ]}
        isDisabled={blocked}
        onChange={(value) => {
          if (value) void load(value as PriceResultGroup, 1);
        }}
      />
      {result ? (
        <>
          <p>
            Контекст операції: {result.priceContext?.storeName || 'Мережа — загальні ціни'}.
            Результат:{' '}
            {result.status === 'completed'
              ? 'завершено'
              : result.status === 'cancelled'
                ? 'скасовано; показані вже записані рядки'
                : 'підтверджені рядки часткового результату'}
            . У групі {result.total}.
          </p>
          {result.comparisonUnavailable ? (
            <p>
              Для цієї старої операції немає збереженої ціни до зміни. Не можна відновити перелік
              змін із поточного каталогу.
            </p>
          ) : !result.total ? (
            <p>
              У цій групі змін немає. Округлення, ручна або стала акційна ціна могли зберегти діючу
              суму.
            </p>
          ) : (
            <>
              <Button isDisabled={blocked} onPress={() => choose(result.items, true)}>
                Вибрати цю сторінку ({result.items.length})
              </Button>
              <ul className="tk-operation-rows">
                {result.items.map((row) => (
                  <li key={row.ordinal}>
                    <Checkbox
                      isDisabled={blocked}
                      isSelected={!!chosen[row.ordinal]}
                      onChange={(checked) => choose([row], checked)}
                    >
                      <span className="tk-checkbox-mark" aria-hidden="true" />
                      {row.id} ·{' '}
                      {row.before
                        ? `${row.before.salePrice} → ${row.after.salePrice}`
                        : row.after.salePrice}{' '}
                      грн
                    </Checkbox>
                    <p className="tk-help">
                      Звичайна ціна: {row.before?.regularPrice ?? '—'} → {row.after.regularPrice}{' '}
                      грн.{' '}
                      {row.displayChanged ? 'Змінено перекреслену ціну або позначку акції.' : ''}
                    </p>
                  </li>
                ))}
              </ul>
              <nav className="tk-operation-actions" aria-label="Сторінки результату цін">
                <Button
                  isDisabled={blocked || page <= 1}
                  onPress={() => void load(group, page - 1)}
                >
                  Попередня
                </Button>
                <span>
                  {page} / {result.pages}
                </span>
                <Button
                  isDisabled={blocked || page >= result.pages}
                  onPress={() => void load(group, page + 1)}
                >
                  Далі
                </Button>
              </nav>
            </>
          )}
        </>
      ) : null}
      <p role="status">
        Вибрано {ordinals.length} товарів. Пакет не доповнюється новими рядками імпорту автоматично.
      </p>
      {notice ? <p role="status">{notice}</p> : null}
      <div className="tk-operation-actions">
        <Button isDisabled={blocked || !ordinals.length} onPress={() => void readReview()}>
          Прочитати поточні ціни вибраних
        </Button>
        <Button
          isDisabled={blocked || !ordinals.length}
          onPress={() => {
            setChosen({});
            setReview(null);
          }}
        >
          Очистити пакет
        </Button>
        <Button
          isDisabled={isDisabled}
          onPress={() => {
            controller.current?.abort();
            generation.current++;
            onCancel();
          }}
        >
          Скасувати передавання
        </Button>
        {error ? (
          <Button isDisabled={blocked} onPress={() => void load()}>
            Повторити читання результату
          </Button>
        ) : null}
      </div>
      {review ? (
        <div className="tk-operation-current">
          <h3>Поточні ціни перед вибором у Studio</h3>
          <p>
            {review.priceContext.storeName || 'Мережа — загальні ціни'} · {review.effectiveDay}.
            Доступні {review.counts.available}; приховані {review.counts.hidden}; відсутні{' '}
            {review.counts.missing}.
          </p>
          {review.counts.changedAfterOperation ? (
            <>
              <p>
                Після операції змінилися ціни, реквізити, акція або день для{' '}
                {review.counts.changedAfterOperation} товарів.
              </p>
              <Checkbox isDisabled={blocked} isSelected={ack} onChange={setAck}>
                <span className="tk-checkbox-mark" aria-hidden="true" />
                Підтверджую використання поточних умов замість історичних
              </Checkbox>
            </>
          ) : null}
          <ul className="tk-operation-rows">
            {review.items.map((row) => (
              <li key={row.operationResult.ordinal}>
                <strong>{row.current?.name || row.operationResult.id}</strong>
                <p>
                  Після операції: {row.operationResult.after.salePrice} грн · Зараз:{' '}
                  {row.currentTerms?.salePrice ?? '—'} грн
                </p>
                <p className="tk-help">
                  Звичайна після операції: {row.operationResult.after.regularPrice} грн · Зараз:{' '}
                  {row.currentTerms?.regularPrice ?? '—'} грн. Перекреслена зараз:{' '}
                  {row.currentTerms?.display.oldPrice ?? 'немає'}. Акція:{' '}
                  {row.currentTerms?.display.promotion ? 'так' : 'ні'}.
                </p>
                <p className="tk-help">
                  {row.state === 'hidden'
                    ? 'Прихований товар — недоступний для друку'
                    : row.state === 'missing'
                      ? 'Товар відсутній'
                      : row.amountChanged
                        ? 'Діюча ціна вже інша'
                        : row.displayChanged
                          ? 'Оформлення акції / перекреслена ціна вже інші'
                          : row.revisionChanged
                            ? 'Версія, реквізити, акція або день уже інші'
                            : 'Відповідає результату операції'}
                </p>
                {row.state !== 'available' ? (
                  <Button isDisabled={blocked} onPress={() => choose([row.operationResult], false)}>
                    Прибрати недоступний товар
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
          <nav className="tk-operation-actions" aria-label="Сторінки поточних цін">
            <Button
              isDisabled={blocked || review.page <= 1}
              onPress={() => void readReview(review.page - 1)}
            >
              Попередні поточні
            </Button>
            <span>
              {review.page} / {review.pages}
            </span>
            <Button
              isDisabled={blocked || review.page >= review.pages}
              onPress={() => void readReview(review.page + 1)}
            >
              Наступні поточні
            </Button>
          </nav>
          <p className="tk-help">
            Заміна лишає тільки цей пакет. Додавання зберігає також раніше вибрані цінники. Макет і
            кількість копій чинних товарів збережуться. Друк почнеться лише окремою дією після
            перевірки макета.
          </p>
          <div className="tk-operation-actions">
            <Button
              variant="primary"
              isDisabled={
                blocked || !review.canApply || (!!review.counts.changedAfterOperation && !ack)
              }
              onPress={() => void apply('replace')}
            >
              Замінити вибір
            </Button>
            <Button
              isDisabled={
                blocked || !review.canApply || (!!review.counts.changedAfterOperation && !ack)
              }
              onPress={() => void apply('add')}
            >
              Додати до вибраних
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
