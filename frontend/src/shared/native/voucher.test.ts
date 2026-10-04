import { describe, expect, it } from 'vitest';
import {
  captureVoucherDraft,
  decodeVoucherAck,
  decodeVoucherIdentity,
  validateVoucherMerge,
  decodeVoucher,
  voucherFromProjection,
  voucherProjection,
} from './voucher';
import { compareThreeWay, resolveThreeWay } from '../merge/threeWay';
import { nativeFields } from './fields';
import { voucherFields } from './voucher';
const key = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const raw = {
  id: 1,
  revision: 1,
  status: 'draft',
  kind: 'receipt',
  date: '2026-10-04',
  store: 1,
  warehouse: 2,
  target: null,
  party: 3,
  employee: null,
  account: null,
  shift: null,
  reference: null,
  total: '10.00',
  note: 'Початкова',
  payload: { payments: [] },
  lines: [
    {
      id: 4,
      line_key: key,
      reference_line: null,
      product: 'flour',
      name: 'Борошно',
      unit: 'кг',
      quantity: '2.000',
      price: '5.0000',
      amount: '10.00',
      lot: 'A',
      expiry: '',
    },
  ],
  editing: { role: 'owner', storeId: null, closedThrough: null, storeActive: true, canEdit: true },
};
describe('voucher recovery contract', () => {
  it('decodes exact resource/role/scope and rejects malformed semantic terms before baseline', () => {
    expect(decodeVoucher(raw, { id: 1, kind: 'receipt' }).revision).toBe(1);
    for (const changed of [
      { id: 2 },
      { kind: 'sale' },
      { revision: '1' },
      { total: '1.00001' },
      { payload: [] },
      { account: undefined },
      { lines: [{ ...raw.lines[0], quantity: '0' }] },
      { lines: [{ ...raw.lines[0], price: '1.00001' }] },
      { lines: [{ ...raw.lines[0], line_key: 'wrong' }] },
      { editing: { ...raw.editing, storeId: 9 } },
      { editing: { ...raw.editing, storeId: undefined } },
      { editing: { ...raw.editing, storeId: '1' } },
      { lines: [{ ...raw.lines[0], reference_line: '4' }] },
      { editing: { ...raw.editing, role: 'cashier' } },
      { editing: { ...raw.editing, closedThrough: '2026-10-04' } },
    ])
      expect(() => decodeVoucher({ ...raw, ...changed }, { id: 1, kind: 'receipt' })).toThrow();
  });
  it('keeps readable readonly posted/closed records without cost or writable server fields', () => {
    const record = decodeVoucher(
      { ...raw, status: 'posted', editing: { ...raw.editing, canEdit: false } },
      { id: 1, kind: 'receipt' },
    );
    expect(record.editing?.canEdit).toBe(false);
    expect(voucherFromProjection(voucherProjection(record))).not.toHaveProperty('revision');
    expect(voucherFromProjection(voucherProjection(record))).not.toHaveProperty('cost');
    expect(
      decodeVoucher(
        { ...raw, editing: { ...raw.editing, closedThrough: '2026-10-04', canEdit: false } },
        { id: 1, kind: 'receipt' },
      ).editing?.canEdit,
    ).toBe(false);
  });
  it('merges independent note with whole server financial terms and requires a choice for conflicting terms', () => {
    const body = decodeVoucher(raw, { id: 1, kind: 'receipt' }),
      base = voucherProjection(body),
      mine = voucherProjection({ ...body, note: 'Моя примітка' }),
      server = voucherProjection({ ...body, lines: [{ ...body.lines[0], quantity: '3' }] });
    const fields = nativeFields(voucherFields({}));
    expect(compareThreeWay(base, mine, server, fields).every((r) => r.status !== 'conflict')).toBe(
      true,
    );
    const result = resolveThreeWay(base, mine, server, fields, {});
    expect(voucherFromProjection(result!).note).toBe('Моя примітка');
    expect(voucherFromProjection(result!).lines[0]?.quantity).toBe('3');
    const other = voucherProjection({ ...body, store: 9 });
    expect(resolveThreeWay(base, other, server, fields, {})).toBeNull();
  });
  it('compares approved production facts without its redundant server recipe snapshot', () => {
    const production = {
      ...raw,
      kind: 'production',
      payload: {
        recipe: [{ product: 'legacy', quantity: '2' }],
        production: {
          source: 'version',
          terms: { id: key },
          plannedOutput: '10.000',
          components: [{ product: 'raw', quantity: '20.000' }],
          varianceReason: 'Умови',
        },
      },
    };
    const record = decodeVoucher(production, { id: 1, kind: 'production' });
    const fromForm = captureVoucherDraft({
      ...raw,
      kind: 'production',
      payload: {
        production: {
          recipeVersion: key,
          plannedOutput: '10',
          actualComponents: [{ product: 'raw', quantity: '20', lot: '' }],
          varianceReason: 'Умови',
        },
      },
    });
    expect(voucherProjection(record)).toEqual(voucherProjection(fromForm));
  });
  it('binds ACK to exact UUID and normalized writable terms, and separates aggregate output bounds', () => {
    const request = { ...captureVoucherDraft(raw), idempotency_key: key };
    expect(decodeVoucherAck({ ...raw, request_key: key }, request).id).toBe(1);
    for (const changed of [
      { request_key: 'other' },
      { note: 'Other' },
      { lines: [{ ...raw.lines[0], quantity: '3' }] },
    ])
      expect(() => decodeVoucherAck({ ...raw, request_key: key, ...changed }, request)).toThrow();
    const expense = {
      ...raw,
      kind: 'expense',
      lines: [],
      payload: { expense_scope: 'store' },
      total: '10.00',
    };
    const expenseRequest = { ...captureVoucherDraft(expense), idempotency_key: key };
    expect(() =>
      decodeVoucherAck({ ...expense, request_key: key, total: '999.00' }, expenseRequest),
    ).toThrow();
    const huge = {
      ...raw,
      total: '1999999999998.00',
      cost: '1999999999998.00',
      lines: [{ ...raw.lines[0], price: '999999999999.0000', cost: '1999999999998.00' }],
    };
    expect(decodeVoucher(huge, { id: 1, kind: 'receipt' }).total).toBe('1999999999998');
    expect(() => captureVoucherDraft({ ...expense, total: '1000000000000.00' })).toThrow();
    expect(captureVoucherDraft({ ...expense, kind: 'payroll', total: undefined }).amount).toBe('0');
  });
  it('validates identity receipt policy without adopting its current revision or merging closed/local foreign terms', () => {
    const request = { ...captureVoucherDraft(raw), idempotency_key: key };
    const identity = {
      confirmed: true,
      idempotencyKey: key,
      id: 1,
      kind: 'receipt',
      revision: 3,
      status: 'draft',
      store: 1,
      date: raw.date,
      editing: { ...raw.editing, canEdit: false, closedThrough: raw.date },
    };
    expect(decodeVoucherIdentity(identity, request).confirmed).toBe(true);
    expect(() =>
      decodeVoucherIdentity({ ...identity, idempotencyKey: 'other' }, request),
    ).toThrow();
    const row = decodeVoucher(
      { ...raw, editing: { ...raw.editing, storeId: 1, closedThrough: '2026-10-02' } },
      { id: 1, kind: 'receipt' },
    );
    expect(() =>
      validateVoucherMerge(voucherProjection({ ...request, date: '2026-10-01' }), row),
    ).toThrow();
    expect(() => validateVoucherMerge(voucherProjection({ ...request, store: 2 }), row)).toThrow();
  });
  it('preserves stable lineage and validates allocation/source IDs and scale', () => {
    const body = captureVoucherDraft(raw);
    expect(body.lines[0]?.line_key).toBe(key);
    expect(body.lines[0]?.product).toBe('flour');
    const payment = {
      kind: 'payment',
      date: raw.date,
      store: 1,
      party: 3,
      account: 1,
      amount: '10',
      note: '',
      payload: {},
      allocations: [{ source: 1, amount: '5.00' }],
    };
    expect(captureVoucherDraft(payment).allocations?.[0]?.amount).toBe('5');
    for (const allocations of [
      [{ source: 0, amount: '5' }],
      [{ source: 1, amount: '5.001' }],
      [{ source: 1, amount: '10.01' }],
      [
        { source: 1, amount: '5' },
        { source: 1, amount: '5' },
      ],
    ])
      expect(() => captureVoucherDraft({ ...payment, allocations })).toThrow();
    expect(() =>
      captureVoucherDraft({ ...payment, kind: 'advance_allocation', reference: 3 }),
    ).toThrow();
    expect(() => captureVoucherDraft({ ...payment, reference: 1 })).toThrow();
  });
});
