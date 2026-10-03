/** Read-only price context; raw product promotion fields remain editor inputs. */
export type PriceContext = { storeId: number | null; storeName: string | null };
export type EffectivePromotion = {
  source: 'legacy' | 'campaign';
  id: string | null;
  name: string;
  price: string;
  startsOn: string | null;
  endsOn: string | null;
  revision: number | null;
};
export type EffectivePricing = {
  effectivePromotion?: EffectivePromotion | null;
  effectiveDay?: string;
  effectivePriceRevision?: string;
  priceContext?: PriceContext;
};
const amount = (v: unknown) => typeof v === 'string' && /^\d+\.\d{2}$/.test(v);
const day = (v: unknown) =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v));
export function validateRequiredEffectivePricing(
  v: Record<string, unknown>,
): asserts v is Record<string, unknown> & Required<EffectivePricing> {
  if (
    ['effectivePromotion', 'effectiveDay', 'effectivePriceRevision', 'priceContext'].some(
      (key) => !(key in v),
    )
  )
    throw new Error('Invalid product price preview context');
  validateEffectivePricing(v);
}
export function validateEffectivePricing(v: Record<string, unknown>): void {
  if (
    !['effectivePromotion', 'effectiveDay', 'effectivePriceRevision', 'priceContext'].some(
      (k) => k in v,
    )
  )
    return;
  if (
    !day(v.effectiveDay) ||
    typeof v.effectivePriceRevision !== 'string' ||
    !/^[0-9a-f]{64}$/.test(v.effectivePriceRevision)
  )
    throw new Error('Invalid effective price version');
  const c = v.priceContext;
  if (
    !c ||
    typeof c !== 'object' ||
    Array.isArray(c) ||
    !('storeId' in c) ||
    !('storeName' in c) ||
    !(c.storeId === null || (Number.isSafeInteger(c.storeId) && Number(c.storeId) > 0)) ||
    !(c.storeName === null || (typeof c.storeName === 'string' && !!c.storeName)) ||
    (c.storeId === null) !== (c.storeName === null)
  )
    throw new Error('Invalid effective price context');
  const p = v.effectivePromotion;
  if (p === null) return;
  if (!p || typeof p !== 'object' || Array.isArray(p))
    throw new Error('Invalid effective promotion');
  const r = p as Record<string, unknown>;
  if (
    typeof r.name !== 'string' ||
    !amount(r.price) ||
    !(
      (r.source === 'legacy' &&
        r.id === null &&
        r.startsOn === null &&
        r.endsOn === null &&
        r.revision === null) ||
      (r.source === 'campaign' &&
        typeof r.id === 'string' &&
        /^[0-9a-f-]{36}$/.test(r.id) &&
        day(r.startsOn) &&
        day(r.endsOn) &&
        String(r.startsOn) <= String(r.endsOn) &&
        Number.isSafeInteger(r.revision) &&
        Number(r.revision) > 0)
    )
  )
    throw new Error('Invalid effective promotion');
}
