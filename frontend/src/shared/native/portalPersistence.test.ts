import { expect, it } from 'vitest';
import {
  decodePortalState,
  decodePortalPayload,
  createPortalBody,
  confirmPortalPayload,
  decodePortalContext,
  safePortalRecord,
} from './portalPersistence';
const key = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const baseline = {
  recordId: 'portal_' + key,
  key,
  collection: 'tasks',
  mode: 'create',
  entry: 'addWork',
  id: null,
  revision: null,
  original: { title: '', status: 'todo', dueDate: null },
  metadata: { scope: 'operations', store: 1, ideaId: null, order: 10, byOwner: null },
  review: false,
};
const draft = { title: ' Нова задача ', status: 'todo', dueDate: '', stage: '' };
const payload = () => ({
  baseline: structuredClone(baseline),
  draft: structuredClone(draft),
  firstIntent: null,
  confirmation: null,
});
it('preserves invalid raw and freezes validated first whole body independently', () => {
  const p = payload(),
    s = decodePortalState(decodePortalPayload(p).baseline);
  const body = createPortalBody(s, draft);
  const frozen = decodePortalPayload({
    ...p,
    firstIntent: {
      method: 'POST',
      path: '/api/tasks',
      key,
      body,
      revision: null,
      possiblySent: true,
    },
    draft: { ...draft, title: '', dueDate: '2026-13-44' },
  });
  expect(frozen.draft).toMatchObject({ title: '', dueDate: '2026-13-44' });
  expect(frozen.firstIntent!.body).toMatchObject({
    title: 'Нова задача',
    scope: 'operations',
    store: 1,
    order: 10,
  });
  for (const mutation of [
    { permissions: {} },
    { token: 'secret' },
    { collection: 'ideas' },
    { metadata: { ...baseline.metadata, store: '1' } },
  ])
    expect(() => decodePortalPayload({ ...p, baseline: { ...baseline, ...mutation } })).toThrow();
});
it('confirmation survives a separate failed current read without adopting ID/revision as baseline', () => {
  const body = createPortalBody(decodePortalState(baseline), draft),
    p = decodePortalPayload({
      ...payload(),
      firstIntent: {
        method: 'POST',
        path: '/api/tasks',
        key,
        body,
        revision: null,
        possiblySent: true,
      },
    });
  const next = confirmPortalPayload(p, {
    type: 'identity',
    id: 'created',
    revision: 'b'.repeat(32),
    original: { title: 'Нова задача', status: 'todo', dueDate: null },
    draft: { ...draft, title: '' },
    missing: false,
  });
  expect(next.firstIntent).toBeNull();
  expect(next.baseline).toMatchObject({ id: null, revision: null });
  expect(next.confirmation).toMatchObject({ id: 'created', revision: 'b'.repeat(32) });
  expect(decodePortalPayload(next)).toEqual(next);
  expect(() =>
    confirmPortalPayload(p, {
      type: 'identity',
      id: 'created',
      revision: 'b'.repeat(32),
      original: { title: 'Other', status: 'todo', dueDate: null },
      draft,
      missing: false,
    }),
  ).toThrow();
  const applied = confirmPortalPayload(next, {
    type: 'apply',
    id: 'created',
    revision: 'c'.repeat(32),
    original: { title: 'Server', status: 'doing', dueDate: null },
    draft: { title: 'Mine', status: 'doing', dueDate: '', stage: '' },
    missing: false,
  });
  expect(applied.baseline).toMatchObject({ id: 'created', revision: 'c'.repeat(32), mode: 'edit' });
  expect(applied.firstIntent).toBeNull();
  expect(applied.draft).toMatchObject({ title: 'Mine' });
});
it('DELETE absence records observation only; PATCH/DELETE paths and immutable identity are strict', () => {
  const s = {
    ...baseline,
    mode: 'delete',
    entry: 'delete:task',
    id: 'task',
    revision: 'a'.repeat(32),
    original: { title: 'Task', status: 'todo', dueDate: null },
  };
  const p = decodePortalPayload({
    baseline: s,
    draft: {},
    firstIntent: {
      method: 'DELETE',
      path: '/api/docs/tasks/task',
      key,
      body: null,
      revision: s.revision,
      possiblySent: true,
    },
    confirmation: null,
  });
  const next = confirmPortalPayload(p, {
    type: 'missing',
    id: 'task',
    revision: null,
    original: null,
    draft: {},
    missing: true,
  });
  expect(next.confirmation).toEqual({ id: 'task', revision: null, original: null, missing: true });
  expect(next.firstIntent).toBeNull();
  expect(() =>
    decodePortalPayload({ ...p, firstIntent: { ...p.firstIntent, path: '/api/docs/tasks/other' } }),
  ).toThrow();
  expect(() =>
    confirmPortalPayload(p, {
      type: 'missing',
      id: 'other',
      revision: null,
      original: null,
      draft: {},
      missing: true,
    }),
  ).toThrow();
  expect(() => decodePortalPayload({ ...p, baseline: { ...s, collection: 'ideas' } })).toThrow();
});
it('keeps privileges out of storage and requires exact current actor/scope context', () => {
  const record = {
    collection: 'tasks' as const,
    id: 't',
    revision: 'a'.repeat(32),
    data: { title: 'Task', status: 'todo', scope: 'operations', store: 1, secret: 'not copied' },
    permissions: { canEdit: true, canDelete: true },
    managed: false,
    initiative: null,
  };
  expect(JSON.stringify(safePortalRecord(record))).not.toContain('secret');
  expect(JSON.stringify(safePortalRecord(record))).not.toContain('permissions');
  expect(() => safePortalRecord({ ...record, managed: true })).toThrow();
  expect(() => safePortalRecord({ ...record, initiative: key })).toThrow();
  const actor = { role: 'manager', storeId: 1, networkOwner: false },
    context = {
      collection: 'tasks',
      id: null,
      scope: 'operations',
      store: 1,
      ideaId: null,
      exists: null,
      role: 'manager',
      storeId: 1,
      networkOwner: false,
      canWrite: true,
    };
  expect(decodePortalContext(context, decodePortalState(baseline), actor)).toEqual(context);
  expect(
    decodePortalContext(
      { ...context, id: 'confirmed', exists: true },
      decodePortalState(baseline),
      actor,
      'confirmed',
    ),
  ).toMatchObject({ id: 'confirmed' });
  expect(() =>
    decodePortalContext(context, decodePortalState(baseline), actor, 'confirmed'),
  ).toThrow();
  for (const change of [
    { role: 'owner' },
    { storeId: 2 },
    { canWrite: 'true' },
    { exists: false },
    { unexpected: 1 },
  ])
    expect(() =>
      decodePortalContext({ ...context, ...change }, decodePortalState(baseline), actor),
    ).toThrow();
});
