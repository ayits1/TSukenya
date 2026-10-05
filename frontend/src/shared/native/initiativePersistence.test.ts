import { describe, it, expect } from 'vitest';
import * as c from './initiativePersistence';
import { DraftStore, type Payload } from '../recovery/storage';
const id = '11111111-1111-4111-8111-111111111111',
  key = '22222222-2222-4222-8222-222222222222',
  nextKey = '33333333-3333-4333-8333-333333333333',
  rev = 'a'.repeat(64);
const actor = {
  draftOwner: 'a'.repeat(64),
  draftSession: 'b'.repeat(64),
  role: 'owner' as const,
  storeId: null,
  networkOwner: true,
};
const project: c.Project = {
  id,
  idea: 'idea',
  store: 1,
  title: 'Пілот',
  problem: 'Проблема',
  hypothesis: 'Гіпотеза',
  responsible: null,
  responsibleName: null,
  responsibleActive: null,
  state: 'active',
  revision: 3,
  plannedBudget: '12.50',
  metric: 'Попит',
  metricUnit: '%',
  targetValue: '1.2500',
  factValue: null,
  resultSummary: '',
  resultDate: null,
  cancelReason: '',
};
const idea: c.Idea = {
  id: 'idea',
  title: 'Пілот',
  text: 'Ідея',
  reaction: 'yes',
  revision: rev,
  project: null,
};
const task: c.Task = {
  kind: 'task',
  id: 'task',
  title: 'Задача',
  status: 'todo',
  revision: rev,
  linkedHere: true,
  available: true,
};
const expense: c.Expense = {
  kind: 'expense',
  id: 9,
  number: '000009',
  date: '2026-10-05',
  amount: '12.50',
  status: 'posted',
  revision: 2,
  store: 1,
  category: 'Пілот',
  linkedHere: true,
  available: true,
};
function payload(action: c.Action = 'edit'): Payload {
  const source =
    action.startsWith('task_') && action !== 'task_create'
      ? task
      : action.startsWith('expense_')
        ? expense
        : null;
  const state: c.State = {
    recordId: action === 'create' ? 'initiative_idea_' + rev : 'initiative_project_' + id,
    key,
    action,
    routeProject: action === 'create' ? null : id,
    ideaId: 'idea',
    original: action === 'create' ? null : project,
    originalIdea: action === 'create' ? idea : null,
    sourceId: source?.id ?? null,
    source,
    review: false,
    frozenRaw: null,
  };
  const all: c.Raw = {
    title: '  Мій пілот  ',
    problem: 'raw',
    hypothesis: '',
    responsible: '',
    plannedBudget: '12,50',
    metric: 'Попит',
    metricUnit: '%',
    targetValue: '1,2500',
    store: '1',
    resultSummary: 'Результат',
    resultDate: '2026-10-05',
    factValue: '2,3501',
    reason: '  Причина  ',
    phase: 'Етап',
    stage: '2',
    status: 'doing',
  };
  return c.decodePayload({
    baseline: state,
    draft: Object.fromEntries(c.rawKeys(action).map((k) => [k, all[k]])),
    firstIntent: null,
    confirmation: null,
  });
}
function current(p: Payload): c.Context {
  const s = c.decodeState(p.baseline);
  return {
    contract: 'initiative-recovery-context-v1',
    role: 'owner',
    storeId: null,
    networkOwner: true,
    selection: c.selection(s, c.decodeRaw(p.draft, s.action)),
    action: s.action,
    project: s.original,
    idea: s.originalIdea,
    source: s.source,
    canWrite: true,
    reason: '',
  };
}
function receipt(p: Payload, confirmed = true): c.Receipt {
  const s = c.decodeState(p.baseline);
  return {
    contract: 'initiative-operation-identity-v1',
    confirmed,
    key: s.key,
    action: s.action,
    routeProject: s.routeProject,
    observedRevision: s.original?.revision ?? null,
    observedIdeaRevision: s.originalIdea?.revision ?? null,
    ...(confirmed ? { project: id, appliedRevision: (s.original?.revision ?? 0) + 1 } : {}),
  };
}
const apply = (p: Payload, ctx: unknown = current(p), metricAccepted = false) => ({
  type: 'apply',
  current: ctx,
  draft: p.draft,
  key: nextKey,
  metricAccepted,
});
describe('initiative family durable contract', () => {
  it('freezes exact existing bodies for all eleven actions without adding lifecycle restrictions', () => {
    for (const a of c.actions) {
      const p = c.freeze(payload(a));
      expect(p.firstIntent?.body).toMatchObject({ action: a, idempotencyKey: key });
      expect(c.decodePayload(p)).toEqual(p);
      expect(p.firstIntent?.path).toBe('/api/erp/initiatives' + (a === 'create' ? '' : '/' + id));
    }
    const body = c.freeze(payload('expense_detach')).firstIntent!.body;
    expect(body).toEqual({
      action: 'expense_detach',
      idempotencyKey: key,
      revision: 3,
      voucher: 9,
      reason: '  Причина  ',
    });
    expect(c.freeze(payload('expense_attach')).firstIntent!.body).toMatchObject({
      voucherRevision: 2,
    });
    expect(c.freeze(payload('task_link')).firstIntent!.body).toMatchObject({
      task: 'task',
      taskRevision: rev,
    });
    expect(c.freeze(payload('create')).firstIntent!.body).toMatchObject({
      store: 1,
      ideaRevision: rev,
      title: '  Мій пілот  ',
      plannedBudget: '12.50',
      targetValue: '1.2500',
    });
  });
  it('retains invalid/newer raw while the original body remains immutable and rejects foreign keys and payload', () => {
    const p = c.freeze(payload());
    const changed = {
      ...p,
      draft: { ...c.decodeRaw(p.draft, 'edit'), plannedBudget: '-', title: '' },
    };
    expect(c.freeze(changed).firstIntent).toEqual(p.firstIntent);
    expect(c.decodePayload(changed).draft).toEqual(changed.draft);
    expect(() =>
      c.decodePayload({
        ...p,
        baseline: { ...c.decodeState(p.baseline), permissions: { canWrite: true } },
      }),
    ).toThrow();
    expect(() =>
      c.decodePayload({
        ...p,
        firstIntent: {
          ...p.firstIntent,
          body: { ...(p.firstIntent!.body as object), revision: 4 },
        },
      }),
    ).toThrow();
    expect(() =>
      c.decodeRaw({ ...c.decodeRaw(p.draft, 'edit'), csrf: 'secret' }, 'edit'),
    ).toThrow();
    for (const value of ['NaN', '1e3', '1000000000000', '1.234', '-1'])
      expect(() =>
        c.freeze({
          ...payload(),
          draft: { ...c.decodeRaw(payload().draft, 'edit'), plannedBudget: value },
        }),
      ).toThrow();
  });
  it('validates exact primary and secondary selection even when source is absent', () => {
    for (const a of c.actions) {
      const p = payload(a),
        ctx = current(p),
        selected = ctx.selection;
      expect(c.decodeContext(ctx, a, selected, actor)).toEqual(ctx);
      for (const field of ['project', 'idea', 'task', 'voucher', 'store'] as const) {
        const other = {
          ...selected,
          [field]:
            field === 'voucher' || field === 'store' ? 88 : field === 'project' ? key : 'different',
        };
        expect(() => c.decodeContext({ ...ctx, selection: other }, a, selected, actor)).toThrow();
      }
      expect(() => c.decodeContext({ ...ctx, role: ['owner'] }, a, selected, actor)).toThrow();
    }
    const p = payload('task_update'),
      ctx = { ...current(p), source: null, canWrite: false, reason: 'Джерело відсутнє' };
    expect(c.decodeContext(ctx, 'task_update', ctx.selection, actor).source).toBeNull();
    expect(() =>
      c.decodeContext(
        { ...ctx, selection: { ...ctx.selection, task: 'other' } },
        'task_update',
        ctx.selection,
        actor,
      ),
    ).toThrow();
    expect(() =>
      c.decodeContext({ ...ctx, canWrite: true }, 'task_update', ctx.selection, actor),
    ).toThrow();
    expect(() =>
      c.decodeContext(ctx, 'task_update', ctx.selection, {
        ...actor,
        storeId: 1,
        networkOwner: false,
      }),
    ).toThrow();
  });
  it('binds minimal positive receipt and retires original intent before independent current data', () => {
    const p = c.freeze(payload('create')),
      r = receipt(p);
    expect(c.decodeIdentity(receipt(p, false), p).confirmed).toBe(false);
    for (const v of [
      { ...r, key: nextKey },
      { ...r, appliedRevision: 2 },
      { ...r, observedIdeaRevision: 'b'.repeat(64) },
      { ...r, project: 1 },
    ])
      expect(() => c.decodeIdentity(v, p)).toThrow();
    const confirmed = c.confirmPayload(p, { type: 'identity', identity: r, draft: p.draft })!;
    expect(confirmed.firstIntent).toBeNull();
    expect(c.decodePayload(confirmed).confirmation).toEqual({ receipt: r, raw: p.draft });
    expect(() => c.freeze(confirmed)).toThrow();
    expect(c.confirmPayload(confirmed, { type: 'complete', current: current(p) })).toBeNull();
    const changed = c.confirmPayload(p, {
      type: 'identity',
      identity: r,
      draft: { ...c.decodeRaw(p.draft, 'create'), title: 'Нові слова' },
    })!;
    expect(
      c.confirmPayload(changed, { type: 'complete', current: current(changed) })?.draft,
    ).toEqual(changed.draft);
  });
  it('accepts only a live ACK for the frozen project/idea/store/next revision, before any current read', () => {
    const p = c.freeze(payload()),
      ack = {
        ok: true,
        project: { ...project, revision: 4, tasks: { private: 'never-persisted' } },
      };
    const receipt = c.decodeAcknowledgement(ack, p);
    const confirmed = c.confirmPayload(p, { type: 'identity', identity: receipt, draft: p.draft })!;
    expect(confirmed.firstIntent).toBeNull();
    expect(JSON.stringify(confirmed.confirmation)).not.toContain('never-persisted');
    for (const project of [
      { ...ack.project, id: key },
      { ...ack.project, idea: 'other' },
      { ...ack.project, store: 8 },
      { ...ack.project, revision: 6 },
    ])
      expect(() => c.decodeAcknowledgement({ ...ack, project }, p)).toThrow();
  });
  it('retires only explicit bound first rejection and requires separate local Apply before another Save', () => {
    const p = c.freeze(payload()),
      event = {
        type: 'rejected',
        key,
        action: 'edit',
        revision: 3,
        status: 409,
        code: 'revision_conflict',
        draft: p.draft,
      };
    const next = c.confirmPayload(p, event)!;
    expect(next.firstIntent).toBeNull();
    expect(() => c.freeze(next)).toThrow();
    for (const e of [
      { ...event, key: nextKey },
      { ...event, code: 'idempotency_conflict' },
      { ...event, status: 403 },
      { ...event, revision: 4 },
    ])
      expect(() => c.confirmPayload(p, e)).toThrow();
    const restored = { ...p, baseline: { ...c.decodeState(p.baseline), review: true } };
    expect(() => c.confirmPayload(restored, event)).toThrow();
    const applied = c.confirmPayload(next, apply(next))!;
    expect(applied.firstIntent).toBeNull();
    expect(c.freeze(applied).firstIntent?.key).toBe(nextKey);
  });
  it('keeps KPI tuple atomic and requires explicit fresh result interpretation while retaining reason', () => {
    const p = payload('result_edit'),
      ctx = current(p);
    ctx.project = { ...project, metricUnit: 'кг', targetValue: '8.0000', revision: 4 };
    expect(() => c.confirmPayload(p, apply(p, ctx))).toThrow();
    const next = c.confirmPayload(p, apply(p, ctx, true))!;
    expect(c.decodeRaw(next.draft, 'result_edit').reason).toBe('  Причина  ');
    expect(c.decodeState(next.baseline).original?.metricUnit).toBe('кг');
    expect(() => c.confirmPayload(c.freeze(p), apply(p, ctx, true))).toThrow();
    expect(() => c.confirmPayload(p, apply(p, { ...ctx, canWrite: false }, true))).toThrow();
  });
  it('persists confirmation and Apply atomically through the actual draft store under quota failure', () => {
    const items = new Map<string, string>();
    let fail = false;
    const storage = {
      get length() {
        return items.size;
      },
      key: (i: number) => [...items.keys()][i] ?? null,
      getItem: (k: string) => items.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (fail) throw Error('quota');
        items.set(k, v);
      },
      removeItem: (k: string) => {
        items.delete(k);
      },
      clear: () => items.clear(),
    } as Storage;
    const store = new DraftStore(storage);
    store.register({
      name: 'native-initiative-v1',
      version: 1,
      label: 'Проєкт',
      decode: c.decodePayload,
      confirm: c.confirmPayload,
      authorize: async () => true,
      restore: () => {},
      suspend: () => {},
    });
    store.bind(actor);
    const p = c.freeze(payload()),
      record = c.decodeState(p.baseline).recordId;
    store.save(record, 'native-initiative-v1', p);
    const before = [...items.values()][0];
    fail = true;
    expect(() =>
      store.confirmed(record, { type: 'identity', identity: receipt(p), draft: p.draft }),
    ).toThrow();
    expect([...items.values()][0]).toBe(before);
    fail = false;
    store.confirmed(record, { type: 'identity', identity: receipt(p), draft: p.draft });
    const saved = JSON.parse([...items.values()][0]!).payload as Payload;
    expect(saved.firstIntent).toBeNull();
    expect(saved.confirmation).toBeTruthy();
    fail = true;
    const acknowledged = [...items.values()][0];
    expect(() => store.confirmed(record, apply(saved))).toThrow();
    expect([...items.values()][0]).toBe(acknowledged);
  });
});
