import type { NativeDraft, NativeField } from './fields';
export type BudgetTemplate = {
  resource: 'budget-template';
  budgetStores: number;
  revision: string;
  source: 'explicit' | 'legacy';
  canEdit: true;
};
export function decodeBudgetTemplate(value: unknown): BudgetTemplate {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('Некоректна відповідь бюджетного орієнтира. Повторіть читання.');
  const v = value as Record<string, unknown>;
  if (
    v.resource !== 'budget-template' ||
    !Number.isSafeInteger(v.budgetStores) ||
    Number(v.budgetStores) < 1 ||
    Number(v.budgetStores) > 1000 ||
    typeof v.revision !== 'string' ||
    !/^[a-f0-9]{64}$/.test(v.revision) ||
    (v.source !== 'explicit' && v.source !== 'legacy') ||
    v.canEdit !== true
  )
    throw Error('Кількість магазинів або права не підтверджено. Чернетка збережена.');
  return {
    resource: 'budget-template',
    budgetStores: v.budgetStores as number,
    revision: v.revision,
    source: v.source,
    canEdit: true,
  };
}
export const budgetTemplateFields = (): NativeField[] => [
  { id: 'budgetStores', label: 'Планова кількість магазинів', keys: ['budgetStores'] },
];
export const budgetTemplateProjection = (value: BudgetTemplate): NativeDraft => ({
  budgetStores: value.budgetStores,
});
