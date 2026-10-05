import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import { isCurrentAuthFailure, throwCurrentAuthFailure } from './authRead';
import type { Json } from '../../../shared/recovery/storage';
import {
  createRecoveryApi,
  decodeEnvelope,
  requestHash,
  RecoveryError,
  type Operation,
  type Envelope,
  type Acknowledgement,
} from './api';
import {
  codecName,
  decodeCatalogPayload,
  encodePayload,
  confirmed,
  type Baseline,
  type CatalogPayload,
} from './codec';
const copy = (v: unknown): Json => JSON.parse(JSON.stringify(v)) as Json;
const api = createRecoveryApi();
let installed = false;
let restored: CatalogPayload | null = null;
let restoreSignal: AbortSignal | null = null;
const editors = new Map<string, () => void>();
export function installCatalogRecovery() {
  const foundation = window.NativeDraftRecovery;
  if (!foundation || installed) return;
  installed = true;
  foundation.register({
    name: codecName,
    version: 1,
    label: 'Товари та довідники каталогу',
    decode: (v) => encodePayload(decodeCatalogPayload(v)),
    authorize: async (payload, session, signal) => {
      const p = decodeCatalogPayload(payload),
        intent = p.firstIntent ? decodeEnvelope(p.firstIntent.body) : p.confirmation?.envelope;
      const context = await api.context(
        intent || {
          operation:
            p.baseline.kind === 'product'
              ? p.baseline.target
                ? 'product_update'
                : 'product_create'
              : p.baseline.target
                ? 'reference_commit'
                : 'product_create',
          target: p.baseline.target,
          store: p.baseline.store,
        },
        signal,
        () => !signal.aborted,
      );
      return (
        context.editing.role === session.role &&
        context.editing.storeId === session.storeId &&
        context.editing.networkOwner === session.networkOwner
      );
    },
    restore: (payload, signal) => {
      if (signal.aborted) return;
      restored = decodeCatalogPayload(payload);
      restoreSignal = signal;
    },
    suspend: () => {
      restored = null;
      restoreSignal = null;
      for (const hide of editors.values()) hide();
    },
    confirm: confirmed,
  });
  foundation.controller.subscribe(() => {
    if (foundation.controller.snapshot().state !== 'ready' || !restoreSignal || !restored) return;
    const signal = restoreSignal,
      payload = restored;
    restoreSignal = null;
    queueMicrotask(() => {
      if (signal.aborted) return;
      foundation.close();
      restored = payload;
      location.hash = '#operations/products';
      window.dispatchEvent(new Event('tsukenya:catalog-draft-restore'));
    });
  });
}
export function takeCatalogRestore() {
  const value = restored;
  restored = null;
  return value;
}
export function useCatalogRecovery(
  baseline: Omit<Baseline, 'recordId' | 'intentHash'>,
  raw: CatalogPayload['draft'],
  restoredPayload?: CatalogPayload,
  enabled = true,
) {
  const [id] = useState(
    () => restoredPayload?.baseline.recordId || 'catalog_' + crypto.randomUUID(),
  );
  const value = useRef<CatalogPayload>(
    restoredPayload ||
      ({
        baseline: { ...baseline, recordId: id, intentHash: null },
        draft: raw,
        firstIntent: null,
        confirmation: null,
      } as CatalogPayload),
  );
  const rawRef = useRef(raw);
  useLayoutEffect(() => {
    rawRef.current = raw;
  }, [raw]);
  const lifecycle = useRef({
    mounted: true,
    generation: 0,
    protected: 0,
    prepared: false,
    ambiguous: !!restoredPayload?.firstIntent,
  });
  const [state, setState] = useState({
    private: !enabled,
    busy: false,
    error: '',
    intent: !!restoredPayload?.firstIntent,
    confirmed: !!restoredPayload?.confirmation,
    blocked: false,
  });
  const live = (generation: number, signal?: AbortSignal) =>
    lifecycle.current.mounted &&
    lifecycle.current.generation === generation &&
    !signal?.aborted &&
    document.visibilityState !== 'hidden';
  const show = (patch: Partial<typeof state>) => {
    if (lifecycle.current.mounted) setState((old) => ({ ...old, ...patch }));
  };
  const capture = () => {
    const f = window.NativeDraftRecovery;
    if (!f || !lifecycle.current.prepared) throw Error('Спочатку підтвердьте доступ до чернетки.');
    value.current = { ...value.current, draft: structuredClone(rawRef.current) };
    f.store.save(id, codecName, encodePayload(value.current));
  };
  const stop = () => {
    lifecycle.current.generation++;
    window.NativeDraftRecovery?.controller.dismiss();
    show({ busy: false, private: false, error: 'Перевірку скасовано. Поля збережено.' });
  };
  const prepare = async () => {
    const f = window.NativeDraftRecovery;
    const generation = ++lifecycle.current.generation;
    show({ private: false, busy: true, error: '' });
    if (!f) {
      show({ busy: false, error: 'Локальне сховище чернеток недоступне. Запит не надіслано.' });
      return;
    }
    lifecycle.current.protected++;
    try {
      const existed = lifecycle.current.prepared || !!restoredPayload;
      const session = await f.controller.check(false);
      if (!live(generation)) return;
      if (!['owner', 'manager', 'warehouse'].includes(session.role))
        throw new RecoveryError(403, 'Цій ролі недоступне редагування каталогу.');
      if (!live(generation)) return;
      if (!existed) f.store.save(id, codecName, encodePayload(value.current));
      lifecycle.current.prepared = true;
      const verified = await f.controller.verify(id);
      if (!live(generation) || !verified) throw Error('Доступ до цієї чернетки не підтверджено.');
      show({ private: true, busy: false, blocked: false });
    } catch (error) {
      if (live(generation))
        show({
          busy: false,
          error: error instanceof Error ? error.message : 'Доступ не підтверджено.',
        });
    } finally {
      lifecycle.current.protected--;
    }
  };
  const initialize = useEffectEvent(() => {
    void prepare();
  });
  const hide = useEffectEvent(() => {
    show({ private: false });
    if (!lifecycle.current.protected) lifecycle.current.generation++;
  });
  useEffect(() => {
    if (!enabled) return;
    installCatalogRecovery();
    const lifetime = lifecycle.current;
    lifetime.mounted = true;
    editors.set(id, hide);
    initialize();
    return () => {
      lifetime.mounted = false;
      lifetime.generation++;
      editors.delete(id);
    };
  }, [id, enabled]); // The record keeps its opening baseline across renders.
  const persistRaw = useEffectEvent(() => {
    if (!enabled || !lifecycle.current.prepared || !state.private || state.busy) return;
    try {
      capture();
      if (state.blocked) show({ blocked: false, error: '' });
    } catch (error) {
      show({
        blocked: true,
        error: error instanceof Error ? error.message : 'Не вдалося записати чернетку.',
      });
    }
  });
  const rawIdentity = JSON.stringify(raw);
  useLayoutEffect(() => {
    persistRaw();
  }, [rawIdentity, state.private, state.busy]);
  function readFence() {
    const generation = lifecycle.current.generation;
    return () => live(generation);
  }
  async function refuseAuthRead(error: unknown, current: () => boolean) {
    if (!enabled || !isCurrentAuthFailure(error, current)) return;
    const f = window.NativeDraftRecovery;
    const generation = ++lifecycle.current.generation;
    // A quota failure cannot keep denied private fields visible. Existing autosave
    // already captured the raw input; authorization never depends on another save.
    show({ private: false, busy: true, error: '' });
    if (!f) {
      show({ busy: false, error: 'Доступ не підтверджено. Поля приховані.' });
      return;
    }
    lifecycle.current.protected++;
    try {
      await f.controller.verifyRead(id, async (signal) =>
        throwCurrentAuthFailure(error, () => live(generation), signal),
      );
    } finally {
      lifecycle.current.protected--;
      if (live(generation))
        show({
          busy: false,
          private: false,
          error: error instanceof Error ? error.message : 'Доступ не підтверджено.',
        });
    }
  }
  async function read<T>(callback: (signal: AbortSignal) => Promise<T>): Promise<T | null> {
    const f = window.NativeDraftRecovery;
    if (!f) return null;
    try {
      capture();
    } catch (error) {
      show({
        blocked: true,
        error: error instanceof Error ? error.message : 'Не вдалося записати чернетку.',
      });
      return null;
    }
    const generation = ++lifecycle.current.generation;
    show({ busy: true, private: false, error: '' });
    lifecycle.current.protected++;
    let readError: unknown;
    try {
      const result = await f.controller.verifyRead(id, async (signal, session) => {
        let answer: T;
        try {
          answer = await callback(signal);
        } catch (error) {
          readError = error;
          throw error;
        }
        if (!live(generation, signal)) throw new DOMException('Скасовано', 'AbortError');
        void session;
        return answer;
      });
      if (live(generation) && !result && readError) throw readError;
      if (!live(generation) || !result) {
        if (live(generation))
          show({ busy: false, error: 'Не підтверджено читання. Повторіть перевірку доступу.' });
        return null;
      }
      show({ busy: false, private: true, error: '' });
      return result.value;
    } catch (error) {
      if (live(generation))
        show({
          busy: false,
          error: error instanceof Error ? error.message : 'Читання недоступне.',
        });
      return null;
    } finally {
      lifecycle.current.protected--;
    }
  }
  async function send(
    operation?: Operation,
    request?: Envelope['request'],
    target?: string | null,
    key?: string,
  ): Promise<Acknowledgement | null> {
    const f = window.NativeDraftRecovery;
    if (!f) return null;
    const generation = ++lifecycle.current.generation;
    show({ busy: true, error: '' });
    const first = !value.current.firstIntent;
    let protectedRead = false;
    let executionError: unknown;
    try {
      capture();
      if (value.current.confirmation)
        throw Error('Спершу прочитайте підтверджений запис і явно узгодьте поля.');
      if (first) {
        if (!operation || !request) throw Error('Первісна дія відсутня.');
        const envelope = decodeEnvelope({
          key: key || crypto.randomUUID(),
          operation,
          target: target ?? null,
          store: value.current.baseline.store,
          request,
        });
        if (operation === 'reference_commit')
          value.current = {
            ...value.current,
            baseline: {
              ...value.current.baseline,
              target: envelope.target,
              revision: String(request.revision),
              original: structuredClone(rawRef.current),
            },
          };
        value.current = {
          ...value.current,
          firstIntent: {
            method: 'POST',
            path: '/api/v1/catalog/recovery/execute',
            key: envelope.key,
            body: copy(envelope),
            revision: null,
            possiblySent: true,
          },
        };
        f.store.save(id, codecName, encodePayload(value.current));
        show({ intent: true });
      }
      const envelope = decodeEnvelope(f.store.beforeSend(id).body);
      if (!value.current.baseline.intentHash) {
        const hash = await requestHash(envelope);
        if (!live(generation)) return null;
        value.current = {
          ...value.current,
          baseline: { ...value.current.baseline, intentHash: hash },
        };
        f.store.save(id, codecName, encodePayload(value.current));
        show({ intent: true });
      }
      const hash = value.current.baseline.intentHash!;
      lifecycle.current.protected++;
      protectedRead = true;
      const result = await f.controller.verifyRead(id, async (signal, session) => {
        try {
          if (!live(generation, signal)) throw new DOMException('Скасовано', 'AbortError');
          const identity = await api.identity(
            envelope,
            hash,
            signal,
            () => live(generation, signal),
            session,
          );
          if (!live(generation, signal)) throw new DOMException('Скасовано', 'AbortError');
          const ack = identity.confirmed
            ? identity
            : await api.execute(envelope, hash, signal, () => live(generation, signal), session);
          if (!live(generation, signal)) throw new DOMException('Скасовано', 'AbortError');
          f.store.confirmed(id, ack);
          value.current = decodeCatalogPayload(confirmed(encodePayload(value.current), ack));
          return ack;
        } catch (error) {
          executionError = error;
          throw error;
        }
      });
      if (live(generation) && !result && executionError) throw executionError;
      if (!live(generation) || !result) {
        if (live(generation)) {
          lifecycle.current.ambiguous = true;
          show({
            busy: false,
            intent: !!value.current.firstIntent,
            private: false,
            error: 'Результат не підтверджено. Перевірте доступ і первісну дію.',
          });
        }
        return null;
      }
      show({ busy: false, intent: false, confirmed: true, private: true, error: '' });
      return result.value;
    } catch (error) {
      if (!live(generation)) return null;
      const refusal = error instanceof RecoveryError ? error.refusal : undefined;
      if (
        first &&
        !lifecycle.current.ambiguous &&
        refusal?.write_rejected === true &&
        value.current.firstIntent
      ) {
        const proof = {
          write_rejected: true,
          key: refusal.key,
          operation: refusal.operation,
          requestHash: refusal.requestHash,
        };
        try {
          f.store.confirmed(id, proof);
          value.current = decodeCatalogPayload(confirmed(encodePayload(value.current), proof));
          show({ intent: false });
        } catch {
          lifecycle.current.ambiguous = true;
        }
      } else if (value.current.firstIntent) lifecycle.current.ambiguous = true;
      show({
        busy: false,
        error: error instanceof Error ? error.message : 'Результат не підтверджено.',
        intent: !!value.current.firstIntent,
      });
      return null;
    } finally {
      if (protectedRead) lifecycle.current.protected--;
    }
  }
  function adopt(next: Omit<Baseline, 'recordId' | 'intentHash'>, draft: CatalogPayload['draft']) {
    try {
      if (value.current.firstIntent) throw Error('Спершу підтвердьте первісну дію.');
      const f = window.NativeDraftRecovery;
      if (!f) throw Error('Сховище недоступне.');
      const nextValue: CatalogPayload = {
        baseline: { ...next, recordId: id, intentHash: null },
        draft: structuredClone(draft),
        firstIntent: null,
        confirmation: null,
      };
      f.store.save(id, codecName, encodePayload(nextValue));
      value.current = nextValue;
      lifecycle.current.ambiguous = false;
      show({ intent: false, confirmed: false, error: '', private: true, blocked: false });
      return true;
    } catch (error) {
      show({
        blocked: true,
        error: error instanceof Error ? error.message : 'Не вдалося записати узгоджені поля.',
      });
      return false;
    }
  }
  const discard = () => {
    const f = window.NativeDraftRecovery;
    if (f && lifecycle.current.prepared) f.store.discard(id);
  };
  return {
    ...state,
    id,
    isLive: () => lifecycle.current.mounted && document.visibilityState !== 'hidden',
    value: () => value.current,
    prepare,
    readFence,
    refuseAuthRead,
    read,
    send,
    adopt,
    discard,
    stop,
    exactRetry: () => send(),
    open: () => window.NativeDraftRecovery?.open(),
  };
}
