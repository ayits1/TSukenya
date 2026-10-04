import type { components } from '../../shared/api/abc.generated';
export type ABCReportData = components['schemas']['Report'];
export type ABCFilters = {
  from: string;
  to: string;
  store: string;
  aThreshold: string;
  bThreshold: string;
  q: string;
  class: '' | 'A' | 'B' | 'C' | 'unclassified';
};
const fail = () => {
  throw Object.assign(Error('Сервер повернув некоректний ABC-звіт. Повторіть читання.'), {
    protocol: true,
  });
};
function check(value: unknown): asserts value {
  if (!value) fail();
}
function object(value: unknown): Record<string, unknown> {
  check(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
const integer = (v: unknown, min = 0) => Number.isSafeInteger(v) && Number(v) >= min;
const text = (v: unknown): v is string => typeof v === 'string';
const decimal = (v: unknown, scale = 2): v is string =>
  text(v) && new RegExp(`^-?\\d+\\.\\d{${scale}}$`).test(v);
const nullable = (v: unknown, test: (v: unknown) => boolean) => v === null || test(v);
const day = (v: unknown): v is string =>
  text(v) &&
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  Number.isFinite(Date.parse(v + 'T12:00:00Z')) &&
  new Date(v + 'T12:00:00Z').toISOString().slice(0, 10) === v;
export const minor = (value: string) => BigInt(value.replace('.', ''));
export const thresholdValue = (value: string) =>
  /^\d{1,2}(?:\.\d{1,2})?$/.test(value) ? Number(value) : NaN;
const share = (v: unknown) => decimal(v, 4) && minor(v) >= 0n && minor(v) <= 1000000n;
const labels = ['A', 'B', 'C', 'unclassified'] as const;
const equalsKeys = (v: Record<string, unknown>, fields: string[]) =>
  Object.keys(v).length === fields.length && fields.every((k) => Object.hasOwn(v, k));
export function decodeABCReport(
  raw: unknown,
  expected: ABCFilters,
  requestedPage = 1,
): ABCReportData {
  const v = object(raw);
  check(
    equalsKeys(v, [
      'contract',
      'from',
      'to',
      'store',
      'scopeName',
      'aThreshold',
      'bThreshold',
      'basis',
      'reversalPolicy',
      'snapshot',
      'snapshotNotice',
      'generatedAt',
      'tiePolicy',
      'captionBasis',
      'summary',
      'items',
      'total',
      'page',
      'pages',
      'limit',
      'q',
      'class',
    ]),
  );
  check(
    v.contract === 'trading-abc-v1' &&
      v.basis === 'net_revenue' &&
      v.reversalPolicy === 'kyiv_reversed_at' &&
      v.snapshot === 'current' &&
      v.tiePolicy === 'before_group' &&
      v.captionBasis === 'first_contributing_line',
  );
  check(
    day(v.from) &&
      day(v.to) &&
      v.from <= v.to &&
      v.from === expected.from &&
      v.to === expected.to &&
      nullable(v.store, (x) => integer(x, 1)) &&
      v.store === (expected.store ? Number(expected.store) : null),
  );
  check(
    decimal(v.aThreshold) &&
      decimal(v.bThreshold) &&
      Number(v.aThreshold) === thresholdValue(expected.aThreshold) &&
      Number(v.bThreshold) === thresholdValue(expected.bThreshold) &&
      Number(v.aThreshold) > 0 &&
      Number(v.aThreshold) < Number(v.bThreshold) &&
      Number(v.bThreshold) < 100,
  );
  check(
    text(v.scopeName) &&
      text(v.snapshotNotice) &&
      text(v.generatedAt) &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(
        v.generatedAt,
      ) &&
      Number.isFinite(Date.parse(v.generatedAt)),
  );
  check(
    v.q === expected.q.trim() &&
      v.class === expected.class &&
      integer(v.total) &&
      integer(v.page, 1) &&
      integer(v.pages, 1) &&
      v.limit === 30 &&
      v.pages === Math.max(1, Math.ceil(Number(v.total) / 30)) &&
      v.page === Math.min(requestedPage, Number(v.pages)) &&
      Array.isArray(v.items) &&
      v.items.length === Math.min(30, Math.max(0, Number(v.total) - (Number(v.page) - 1) * 30)),
  );
  const s = object(v.summary);
  const counts = [
    'productCount',
    'positiveCount',
    'zeroCount',
    'negativeCount',
    'mixedUnitCount',
    'hiddenCount',
  ];
  const amounts = [
    'netRevenue',
    'positivePoolRevenue',
    'negativeRevenue',
    'netCogs',
    'grossProfit',
  ];
  check(
    equalsKeys(s, [...counts, ...amounts, 'classes']) &&
      counts.every((k) => integer(s[k])) &&
      amounts.every((k) => decimal(s[k])),
  );
  check(
    Number(s.productCount) ===
      Number(s.positiveCount) + Number(s.zeroCount) + Number(s.negativeCount) &&
      Number(s.mixedUnitCount) <= Number(s.productCount) &&
      Number(s.hiddenCount) <= Number(s.productCount) &&
      Number(v.total) <= Number(s.productCount),
  );
  check(
    minor(s.netRevenue as string) ===
      minor(s.positivePoolRevenue as string) + minor(s.negativeRevenue as string) &&
      minor(s.positivePoolRevenue as string) >= 0n &&
      minor(s.negativeRevenue as string) <= 0n &&
      minor(s.grossProfit as string) === minor(s.netRevenue as string) - minor(s.netCogs as string),
  );
  const classes = object(s.classes);
  check(equalsKeys(classes, [...labels]));
  let count = 0,
    revenue = 0n;
  for (const label of labels) {
    const c = object(classes[label]);
    check(
      equalsKeys(c, ['count', 'netRevenue', 'share']) &&
        integer(c.count) &&
        decimal(c.netRevenue) &&
        nullable(c.share, share),
    );
    count += Number(c.count);
    revenue += minor(c.netRevenue);
    check(
      label === 'unclassified'
        ? c.share === null &&
            Number(c.count) === Number(s.zeroCount) + Number(s.negativeCount) &&
            c.netRevenue === s.negativeRevenue
        : minor(c.netRevenue) >= 0n &&
            (minor(s.positivePoolRevenue as string) > 0n ? c.share !== null : c.share === null),
    );
  }
  check(count === s.productCount && revenue === minor(s.netRevenue as string));
  if (!expected.q.trim() && !expected.class) check(v.total === s.productCount);
  if (!expected.q.trim() && expected.class)
    check(v.total === object(classes[expected.class]).count);
  const occurrences = { A: 0, B: 0, C: 0, unclassified: 0 };
  const seen = new Set();
  for (const rawRow of v.items) {
    const r = object(rawRow);
    check(
      equalsKeys(r, [
        'product',
        'name',
        'unit',
        'unitConflicted',
        'hiddenCurrent',
        'quantity',
        'netRevenue',
        'netCogs',
        'grossProfit',
        'classification',
        'share',
        'cumulativeBefore',
        'cumulativeAfter',
      ]),
    );
    check(
      text(r.product) &&
        r.product.length > 0 &&
        !seen.has(r.product) &&
        text(r.name) &&
        typeof r.unitConflicted === 'boolean' &&
        typeof r.hiddenCurrent === 'boolean' &&
        nullable(r.unit, text) &&
        nullable(r.quantity, (x) => decimal(x, 3)) &&
        ['netRevenue', 'netCogs', 'grossProfit'].every((k) => decimal(r[k])) &&
        text(r.classification) &&
        labels.includes(r.classification as (typeof labels)[number]),
    );
    seen.add(r.product);
    occurrences[r.classification as keyof typeof occurrences]++;
    check(
      occurrences[r.classification as keyof typeof occurrences] <=
        Number(object(classes[r.classification as string]).count),
    );
    check(
      r.unitConflicted
        ? r.unit === null && r.quantity === null
        : r.unit !== null && r.quantity !== null,
    );
    check(
      minor(r.grossProfit as string) === minor(r.netRevenue as string) - minor(r.netCogs as string),
    );
    check(
      r.classification === 'unclassified'
        ? minor(r.netRevenue as string) <= 0n &&
            r.share === null &&
            r.cumulativeBefore === null &&
            r.cumulativeAfter === null
        : minor(r.netRevenue as string) > 0n &&
            share(r.share) &&
            share(r.cumulativeBefore) &&
            share(r.cumulativeAfter) &&
            minor(r.cumulativeBefore as string) <= minor(r.cumulativeAfter as string),
    );
    if (expected.class) check(r.classification === expected.class);
  }
  return v as ABCReportData;
}
export function abcParams(filters: ABCFilters, page?: number) {
  const params = new URLSearchParams(filters);
  if (page) params.set('page', String(page));
  return params;
}
export function createABCApi(transport: typeof fetch = fetch) {
  return {
    async read(filters: ABCFilters, page: number, signal?: AbortSignal) {
      const response = await transport('/api/v1/trading/reports/abc?' + abcParams(filters, page), {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        ...(signal ? { signal } : {}),
      });
      if (!response.ok)
        throw Object.assign(
          Error(
            response.status === 401
              ? 'Сеанс завершився.'
              : response.status === 403
                ? 'ABC-звіт недоступний за чинними правами.'
                : 'Не вдалося прочитати ABC-звіт. Повторіть запит.',
          ),
          { status: response.status },
        );
      let raw: unknown;
      try {
        raw = await response.json();
      } catch {
        fail();
      }
      return decodeABCReport(raw, filters, page);
    },
  };
}
export type ABCApi = ReturnType<typeof createABCApi>;
