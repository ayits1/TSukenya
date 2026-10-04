import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ApiError } from '../../shared/api/client';
import { compareThreeWay, resolveThreeWay, type MergeChoices } from '../../shared/merge/threeWay';
import type { Commit, Current, Preview, Receipt, ReceiptPricingApi } from './api';
import { fields, initialDraft, proposal, type Draft } from './model';
const serialize = (value: unknown) => JSON.stringify(value);
export function useReceiptReview(
  api: ReceiptPricingApi,
  id: number,
  onState?: (dirty: boolean, busy: boolean) => void,
) {
  const [current, setCurrent] = useState<Current>(),
    [draft, setDraft] = useState<Draft>(),
    [review, setReview] = useState<{ data: Preview; body: Commit }>(),
    [result, setResult] = useState<Receipt>(),
    [error, setError] = useState(''),
    [status, setStatus] = useState(''),
    [busy, setBusy] = useState(false),
    [writeBusy, setWriteBusy] = useState(false),
    [needsRead, setNeedsRead] = useState(false),
    [uncertain, setUncertain] = useState(false),
    [comparison, setComparison] = useState<{
      current: Current;
      base: Draft;
      mine: Draft;
      server: Draft;
    }>(),
    [choices, setChoices] = useState<MergeChoices>({});
  const live = useRef(true),
    reads = useRef<{ generation: number; controller?: AbortController }>({ generation: 0 }),
    intent = useRef<Commit | undefined>(undefined),
    state = useRef({ current, draft, busy, writeBusy, needsRead }),
    baseline = useRef<Draft | undefined>(undefined),
    activeWrite = useRef(false),
    onStateRef = useRef(onState);
  const [pristine, setPristine] = useState('');
  useLayoutEffect(() => {
    state.current = { current, draft, busy, writeBusy, needsRead };
    onStateRef.current = onState;
  }, [current, draft, busy, writeBusy, needsRead, onState]);
  const isDirty = !!draft && serialize(draft) !== pristine;
  useEffect(() => {
    onStateRef.current?.(isDirty, busy || writeBusy);
  }, [isDirty, busy, writeBusy]);
  const cancelRead = useCallback(() => {
    reads.current.controller?.abort();
    reads.current = { generation: reads.current.generation + 1 };
    setBusy(false);
    setStatus('Читання скасовано. Пропозиція збережена.');
  }, []);
  const beginRead = useCallback(() => {
    reads.current.controller?.abort();
    const controller = new AbortController(),
      generation = reads.current.generation + 1;
    reads.current = { generation, controller };
    setBusy(true);
    setError('');
    return {
      signal: controller.signal,
      valid: () =>
        live.current && !controller.signal.aborted && reads.current.generation === generation,
    };
  }, []);
  const load = useCallback(
    async (store?: number | null) => {
      if (state.current.writeBusy || intent.current) return;
      const previous = state.current,
        read = beginRead();
      setStatus('Читаємо накладну й поточні ціни…');
      setReview(undefined);
      if (previous.current) setNeedsRead(true);
      try {
        const data = await api.current(id, store, read.signal);
        if (!read.valid()) return;
        if (!previous.current || !previous.draft) {
          const initial = initialDraft(data);
          setCurrent(data);
          setDraft(initial);
          baseline.current = initial;
          setPristine(serialize(initial));
          setNeedsRead(!data.canEdit);
          setStatus('Джерело підтверджено. Виберіть товари та задайте пропозицію.');
        } else {
          const server = initialDraft(data),
            base = baseline.current!; // Keep original rows as unavailable; never remap their IDs.
          for (const [key, value] of Object.entries(base.rows))
            if (!server.rows[key]) server.rows[key] = previous.draft.rows[key] || value;
          setComparison({ current: data, base, mine: previous.draft, server });
          setChoices({});
          setStatus(
            data.canEdit
              ? 'Порівняння готове. Узгодьте зміни перед новим переглядом.'
              : 'Поточні права або стан джерела забороняють запис. Пропозиція збережена.',
          );
        }
      } catch (cause) {
        if (read.valid()) {
          setError(cause instanceof Error ? cause.message : 'Не вдалося прочитати джерело.');
          if (previous.current) setNeedsRead(true);
          setStatus('Нову версію не підтверджено. Повторіть лише читання.');
        }
      } finally {
        if (read.valid()) setBusy(false);
      }
    },
    [api, id, beginRead],
  );
  useEffect(() => {
    live.current = true;
    queueMicrotask(() => {
      if (live.current) void load();
    });
    return () => {
      live.current = false;
      reads.current.controller?.abort();
      reads.current.generation++;
    };
  }, [load]);
  const edit = (value: Draft) => {
    if (busy || writeBusy || comparison) return;
    setDraft(value);
    setReview(undefined);
    setError('');
  };
  async function preview() {
    if (!current || !draft || busy || writeBusy || needsRead || intent.current) return;
    const read = beginRead();
    setStatus('Сервер перевіряє пропозицію…');
    try {
      const body = proposal(current, draft);
      const data = await api.preview(id, body, read.signal);
      if (!read.valid()) return;
      setReview({
        data,
        body: { ...body, snapshot: data.snapshot, idempotencyKey: crypto.randomUUID() },
      });
      setStatus(
        data.valid
          ? 'План перевірено. Запис потребує окремого підтвердження.'
          : 'План містить помилки. Жодного товару не змінено.',
      );
    } catch (cause) {
      if (read.valid()) {
        setError(cause instanceof Error ? cause.message : 'Помилка перегляду.');
        if (
          cause instanceof ApiError &&
          (cause.status === 409 || cause.status === 403 || cause.status === 200)
        )
          setNeedsRead(true);
      }
    } finally {
      if (read.valid()) setBusy(false);
    }
  }
  function confirm(receipt: Receipt, body: Commit) {
    setResult(receipt);
    intent.current = undefined;
    setUncertain(false);
    setReview(undefined);
    setNeedsRead(true);
    setStatus(
      'Початкову операцію підтверджено. Результат є історичним; для наступного запису прочитайте поточні ціни.',
    );
    const now = state.current;
    if (now.current && now.draft) {
      try {
        if (
          serialize(proposal(now.current, now.draft)) ===
          serialize(
            Object.fromEntries(
              Object.entries(body).filter(
                ([key]) => key !== 'snapshot' && key !== 'idempotencyKey',
              ),
            ),
          )
        )
          setPristine(serialize(now.draft));
      } catch {
        /* Newer invalid input stays untouched. */
      }
    }
  }
  async function save(exact = false) {
    const frozen = exact ? intent.current : review?.body;
    if (!frozen || writeBusy || busy || (!exact && (needsRead || !review?.data.valid))) return;
    const wasUncertain = uncertain;
    intent.current = frozen;
    activeWrite.current = true;
    setWriteBusy(true);
    setError('');
    setStatus(exact ? 'Повторюємо тільки початковий запит…' : 'Записуємо підтверджений план…');
    try {
      const receipt = await api.commit(id, frozen);
      if (!live.current) return;
      confirm(receipt, frozen);
    } catch (cause) {
      if (!live.current) return;
      setError(cause instanceof Error ? cause.message : 'Результат запису невідомий.');
      const definitive = cause instanceof ApiError && cause.status >= 400 && cause.status < 500;
      if (definitive && !wasUncertain) {
        intent.current = undefined;
        setUncertain(false);
        if (cause.status === 409 || cause.status === 403) setNeedsRead(true);
        setStatus('Запит відхилено. Пропозиція збережена.');
      } else {
        setUncertain(true);
        setStatus(
          'Результат початкового запису невідомий. Повторіть його точно або прочитайте результат за тим самим ключем.',
        );
      }
    } finally {
      activeWrite.current = false;
      if (live.current) setWriteBusy(false);
    }
  }
  async function readResult() {
    const frozen = intent.current;
    if (!frozen || busy || writeBusy) return;
    const read = beginRead();
    setStatus('Читаємо результат початкової операції без запису…');
    try {
      const receipt = await api.result(id, frozen, read.signal);
      if (read.valid()) confirm(receipt, frozen);
    } catch (cause) {
      if (read.valid()) {
        setError(cause instanceof Error ? cause.message : 'Результат не підтверджено.');
        setStatus(
          'Початковий запит збережено. Читання не підтвердило результат і не створило нової операції.',
        );
      }
    } finally {
      if (read.valid()) setBusy(false);
    }
  }
  function apply() {
    if (!comparison || busy || writeBusy || !comparison.current.canEdit || intent.current) return;
    const descriptors = fields(comparison.current);
    const merged = resolveThreeWay(
      comparison.base,
      comparison.mine,
      comparison.server,
      descriptors,
      choices,
    );
    if (!merged) return;
    // This is local adoption only; all writes still require preview + separate Save.
    baseline.current = comparison.server;
    setCurrent(comparison.current);
    setDraft(merged);
    setComparison(undefined);
    setNeedsRead(false);
    setReview(undefined);
    setStatus(
      'Узгоджено лише локальну пропозицію. Перевірте джерело й виконайте новий перегляд перед записом.',
    );
  }
  const mergeRows = comparison
    ? compareThreeWay(
        comparison.base,
        comparison.mine,
        comparison.server,
        fields(comparison.current),
      )
    : [];
  return {
    current,
    draft,
    review,
    result,
    error,
    status,
    busy,
    writeBusy,
    needsRead,
    uncertain,
    comparison,
    choices,
    mergeRows,
    isDirty,
    edit,
    preview,
    save,
    readResult,
    load,
    cancelRead,
    apply,
    setChoices,
    cancelComparison() {
      setComparison(undefined);
      setStatus('Пропозиція збережена. Для запису потрібне повторне читання й узгодження.');
    },
  };
}
