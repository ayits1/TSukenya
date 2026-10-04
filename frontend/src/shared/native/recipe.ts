import type { NativeDraft, NativeField } from './fields';
export const policies = {
  unspecified: 'Строк технологією не визначено',
  components_min: 'Найраніший відомий строк усієї сировини',
  minimum_with_shelf_life: 'Мінімум сировини та технологічного строку',
};
export type Component = { product: string; quantity: string; name?: string; unit?: string };
export type Version = {
  id: string;
  product: string;
  version: number;
  name: string;
  unit: string;
  outputQuantity: string;
  expiryPolicy: keyof typeof policies;
  shelfLifeDays: number | null;
  components: Component[];
  reason: string;
  approvedBy: string;
  approvedAt: string;
};
export type RecipeList = {
  product: { id: string; name: string; unit: string };
  catalogRevision: string;
  latestVersion: string | null;
  canApprove: boolean;
  items: Version[];
  legacyRecipe: Component[];
  page: number;
  pages: number;
  total: number;
  limit: 10 | 20 | 50;
};
export type LegacyRecipe = {
  product: RecipeList['product'];
  revision: string;
  recipe: Component[];
  canEdit: boolean;
};
const fail = (
  message = 'Не вдалося перевірити поточну рецептуру. Чернетка збережена; повторіть читання.',
): never => {
  throw Error(message);
};
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : fail();
const text = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v : fail());
export const productId = (v: unknown) =>
  typeof v === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(v) ? v : fail();
const uuid = (v: unknown) =>
  typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v) ? v : fail();
const revision = (v: unknown) => (typeof v === 'string' && /^[a-f0-9]{64}$/.test(v) ? v : fail());
export function quantity(v: unknown, legacy = false): string {
  const s = legacy && typeof v === 'number' && Number.isFinite(v) ? String(v) : v;
  if (typeof s !== 'string' || !/^(?:\d{1,15}(?:\.\d{1,3})?|\.\d{1,3})$/.test(s)) return fail();
  const [whole, fraction = ''] = s.split('.');
  const n = BigInt(whole || '0') * 1000n + BigInt(fraction.padEnd(3, '0'));
  if (n <= 0n || n > 999999999999999000n)
    return fail('Кількість: від 0,001, не більше трьох знаків після коми.');
  return `${n / 1000n}.${String(n % 1000n).padStart(3, '0')}`;
}
export function components(v: unknown, output: string, legacy = false): Component[] {
  if (!Array.isArray(v) || v.length > 100 || (!legacy && !v.length)) return fail();
  const seen = new Set<string>();
  return v.map((raw) => {
    const r = object(raw),
      product = productId(r.product);
    if (product === output) return fail('Готовий товар не може бути власним інгредієнтом.');
    if (seen.has(product))
      return fail('Інгредієнт не може повторюватись. Залиште один рядок із потрібною кількістю.');
    seen.add(product);
    return {
      product,
      quantity: quantity(r.quantity, legacy),
      ...(r.name === undefined ? {} : { name: text(r.name, 250) }),
      ...(r.unit === undefined ? {} : { unit: text(r.unit, 30) }),
    };
  });
}
function product(v: unknown, expected: string) {
  const p = object(v);
  if (productId(p.id) !== productId(expected)) return fail();
  return { id: expected, name: text(p.name, 250), unit: text(p.unit, 30) };
}
export function decodeVersion(v: unknown, expectedProduct: string, expectedId?: string): Version {
  const r = object(v),
    id = uuid(r.id);
  if (
    (expectedId !== undefined && id !== uuid(expectedId)) ||
    productId(r.product) !== productId(expectedProduct) ||
    typeof r.version !== 'number' ||
    !Number.isSafeInteger(r.version) ||
    r.version < 1
  )
    return fail();
  if (typeof r.expiryPolicy !== 'string' || !Object.hasOwn(policies, r.expiryPolicy)) return fail();
  const policy = r.expiryPolicy as Version['expiryPolicy'],
    shelf = r.shelfLifeDays;
  if (
    policy === 'minimum_with_shelf_life'
      ? !(typeof shelf === 'number' && Number.isSafeInteger(shelf) && shelf >= 1 && shelf <= 3650)
      : shelf !== null
  )
    return fail();
  const reason = text(r.reason, 500),
    approvedAt = text(r.approvedAt, 50);
  if (!reason.trim() || !Number.isFinite(Date.parse(approvedAt))) return fail();
  return {
    id,
    product: expectedProduct,
    version: r.version,
    name: text(r.name, 250),
    unit: text(r.unit, 30),
    outputQuantity: quantity(r.outputQuantity),
    expiryPolicy: policy,
    shelfLifeDays: shelf as number | null,
    components: components(r.components, expectedProduct),
    reason,
    approvedBy: text(r.approvedBy, 150),
    approvedAt,
  };
}
export function decodeList(
  v: unknown,
  expectedProduct: string,
  expectedPage = 1,
  expectedLimit: 10 | 20 | 50 = 20,
): RecipeList {
  const r = object(v),
    p = product(r.product, expectedProduct);
  if (
    !Array.isArray(r.items) ||
    ![10, 20, 50].includes(expectedLimit) ||
    r.limit !== expectedLimit ||
    r.items.length > expectedLimit ||
    typeof r.canApprove !== 'boolean' ||
    typeof r.total !== 'number' ||
    !Number.isSafeInteger(r.total) ||
    r.total < 0 ||
    r.total < r.items.length ||
    r.page !== expectedPage ||
    typeof r.pages !== 'number' ||
    !Number.isSafeInteger(r.pages) ||
    r.pages < expectedPage ||
    !Number.isSafeInteger(expectedPage) ||
    expectedPage < 1 ||
    r.pages !== Math.max(1, Math.ceil(r.total / expectedLimit)) ||
    r.items.length !==
      Math.max(0, Math.min(expectedLimit, r.total - (expectedPage - 1) * expectedLimit))
  )
    return fail();
  const items = r.items.map((x) => decodeVersion(x, expectedProduct)),
    latest = r.latestVersion === null ? null : uuid(r.latestVersion);
  if (
    new Set(items.map((x) => x.id)).size !== items.length ||
    items.some((x, i) => i > 0 && x.version >= items[i - 1]!.version) ||
    (r.total === 0
      ? latest !== null || items.length !== 0
      : latest === null || !items.length || (expectedPage === 1 && items[0]!.id !== latest))
  )
    return fail();
  return {
    product: p,
    items,
    total: r.total,
    limit: expectedLimit,
    page: expectedPage,
    pages: r.pages,
    canApprove: r.canApprove,
    catalogRevision: revision(r.catalogRevision),
    latestVersion: latest,
    legacyRecipe: components(r.legacyRecipe, expectedProduct, true),
  };
}
export function decodeLegacy(v: unknown, expectedProduct: string): LegacyRecipe {
  const r = object(v);
  if (typeof r.canEdit !== 'boolean') return fail();
  return {
    product: product(r.product, expectedProduct),
    revision: revision(r.revision),
    recipe: components(r.recipe, expectedProduct, true),
    canEdit: r.canEdit,
  };
}
export const encodeComponents = (rows: Component[]) =>
  JSON.stringify(
    rows
      .map(({ product, quantity: q }) => ({ product, quantity: quantity(q) }))
      .sort((a, b) => a.product.localeCompare(b.product)),
  );
export function projection(record: RecipeList | LegacyRecipe): NativeDraft {
  if ('recipe' in record) return { components: encodeComponents(record.recipe) };
  const latest = record.items[0];
  return {
    components: encodeComponents(latest?.components || record.legacyRecipe),
    outputQuantity: latest?.outputQuantity || '1.000',
    expiryPolicy: latest?.expiryPolicy || 'unspecified',
    shelfLifeDays: latest?.shelfLifeDays ?? null,
    reason: '',
  };
}
export function validateDraft(draft: NativeDraft, output: string, legacy = false): NativeDraft {
  let rows;
  try {
    rows = JSON.parse(String(draft.components));
  } catch {
    return fail();
  }
  const result: NativeDraft = { components: encodeComponents(components(rows, output, legacy)) };
  if (!legacy) {
    result.outputQuantity = quantity(draft.outputQuantity);
    if (typeof draft.expiryPolicy !== 'string' || !Object.hasOwn(policies, draft.expiryPolicy))
      return fail();
    result.expiryPolicy = draft.expiryPolicy;
    const shelf = draft.shelfLifeDays;
    if (
      draft.expiryPolicy === 'minimum_with_shelf_life'
        ? !(typeof shelf === 'number' && Number.isSafeInteger(shelf) && shelf >= 1 && shelf <= 3650)
        : shelf !== null
    )
      return fail();
    result.shelfLifeDays = shelf as number | null;
    result.reason = text(draft.reason, 500);
    if (!result.reason.trim()) return fail();
  }
  return result;
}
export function recipeFields(
  drafts: NativeDraft[],
  names: Record<string, string>,
  legacy = false,
): NativeField[] {
  const labels: Record<string, string> = {};
  for (const d of drafts) {
    const rows = JSON.parse(String(d.components)) as Component[];
    labels[String(d.components)] = rows.length
      ? rows.map((r) => `${names[r.product] || r.product}: ${r.quantity}`).join('; ')
      : 'Порожня рецептура';
  }
  return [
    {
      id: 'terms',
      label: legacy ? 'Склад рецептури' : 'Технологічні умови рецептури',
      keys: legacy
        ? ['components']
        : ['components', 'outputQuantity', 'expiryPolicy', 'shelfLifeDays'],
      decimals: legacy ? [] : ['outputQuantity'],
      labels: {
        components: 'Інгредієнти',
        outputQuantity: 'Нормативний вихід',
        expiryPolicy: 'Придатність',
        shelfLifeDays: 'Календарні дні',
      },
      keyValueLabels: { components: labels, expiryPolicy: policies },
    },
    ...(legacy ? [] : [{ id: 'reason', label: 'Причина нового затвердження', keys: ['reason'] }]),
  ];
}

/** A structurally valid version for the UUID still must confirm the immutable submitted terms. */
export function confirmVersion(
  value: unknown,
  payload: {
    idempotencyKey: string;
    product: string;
    outputQuantity: unknown;
    components: unknown;
    expiryPolicy: unknown;
    shelfLifeDays: unknown;
    reason: unknown;
  },
): Version {
  const saved = decodeVersion(value, payload.product, payload.idempotencyKey);
  if (
    saved.outputQuantity !== quantity(payload.outputQuantity) ||
    encodeComponents(saved.components) !==
      encodeComponents(components(payload.components, payload.product)) ||
    saved.expiryPolicy !== payload.expiryPolicy ||
    saved.shelfLifeDays !== payload.shelfLifeDays ||
    saved.reason !== text(payload.reason, 500).trim()
  )
    return fail();
  return saved;
}
