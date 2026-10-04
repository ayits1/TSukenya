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
  const decoded: WorkShift = {
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
  captureWorkShiftDraft(workShiftProjection(decoded));
  return decoded;
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
function formDecimal(text: unknown, scale: number, max?: bigint, min = 0n): string {
  if (typeof text !== 'string' || !/^\d{1,16}(?:\.\d{1,4})?$/.test(text)) return fail();
  const normalized = String(decimalKey(text)),
    [whole = '0', fraction = ''] = normalized.split('.');
  if (fraction.length > scale) return fail();
  const units = BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, '0'));
  if (units < min || (max !== undefined && units > max)) return fail();
  return text;
}
/** Salary roles require explicit private terms before using a selected employee's defaults. */
export function employeeWorkTerms(
  value: unknown,
): Pick<WorkShift, 'shift_rate' | 'bonus_percent' | 'bonus_basis'> {
  const row = object(value);
  if (
    typeof row.bonus_basis !== 'string' ||
    !['store', 'personal', 'profit'].includes(row.bonus_basis)
  )
    return fail();
  return {
    shift_rate: formDecimal(row.shift_rate, 2),
    bonus_percent: formDecimal(row.bonus_percent, 3, 100000n),
    bonus_basis: row.bonus_basis as WorkShift['bonus_basis'],
  };
}
/** Form validation only; Django still calculates and stores amounts and payroll. */
export function captureWorkShiftDraft(value: Record<string, unknown>): NativeDraft {
  const cash = value.cash_shift,
    terms = employeeWorkTerms(value);
  if (
    typeof cash !== 'string' ||
    (cash !== '' && (!/^[1-9]\d*$/.test(cash) || !Number.isSafeInteger(Number(cash))))
  )
    return fail();
  if (cash === '' && decimalKey(terms.bonus_percent) !== '0') return fail();
  if (typeof value.note !== 'string' || value.note.length > 2000) return fail();
  return {
    cash_shift: cash,
    units: formDecimal(value.units, 2, 1000n, 1n),
    ...terms,
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
