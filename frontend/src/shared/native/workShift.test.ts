import { describe, expect, it } from 'vitest';
import { compareThreeWay, resolveThreeWay } from '../merge/threeWay';
import { nativeFields } from './fields';
import {
  captureWorkShiftDraft,
  decodeWorkShift,
  workShiftFields,
  workShiftIdentityMatches,
  workShiftProjection,
} from './workShift';

const row = {
  id: 1,
  employee_id: 2,
  store_id: 3,
  date: '2026-10-04',
  cash_shift_id: 1,
  units: '1.00',
  shift_rate: '100.00',
  bonus_percent: '10.000',
  bonus_basis: 'store',
  accrued: '0.00',
  basis_amount: '-10.00',
  payroll_id: null,
  note: 'Початок',
  revision: 'a'.repeat(32),
};
const page = (value: unknown = row) => ({ total: 1, page: 1, pages: 1, items: [value] });
describe('work shift conflict contract', () => {
  it('requires complete exact-resource DTO and immutable identity', () => {
    const decoded = decodeWorkShift(page(), 1);
    expect(workShiftIdentityMatches(decoded, { ...decoded, note: 'Нова примітка' })).toBe(true);
    for (const change of [{ id: 4 }, { employee_id: 4 }, { store_id: 4 }, { date: '2026-10-03' }])
      expect(workShiftIdentityMatches(decoded, { ...decoded, ...change })).toBe(false);
    for (const bad of [
      null,
      { id: 1, name: 'Довідник' },
      { ...row, id: 2 },
      { ...row, date: '2026-02-30' },
      { ...row, revision: [] },
      { ...row, units: 1 },
      { ...row, store_id: '3' },
      { ...row, payroll_id: undefined },
      { ...row, bonus_basis: ['store'] },
    ])
      expect(() => decodeWorkShift(page(bad), 1)).toThrow();
    expect(() => decodeWorkShift({ ...page(), total: 2 }, 1)).toThrow();
  });
  it('preserves independent server payment terms and local note using existing three-way', () => {
    const base = workShiftProjection(decodeWorkShift(page(), 1)),
      mine = { ...base, note: 'Моя примітка' },
      server = { ...base, shift_rate: '150.00' };
    expect(
      resolveThreeWay(
        base,
        mine,
        server,
        nativeFields(workShiftFields({ '1': 'Каса «Перша»' })),
        {},
      ),
    ).toEqual({ ...server, note: mine.note });
    for (const key of [
      'revision',
      'id',
      'accrued',
      'basis_amount',
      'payroll_id',
      'employee_id',
      'store_id',
      'date',
    ])
      expect(Object.hasOwn(base, key)).toBe(false);
  });
  it('requires atomic terms choice without mislabeling amount 1 as till ID1', () => {
    const base = workShiftProjection(decodeWorkShift(page(), 1)),
      mine = { ...base, units: '2' },
      server = { ...base, shift_rate: '1.00' };
    const fields = nativeFields(workShiftFields({ '1': 'Каса «Перша»' })),
      rows = compareThreeWay(base, mine, server, fields);
    expect(rows[0]?.status).toBe('conflict');
    expect(rows[0]?.base).toContain('Касова зміна: Каса «Перша»');
    expect(rows[0]?.base).toContain('Кількість змін: 1.00');
    expect(rows[0]?.server).toContain('Ставка, грн: 1.00');
    expect(resolveThreeWay(base, mine, server, fields, {})).toBeNull();
    expect(resolveThreeWay(base, mine, server, fields, { terms: 'mine' })).toEqual(mine);
  });
  it('validates captured form scalars exactly without money calculations', () => {
    const draft = workShiftProjection(decodeWorkShift(page(), 1));
    expect(
      captureWorkShiftDraft({ ...draft, units: '01.00', bonus_percent: '010.000' }),
    ).toMatchObject({ units: '01.00', bonus_percent: '010.000' });
    for (const change of [
      { shift_rate: '' },
      { units: '0' },
      { units: '10.01' },
      { bonus_percent: '100.001' },
      { cash_shift: '' },
      { cash_shift: '1x' },
      { shift_rate: '1.001' },
      { bonus_basis: ['store'] },
    ])
      expect(() => captureWorkShiftDraft({ ...draft, ...change })).toThrow();
    expect(captureWorkShiftDraft({ ...draft, cash_shift: '', bonus_percent: '0' }).cash_shift).toBe(
      '',
    );
  });
});
