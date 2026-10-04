import { describe, expect, it } from 'vitest';
import { compareThreeWay, resolveThreeWay } from '../merge/threeWay';
import { nativeFields } from './fields';
import {
  captureEntityCreate,
  decodeEntityIdentity,
  decodeEntityReceipt,
  decodeEntity,
  entityFields,
  entityIdentityMatches,
  entityProjection,
} from './entity';
const employee = {
  type: 'employees',
  id: '4',
  name: 'Олена',
  revision: 'a'.repeat(32),
  store_id: 2,
  active: false,
  shift_rate: '100.00',
  bonus_percent: '2.000',
  bonus_basis: 'store',
  payroll_debt: '999',
};
describe('native entity recovery', () => {
  it('refuses absent or malformed payroll terms/revision/identity instead of defaulting', () => {
    for (const patch of [
      { shift_rate: undefined },
      { bonus_percent: undefined },
      { bonus_basis: undefined },
      { active: undefined },
      { revision: undefined },
      { revision: 'x' },
      { id: '5' },
      { bonus_basis: ['store'] },
      { store_id: 0 },
      { bonus_percent: '101' },
    ])
      expect(() => decodeEntity('employees', { ...employee, ...patch }, '4')).toThrow();
    expect(decodeEntity('employees', employee, '4').active).toBe(false);
  });
  it('merges server name but keeps the chosen complete payroll group, never computed fields', () => {
    const base = decodeEntity('employees', employee, '4'),
      mine = { ...base, shift_rate: '125.00' },
      server = { ...base, name: 'Нова назва', bonus_percent: '3.000', bonus_basis: 'profit' };
    const fields = nativeFields(entityFields('employees'));
    expect(
      compareThreeWay(base, mine, server, fields).find((row) => row.id === 'payTerms')?.status,
    ).toBe('conflict');
    expect(resolveThreeWay(base, mine, server, fields, {})).toBeNull();
    const merged = resolveThreeWay(
      entityProjection('employees', base),
      entityProjection('employees', mine),
      entityProjection('employees', server),
      fields,
      { payTerms: 'mine' },
    );
    expect(merged).toEqual({
      name: 'Нова назва',
      shift_rate: '125.00',
      bonus_percent: '2.000',
      bonus_basis: 'store',
      active: false,
    });
  });
  it('excludes immutable identity and detects store/kind drift', () => {
    const base = decodeEntity('employees', employee, '4');
    expect(entityIdentityMatches(base, { ...base, store_id: 3 })).toBe(false);
    expect(entityFields('accounts').flatMap((field) => field.keys)).toEqual(['name']);
    expect(() =>
      decodeEntity(
        'parties',
        {
          type: 'parties',
          id: '1',
          name: 'A',
          revision: 'a'.repeat(32),
          kind: 'customer',
          active: true,
          phone: '',
          email: '',
        },
        '1',
      ),
    ).toThrow();
  });
});

// Create acknowledgements bind the frozen normalized request, never the newer form.
describe('entity create receipt contract', () => {
  const key = '12345678-1234-4234-8234-123456789012';
  const body = {
    name: 'Олена',
    store: 2,
    active: false,
    shift_rate: '100',
    bonus_percent: '2',
    bonus_basis: 'store',
  };
  const ack = { id: '4', type: 'employees', request_key: key, original: employee };
  it('binds UUID/resource/ID and every original writable term', () => {
    expect(decodeEntityReceipt('employees', ack, key, body).shift_rate).toBe('100.00');
    for (const bad of [
      { ...ack, request_key: key + 'x' },
      { ...ack, type: 'parties' },
      { ...ack, id: '5' },
      { ...ack, original: { ...employee, name: 'Інша' } },
      { ...ack, original: { ...employee, shift_rate: '999' } },
      { ...ack, original: { ...employee, store_id: 3 } },
    ])
      expect(() => decodeEntityReceipt('employees', bad, key, body)).toThrow();
  });
  it('refuses malformed identity and distinguishes deleted original without inventing a baseline', () => {
    expect(
      decodeEntityIdentity('employees', { ...ack, confirmed: true, exists: false }, key, body),
    ).toMatchObject({ confirmed: true, exists: false });
    expect(
      decodeEntityIdentity(
        'employees',
        { type: 'employees', request_key: key, confirmed: false },
        key,
        body,
      ),
    ).toEqual({ confirmed: false });
    for (const bad of [
      { ...ack, confirmed: 'true', exists: true },
      { ...ack, confirmed: true },
      { ...ack, confirmed: false },
      { ...ack, confirmed: true, exists: 1 },
    ])
      expect(() => decodeEntityIdentity('employees', bad, key, body)).toThrow();
  });
  it('normalizes first-intent decimals and refuses invalid money/percent/identity before binding', () => {
    expect(
      captureEntityCreate('employees', {
        ...body,
        name: ' Олена ',
        store: '2',
        shift_rate: '0100.00',
        bonus_percent: '2.000',
      }),
    ).toEqual(body);
    for (const patch of [
      { shift_rate: '100.001' },
      { shift_rate: '1000000000000' },
      { bonus_percent: '100.001' },
      { store: 0 },
      { active: 'false' },
    ])
      expect(() => captureEntityCreate('employees', { ...body, ...patch })).toThrow();
  });
});
