export type MergeChoice = 'mine' | 'server';
export type MergeChoices = Record<string, MergeChoice>;
export type MergeField<T> = {
  id: string;
  label: string;
  read: (value: T) => unknown;
  /** Return a new target with this field/group copied from source. */
  write: (target: T, source: T) => T;
  equal?: (a: unknown, b: unknown) => boolean;
  format?: (value: unknown) => string;
};
export type MergeRow = {
  id: string;
  label: string;
  base: string;
  mine: string;
  server: string;
  status: 'mine' | 'server' | 'same' | 'conflict';
};

/** Object key order is irrelevant; array order and absent properties remain meaningful. */
export function mergeEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => mergeEqual(v, b[i]))
    );
  const left = Object.keys(a),
    right = Object.keys(b);
  return (
    left.length === right.length &&
    left.every(
      (key) => Object.hasOwn(b, key) && mergeEqual(Reflect.get(a, key), Reflect.get(b, key)),
    )
  );
}

/** Comparison only: no floating-point conversion, rounding or price calculation. */
export function decimalKey(value: unknown): unknown {
  if (typeof value !== 'string' || !/^[+-]?\d+(?:[.,]\d+)?$/.test(value.trim())) return value;
  const text = value.trim().replace(',', '.'),
    negative = text.startsWith('-');
  const [integer = '0', fraction = ''] = text.replace(/^[+-]/, '').split('.');
  const whole = integer.replace(/^0+(?=\d)/, ''),
    part = fraction.replace(/0+$/, '');
  const zero = whole === '0' && !part;
  return `${negative && !zero ? '-' : ''}${whole}${part ? '.' + part : ''}`;
}

function status<T>(base: T, mine: T, server: T, field: MergeField<T>): MergeRow['status'] | null {
  const equal = field.equal || mergeEqual,
    before = field.read(base),
    local = field.read(mine),
    remote = field.read(server);
  const localChanged = !equal(before, local),
    serverChanged = !equal(before, remote);
  if (!localChanged && !serverChanged) return null;
  if (equal(local, remote)) return 'same';
  if (!localChanged) return 'server';
  if (!serverChanged) return 'mine';
  return 'conflict';
}

const format = (value: unknown): string =>
  value == null || value === ''
    ? 'Не задано'
    : typeof value === 'boolean'
      ? value
        ? 'Так'
        : 'Ні'
      : String(value);

export function compareThreeWay<T>(
  base: T,
  mine: T,
  server: T,
  fields: MergeField<T>[],
): MergeRow[] {
  return fields.flatMap((field) => {
    const change = status(base, mine, server, field);
    if (!change) return [];
    const display = field.format || format;
    return [
      {
        id: field.id,
        label: field.label,
        base: display(field.read(base)),
        mine: display(field.read(mine)),
        server: display(field.read(server)),
        status: change,
      },
    ];
  });
}

/** Starts from the fresh server baseline; unresolved conflicts never produce a draft. */
export function resolveThreeWay<T>(
  base: T,
  mine: T,
  server: T,
  fields: MergeField<T>[],
  choices: MergeChoices,
): T | null {
  let result = server;
  for (const field of fields) {
    const change = status(base, mine, server, field);
    if (change === 'conflict' && !choices[field.id]) return null;
    if (change === 'mine' || (change === 'conflict' && choices[field.id] === 'mine'))
      result = field.write(result, mine);
  }
  return result;
}
