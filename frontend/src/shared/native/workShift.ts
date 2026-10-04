import type { NativeDraft, NativeField } from './fields';
import { decimalKey } from '../merge/threeWay';

export type WorkShift = {
  id: number;
  employee_id: number;
  store_id: number;
  date: string;
  cash_shift_id: number | null;
  units: string;
  shift_rate: string;
  bonus_percent: string;
  bonus_basis: 'store' | 'personal' | 'profit';
  accrued: string;
  basis_amount: string;
  payroll_id: number | null;
  note: string;
  revision: string;
};
const fail = (): never => {
  throw new Error(
    'Не вдалося перевірити актуальний табель. Ваші поля збережено; повторіть читання.',
  );
};
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : fail();
const id = (value: unknown): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fail();
const nullableId = (value: unknown) => (value === null ? null : id(value));
const decimal = (value: unknown, signed = false): string =>
  typeof value === 'string' &&
  (signed ? /^-?\d{1,16}(?:\.\d{1,4})?$/ : /^\d{1,16}(?:\.\d{1,4})?$/).test(value)
    ? value
    : fail();
const day = (value: unknown): string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return fail();
  const parsed = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
    ? value
    : fail();
};
/** Exact ID read; partial pages and another resource cannot become an edit baseline. */
export function decodeWorkShift(value: unknown, expectedId: number): WorkShift {
  const page = object(value);
  if (
    page.total !== 1 ||
    page.page !== 1 ||
    page.pages !== 1 ||
    !Array.isArray(page.items) ||
    page.items.length !== 1
  )
    return fail();
  const row = object(page.items[0]);
  if (
    id(row.id) !== expectedId ||
    typeof row.note !== 'string' ||
    row.note.length > 2000 ||
    typeof row.revision !== 'string' ||
    !/^[0-9a-f]{32}$/.test(row.revision)
  )
    return fail();
  if (
    !['store', 'personal', 'profit'].includes(String(row.bonus_basis)) ||
    typeof row.bonus_basis !== 'string'
  )
    return fail();
  return {
    id: expectedId,
    employee_id: id(row.employee_id),
    store_id: id(row.store_id),
    date: day(row.date),
    cash_shift_id: nullableId(row.cash_shift_id),
    units: decimal(row.units),
    shift_rate: decimal(row.shift_rate),
    bonus_percent: decimal(row.bonus_percent),
    bonus_basis: row.bonus_basis as WorkShift['bonus_basis'],
    accrued: decimal(row.accrued, true),
    basis_amount: decimal(row.basis_amount, true),
    payroll_id: nullableId(row.payroll_id),
    note: row.note,
    revision: row.revision,
  };
}
export function workShiftIdentityMatches(
  before: Pick<WorkShift, 'id' | 'employee_id' | 'store_id' | 'date'>,
  after: WorkShift,
): boolean {
  return (
    before.id === after.id &&
    before.employee_id === after.employee_id &&
    before.store_id === after.store_id &&
    before.date === after.date
  );
}
/** Only editable business terms. Payroll totals, identity and revision never enter merge output. */
export function workShiftProjection(row: WorkShift): NativeDraft {
  return {
    cash_shift: row.cash_shift_id === null ? '' : String(row.cash_shift_id),
    units: row.units,
    shift_rate: row.shift_rate,
    bonus_percent: row.bonus_percent,
    bonus_basis: row.bonus_basis,
    note: row.note,
  };
}
/** Form validation only; Django still calculates and stores amounts and payroll. */
export function captureWorkShiftDraft(value: Record<string, unknown>): NativeDraft {
  const amount = (key: string, scale: number, max?: bigint) => {
    const text = value[key];
    if (typeof text !== 'string' || !/^\d{1,16}(?:\.\d{1,4})?$/.test(text)) return fail();
    const normalized = String(decimalKey(text)),
      [whole = '0', fraction = ''] = normalized.split('.');
    if (fraction.length > scale) return fail();
    const units = BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, '0'));
    if ((key === 'units' && units < 1n) || (max !== undefined && units > max)) return fail();
    return text;
  };
  const cash = value.cash_shift;
  if (
    typeof cash !== 'string' ||
    (cash !== '' && (!/^[1-9]\d*$/.test(cash) || !Number.isSafeInteger(Number(cash))))
  )
    return fail();
  const percent = amount('bonus_percent', 3, 100000n);
  if (cash === '' && decimalKey(percent) !== '0') return fail();
  if (
    typeof value.note !== 'string' ||
    value.note.length > 2000 ||
    !['store', 'personal', 'profit'].includes(String(value.bonus_basis)) ||
    typeof value.bonus_basis !== 'string'
  )
    return fail();
  return {
    cash_shift: cash,
    units: amount('units', 2, 1000n),
    shift_rate: amount('shift_rate', 2),
    bonus_percent: percent,
    bonus_basis: value.bonus_basis,
    note: value.note,
  };
}
export function workShiftFields(captions: Record<string, string>): NativeField[] {
  return [
    {
      id: 'terms',
      label: 'Касова зміна та умови оплати',
      keys: ['cash_shift', 'units', 'shift_rate', 'bonus_percent', 'bonus_basis'],
      decimals: ['units', 'shift_rate', 'bonus_percent'],
      labels: {
        cash_shift: 'Касова зміна',
        units: 'Кількість змін',
        shift_rate: 'Ставка, грн',
        bonus_percent: 'Відсоток',
        bonus_basis: 'База відсотка',
      },
      keyValueLabels: {
        cash_shift: { ...captions, '': 'Без касової зміни' },
        bonus_basis: {
          store: 'Виторг магазину',
          personal: 'Особисті продажі',
          profit: 'Валовий прибуток',
        },
      },
    },
    { id: 'note', label: 'Примітка', keys: ['note'] },
  ];
}
