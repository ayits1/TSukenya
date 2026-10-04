import { describe, expect, it } from 'vitest';
import { compareThreeWay, resolveThreeWay } from '../merge/threeWay';
import { nativeFields } from './fields';
import {
  decodeBudgetTemplate,
  budgetTemplateFields,
  budgetTemplateProjection,
} from './budgetTemplate';
const baseline = {
  resource: 'budget-template',
  budgetStores: 2,
  revision: 'a'.repeat(64),
  source: 'legacy',
  canEdit: true,
};
describe('budget template recovery', () => {
  it('rejects missing policy, wrong resource/permission/version and malformed count', () => {
    for (const patch of [
      { resource: 'other' },
      { budgetStores: '2' },
      { budgetStores: true },
      { budgetStores: 0 },
      { budgetStores: 1001 },
      { revision: 'b'.repeat(32) },
      { source: ['legacy'] },
      { source: undefined },
      { canEdit: false },
      { canEdit: undefined },
    ])
      expect(() => decodeBudgetTemplate({ ...baseline, ...patch })).toThrow();
    expect(decodeBudgetTemplate(baseline).budgetStores).toBe(2);
  });
  it('requires explicit choice and includes no identity/settings fields in the draft', () => {
    const base = budgetTemplateProjection(decodeBudgetTemplate(baseline)),
      mine = { budgetStores: 3 },
      server = { budgetStores: 4 },
      fields = nativeFields(budgetTemplateFields());
    expect(compareThreeWay(base, mine, server, fields)[0]?.status).toBe('conflict');
    expect(resolveThreeWay(base, mine, server, fields, {})).toBeNull();
    expect(resolveThreeWay(base, mine, server, fields, { budgetStores: 'mine' })).toEqual(mine);
    expect(resolveThreeWay(base, mine, server, fields, { budgetStores: 'server' })).toEqual(server);
  });
});
