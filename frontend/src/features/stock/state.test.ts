import { it, expect } from 'vitest';
import { ApiError } from '../../shared/api/client';
import { resolveThreeWay } from '../../shared/merge/threeWay';
import { StockModel, captureTerms, assortmentFields, terms } from './state';
import { fixtureApi, options, assortmentRow, assortmentPage, stockPage } from './fixtures';
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
it('preserves invalid newer draft through unknown ACK GET; Apply separate from Save and second409', async () => {
  let writes = 0,
    reads = 0;
  const api = fixtureApi();
  api.save = async () => {
    writes++;
    throw new ApiError(writes === 1 ? 0 : 409, 'lost/conflict');
  };
  api.assortment = async () => {
    reads++;
    return {
      ...assortmentPage,
      rows: [{ ...assortmentRow, min_stock: '4.000', minimum: '4.000', revision: 'a'.repeat(32) }],
    };
  };
  const model = new StockModel(api);
  await model.activate(options);
  model.edit(1, assortmentRow, { minimum: '3.125' });
  await model.save(1, 'p');
  model.edit(1, assortmentRow, { minimum: 'invalid' });
  await model.compare(1, 'p');
  expect(reads).toBe(1);
  expect(writes).toBe(1);
  const draft = model.state.drafts.get('1:p')!;
  expect(draft.minimum).toBe('invalid');
  expect(draft.base.revision).toBeNull();
  expect(draft.server?.revision).toBe('a'.repeat(32));
  expect(() => captureTerms(draft)).toThrow();
  model.edit(1, assortmentRow, { minimum: '6.250' });
  const current = model.state.drafts.get('1:p')!;
  const merged = resolveThreeWay(
    terms(current.base),
    captureTerms(current),
    terms(current.server!),
    assortmentFields,
    { assortment: 'mine' },
  )!;
  model.apply('1:p', merged);
  expect(writes).toBe(1);
  expect(model.state.drafts.get('1:p')!.base.revision).toBe('a'.repeat(32));
  await model.save(1, 'p');
  expect(writes).toBe(2);
  expect(model.state.drafts.get('1:p')!.uncertain).toBe(true);
});
it('ignores transport success after abort/route change; scope403 clears private DOM data but keeps local draft', async () => {
  const api = fixtureApi();
  let release: ((v: typeof stockPage) => void) | undefined;
  const model = new StockModel(api);
  await model.activate(options);
  model.edit(1, assortmentRow, { minimum: '0' });
  api.stock = (query) =>
    query.q === 'old'
      ? new Promise((resolve) => {
          release = resolve;
        })
      : Promise.resolve({ ...stockPage, query });
  const old = model.change({ q: 'old' });
  await tick();
  await model.change({ q: 'new' });
  release!({ ...stockPage, query: { ...stockPage.query, q: 'old' } });
  await old;
  expect(model.state.totals!.query.q).toBe('new');
  api.stock = async () => {
    throw new ApiError(403, 'revoked');
  };
  await model.refresh();
  expect(model.state.denied).toBe(true);
  expect(model.state.totals).toBeNull();
  expect(model.state.captions.size).toBe(0);
  expect(model.state.drafts.get('1:p')!.minimum).toBe('0');
  model.leave();
  await tick();
  expect(model.state.totals).toBeNull();
});
it('null means inherit; zero and atomic assortment group stay distinct', () => {
  expect(captureTerms({ sold: false, minimum: '' })).toEqual({ sold: false, min_stock: null });
  expect(captureTerms({ sold: true, minimum: '0' })).toEqual({ sold: true, min_stock: '0' });
  expect(
    resolveThreeWay(
      { sold: true, min_stock: null },
      { sold: false, min_stock: null },
      { sold: true, min_stock: '0' },
      assortmentFields,
      {},
    ),
  ).toBeNull();
  for (const minimum of ['-1', '0.0001', '1000000000000', '1e3'])
    expect(() => captureTerms({ sold: true, minimum })).toThrow();
});
it('old ignored-abort401 cannot clear new success; pending POST blocks navigation and compare finally is request-fenced', async () => {
  const api = fixtureApi(),
    model = new StockModel(api);
  await model.activate(options);
  let rejectOld: ((error: Error) => void) | undefined;
  api.stock = (query) =>
    query.q === 'old'
      ? new Promise((_resolve, reject) => {
          rejectOld = reject;
        })
      : Promise.resolve({ ...stockPage, query });
  const old = model.change({ q: 'old' });
  await tick();
  await model.change({ q: 'new' });
  rejectOld!(new ApiError(401, 'old session'));
  await old;
  expect(model.state.denied).toBe(false);
  expect(model.state.totals!.query.q).toBe('new');
  model.edit(1, assortmentRow, { minimum: '3' });
  let finishPost: (() => void) | undefined;
  api.save = (intent) =>
    new Promise((resolve) => {
      finishPost = () =>
        resolve({
          warehouse: 1,
          row: {
            ...assortmentRow,
            sold: intent.sold,
            min_stock: '3.000',
            minimum: '3.000',
            revision: 'a'.repeat(32),
          },
          policy: stockPage.policy,
        });
    });
  const write = model.save(1, 'p');
  await tick();
  expect(model.canLeave()).toBe(false);
  expect(model.state.notice).toMatch(/Зачекайте/);
  finishPost!();
  await write;
  expect(model.canLeave()).toBe(true);
  model.edit(1, assortmentRow, { minimum: '4' });
  let finishFirst: (() => void) | undefined,
    finishSecond: (() => void) | undefined,
    calls = 0;
  api.assortment = () =>
    new Promise((resolve) => {
      const fn = () => resolve(assortmentPage);
      if (++calls === 1) finishFirst = fn;
      else finishSecond = fn;
    });
  const first = model.compare(1, 'p');
  await tick();
  model.cancelComparison('1:p');
  const second = model.compare(1, 'p');
  await tick();
  finishFirst!();
  await first;
  expect(model.state.drafts.get('1:p')!.reading).toBe(true);
  finishSecond!();
  await second;
  expect(model.state.drafts.get('1:p')!.reading).toBe(false);
});
