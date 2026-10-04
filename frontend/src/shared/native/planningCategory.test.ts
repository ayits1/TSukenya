import { describe, expect, it } from 'vitest';
import {
  captureCategory,
  confirmCategory,
  decodeCategoryIdentity,
  decodeCategoryRead,
  categoryFields,
  categoryProjection,
} from './planningCategory';
import { compareThreeWay, resolveThreeWay } from '../merge/threeWay';
import { nativeFields } from './fields';
const id = 'aabbccdd-1111-2222-3333-123456789abc';
const record = { id, name: 'Оренда', active: true, semantic_key: null, revision: 1 };
describe('Planning category recovery', () => {
  it('strict current context, immutable metadata and normalized create ACK', () => {
    const body = { id, name: ' Оренда ', active: true };
    expect(
      confirmCategory({ ...record, resource: 'category', request_key: id }, body, id, true),
    ).toEqual(record);
    for (const patch of [
      { request_key: 'aabbccdd-1111-2222-3333-123456789abd' },
      { name: 'Чужа' },
      { revision: 2 },
      { semantic_key: 'salary' },
    ])
      expect(() =>
        confirmCategory(
          { ...record, resource: 'category', request_key: id, ...patch },
          body,
          id,
          true,
        ),
      ).toThrow();
    expect(
      decodeCategoryRead({ resource: 'category', record, permissions: { canEdit: false } }, id)
        .permissions.canEdit,
    ).toBe(false);
    expect(() => decodeCategoryRead({ resource: 'category', record }, id)).toThrow();
    expect(() => captureCategory({ name: '', active: true })).toThrow();
  });
  it('receipt binds only ID; revision is not returned as editable baseline', () => {
    const intent = { id, name: 'Оренда', active: true };
    expect(
      decodeCategoryIdentity(
        {
          resource: 'category',
          request_key: id,
          confirmed: true,
          status: 'present',
          id,
          revision: 5,
          permissions: { canEdit: true },
        },
        intent,
      ),
    ).toEqual({ confirmed: true, status: 'present', id });
    expect(
      decodeCategoryIdentity(
        { resource: 'category', request_key: id, confirmed: false, status: 'legacy_unknown' },
        intent,
      ),
    ).toEqual({ confirmed: false, status: 'legacy_unknown' });
    for (const patch of [
      { resource: 'monthly_budget' },
      { id: 'wrong' },
      { permissions: { canEdit: false } },
      { revision: null },
    ])
      expect(() =>
        decodeCategoryIdentity(
          {
            resource: 'category',
            request_key: id,
            confirmed: true,
            status: 'present',
            id,
            revision: 5,
            permissions: { canEdit: true },
            ...patch,
          },
          intent,
        ),
      ).toThrow();
  });
  it('name and active merge independently; same name needs explicit choice', () => {
    const base = categoryProjection(record),
      mine = { ...base, name: 'Моя назва' },
      server = { ...base, active: false };
    expect(resolveThreeWay(base, mine, server, nativeFields(categoryFields), {})).toEqual({
      ...mine,
      active: false,
    });
    const other = { ...server, name: 'Серверна назва' };
    expect(compareThreeWay(base, mine, other, nativeFields(categoryFields))[0]?.status).toBe(
      'conflict',
    );
    expect(
      resolveThreeWay(base, mine, other, nativeFields(categoryFields), { name: 'mine' }),
    ).toEqual({ ...mine, active: false });
  });
});
