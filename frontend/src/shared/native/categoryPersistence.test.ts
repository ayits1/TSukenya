import { describe, it, expect } from 'vitest';
import {
  decodeCategoryPayload,
  decodeCategoryContext,
  confirmCategoryPayload,
} from './categoryPersistence';
const key = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  row = { id: key, name: 'Первісна', active: true, semantic_key: null, revision: 1 },
  raw = { name: '', active: false };
const state = {
  recordId: 'category_' + key,
  key,
  id: null,
  original: null,
  base: { name: '', active: true },
  confirmed: false,
  needsReview: false,
  deleted: false,
};
const body = { name: 'Первісна', active: true, id: key };
const payload = () => ({
  baseline: state,
  draft: raw,
  firstIntent: {
    method: 'POST',
    path: '/api/erp/budget-categories',
    key,
    body,
    revision: null,
    possiblySent: true,
  },
  confirmation: null,
});
const ack = { ...row, resource: 'category', request_key: key };
describe('category reload persistence', () => {
  it('whitelists invalid raw separately and pins original key/body', () => {
    expect(decodeCategoryPayload(payload()).draft).toEqual(raw);
    for (const value of [
      { ...payload(), draft: { ...raw, csrf: 'secret' } },
      { ...payload(), baseline: { ...state, original: { ...row, aliases: ['private'] } } },
      {
        ...payload(),
        firstIntent: {
          ...payload().firstIntent,
          body: { ...body, id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' },
        },
      },
    ])
      expect(() => decodeCategoryPayload(value)).toThrow();
  });
  it('confirmed create/identity never adopts mutable revision or erases newer invalid input', () => {
    for (const event of [
      { type: 'create', raw: ack },
      {
        type: 'identity',
        raw: {
          confirmed: true,
          resource: 'category',
          request_key: key,
          status: 'present',
          id: key,
          revision: 9,
          permissions: { canEdit: true },
        },
      },
    ]) {
      const next = confirmCategoryPayload(payload(), { ...event, draft: raw })!;
      expect(next.baseline).toMatchObject({
        id: key,
        original: null,
        needsReview: true,
        base: { name: 'Первісна', active: true },
      });
      expect(next.draft).toEqual(raw);
      expect(next.firstIntent).toBeNull();
      expect(
        confirmCategoryPayload(next, {
          type: 'complete',
          raw: { resource: 'category', record: row, permissions: { canEdit: true } },
          draft: raw,
        }),
      ).not.toBeNull();
    }
    expect(() =>
      confirmCategoryPayload(payload(), {
        type: 'create',
        raw: { ...ack, name: 'Other' },
        draft: raw,
      }),
    ).toThrow();
  });
  it('UPDATE unknown allows only explicit Apply and separate Save, with semantic-key and revision guards', () => {
    const p = {
      ...payload(),
      baseline: { ...state, id: key, original: row, needsReview: true },
      firstIntent: {
        ...payload().firstIntent,
        method: 'PUT',
        path: '/api/erp/budget-categories/' + key,
        revision: 1,
        body: { name: 'Моє', active: true, revision: 1 },
      },
    };
    const applied = confirmCategoryPayload(p, {
      type: 'apply',
      raw: {
        resource: 'category',
        record: { ...row, revision: 3, name: 'Сервер' },
        permissions: { canEdit: true },
      },
      draft: { name: 'Моє', active: true },
    })!;
    expect(applied.firstIntent).toBeNull();
    expect(applied.baseline).toMatchObject({ original: { revision: 3 }, needsReview: false });
    expect(() =>
      confirmCategoryPayload(p, {
        type: 'apply',
        raw: {
          resource: 'category',
          record: { ...row, semantic_key: 'salary' },
          permissions: { canEdit: true },
        },
        draft: raw,
      }),
    ).toThrow();
    expect(
      confirmCategoryPayload(applied, {
        type: 'complete',
        raw: {
          resource: 'category',
          record: { ...row, name: 'Моє' },
          permissions: { canEdit: true },
        },
        draft: { name: ' Мoє ', active: true },
      }),
    ).not.toBeNull();
  });
  it('same-session readonly context is readable, scope changes fail; tombstone never recreates', () => {
    const session = {
      draftOwner: 'a'.repeat(64),
      draftSession: 'b'.repeat(64),
      role: 'manager' as const,
      storeId: 1,
      networkOwner: false,
    };
    expect(
      decodeCategoryContext(
        {
          resource: 'category',
          id: null,
          role: 'manager',
          storeId: 1,
          networkOwner: false,
          exists: null,
          canEdit: false,
        },
        state,
        session,
      ).canEdit,
    ).toBe(false);
    expect(() =>
      decodeCategoryContext(
        {
          resource: 'category',
          id: null,
          role: 'owner',
          storeId: 1,
          networkOwner: false,
          exists: null,
          canEdit: true,
        },
        state,
        session,
      ),
    ).toThrow();
    const next = confirmCategoryPayload(payload(), {
      type: 'identity',
      raw: { confirmed: true, resource: 'category', request_key: key, status: 'deleted', id: key },
      draft: raw,
    });
    expect(next?.baseline).toMatchObject({ deleted: true, confirmed: true, needsReview: true });
  });
});
