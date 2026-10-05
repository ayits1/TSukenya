import { describe, it, expect } from 'vitest';
import { ApiError } from '../../shared/api/client';
import {
  decodePage,
  decodeSources,
  moneyText,
  sections,
  exportURL,
  createReportsApi,
  type SourceQuery,
} from './api';
import { ReportsModel } from './state';
import { fixturePage, query, options, api, financeApi, abcApi } from './fixtures';
const deferred = <T>() => {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { resolve, reject, promise };
};
describe('Reports strict whole-screen contract', () => {
  it('decodes all nine sections and exact decimal display without Number', () => {
    for (const mode of ['period', 'balances'] as const)
      for (const section of sections[mode])
        expect(fixturePage({ ...query, mode, section }).section).toBe(section);
    expect(moneyText('99999999999999.99')).toBe('99 999 999 999 999,99');
    expect(moneyText('-99999999999999.98')).toBe('-99 999 999 999 999,98');
  });
  it('rejects context, salary leakage, coercible enums, wrong page and shape', () => {
    const p = fixturePage();
    for (const wrong of [
      { ...p, summary: { ...p.summary, store: 2 } },
      { ...p, section: ['products'] },
      { ...p, page: 2 },
      { ...p, items: [{ ...p.items[0], revenue: 12.99 }] },
    ])
      expect(() => decodePage(wrong, query, true)).toThrow();
    const manager = fixturePage({ ...query, section: 'cashiers' }, false);
    expect(() =>
      decodePage(
        { ...manager, items: [{ ...manager.items[0], late_return_bonus: '1.00' }] },
        { ...query, section: 'cashiers' },
        false,
      ),
    ).toThrow();
    expect(() =>
      decodePage(
        fixturePage({ ...query, section: 'cashiers' }),
        { ...query, section: 'cashiers' },
        false,
      ),
    ).toThrow();
  });
  it('strict source policy/scope/date and anonymous salary', () => {
    const request: SourceQuery = { ...query, metric: 'payroll' },
      raw = {
        contract: 'trading-report-sources-v1',
        mode: 'period',
        metric: 'payroll',
        store: null,
        policy: { role: 'manager', store: null },
        limit: 30,
        title: 'Зарплата',
        formula: 'Сума внесків',
        from: query.from,
        to: query.to,
        amount: '99999999999999.99',
        items: [
          {
            type: 'aggregate',
            metric: 'payroll',
            amount: '99999999999999.99',
            label: 'Зарплата — сукупна сума без персональних документів',
            canOpen: false,
          },
        ],
        total: 1,
        page: 1,
        pages: 1,
        snapshot: 'current',
        basis: 'accounting_dates',
        reversal_policy: 'kyiv_reversed_at',
        snapshot_notice: 'Поточне читання',
      };
    expect(decodeSources(raw, request, 1, 'manager', null).amount).toBe(raw.amount);
    for (const bad of [
      { ...raw, store: 1 },
      { ...raw, policy: { role: ['manager'], store: null } },
      { ...raw, from: '2026-09-01' },
      { ...raw, items: [{ ...raw.items[0], voucher: 4 }] },
      { ...raw, source: 2 },
    ])
      expect(() => decodeSources(bad, request, 1, 'manager', null)).toThrow();
  });
  it('rejects malformed JSON200 and keeps export on explicit confirmed query', async () => {
    const client = createReportsApi(async () => new Response('{bad', { status: 200 }));
    await expect(client.read(query, true, new AbortController().signal)).rejects.toMatchObject({
      code: 'protocol',
    });
    expect(exportURL(query, 'products', 'кава')).toContain('q=%D0%BA%D0%B0%D0%B2%D0%B0');
  });
});
describe('Reports state', () => {
  it('reopens a fresh host with the supplied store for the same actor', async () => {
    const model = new ReportsModel(api, financeApi, abcApi);
    await model.activate(options);
    model.leave();
    await model.activate({ ...options, store: 7 });
    expect(model.state.committed?.store).toBe(7);
    model.leave();
  });
  it('paging keeps committed filters; 503 retains exact failed query for retry', async () => {
    const calls: (typeof query)[] = [],
      model = new ReportsModel(
        {
          read: async (q, p) => {
            calls.push({ ...q });
            return fixturePage(q, p);
          },
        },
        financeApi,
        abcApi,
      );
    await model.activate(options);
    model.edit({ from: '2026-09-01' });
    model.searchText('not yet submitted');
    await model.page(1);
    expect(calls.at(-1)?.from).not.toBe('2026-09-01');
    expect(calls.at(-1)?.q).toBe('');
    const confirmed = model.state.data;
    model.api = {
      read: async () => {
        throw new ApiError(503, 'Збій');
      },
    };
    await model.apply();
    expect(model.state.data).toBe(confirmed);
    expect(model.state.stale).toBe(true);
    expect(model.state.draft.from).toBe('2026-09-01');
    expect(model.ready()).toBe(false);
    model.edit({ from: '2026-08-01' });
    model.api = {
      read: async (q, p) => {
        calls.push({ ...q });
        return fixturePage(q, p);
      },
    };
    await model.retry();
    expect(calls.at(-1)?.from).toBe('2026-09-01');
    expect(model.state.draft.from).toBe('2026-08-01');
    model.leave();
  });
  it('late response and aborted directory401 cannot restore or deny another mode', async () => {
    const response = deferred<ReturnType<typeof fixturePage>>(),
      model = new ReportsModel(api, financeApi, abcApi);
    await model.activate(options);
    const started = deferred<void>();
    model.api = {
      read: () => {
        started.resolve();
        return response.promise;
      },
    };
    const pending = model.apply();
    await started.promise;
    await model.mode('abc');
    response.reject(new ApiError(401, 'Старий сеанс'));
    await pending;
    expect(model.state.view).toBe('abc');
    expect(model.state.denied).toBe(false);
    expect(model.state.data).toBeNull();
    const denial = deferred<never>(),
      signal = new AbortController(),
      guard = model.guard({ ...options.directoryApi, list: () => denial.promise });
    const read = guard.list('stores', {}, signal.signal);
    signal.abort();
    denial.reject(new ApiError(401, 'Застарілий запит'));
    await expect(read).rejects.toMatchObject({ status: 401 });
    expect(model.state.denied).toBe(false);
    model.leave();
  });
  it('fresh authority or current403 clears private data and actions', async () => {
    const model = new ReportsModel(api, financeApi, abcApi);
    await model.activate(options);
    model.api = {
      read: async () => {
        throw new ApiError(403, 'Заборонено');
      },
    };
    await model.apply();
    expect(model.state.denied).toBe(true);
    expect(model.state.data).toBeNull();
    expect(model.state.committed).toBeNull();
    expect(model.ready()).toBe(false);
    model.leave();
  });
});
it('preserves retired native codec metadata/arrays/counts/scales invariants', () => {
  const base = fixturePage();
  const changes: ((v: Record<string, unknown>) => void)[] = [
    (v) => delete v.contract,
    (v) => (v.contract = 'legacy'),
    (v) => (v.products = []),
    (v) => (v.mode = 'balances'),
    (v) => (v.store = 2),
    (v) => (v.to = '2026-02-31'),
    (v) => ((v.counts as Record<string, unknown>).products = -1),
    (v) => (v.profit = 0),
    (v) => (v.debts = []),
  ];
  for (const change of changes) {
    const p = structuredClone(base);
    change(p.summary as Record<string, unknown>);
    expect(() => decodePage(p, query, true)).toThrow();
  }
  const itemChanges: ((v: Record<string, unknown>) => void)[] = [
    (v) => (v.items = []),
    (v) => (v.total = 65),
    (v) => (v.page = 0),
    (v) => (v.limit = 100),
    (v) => (v.q = 'wrong'),
    (v) => ((v.items as Record<string, unknown>[])[0]!.result = 'NaN'),
    (v) => ((v.items as Record<string, unknown>[])[0]!.cost = '5'),
  ];
  for (const change of itemChanges) {
    const p = structuredClone(base);
    change(p as Record<string, unknown>);
    expect(() => decodePage(p, query, true)).toThrow();
  }
});
