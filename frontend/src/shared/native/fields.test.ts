import { describe, expect, it } from 'vitest';
import { compareThreeWay, resolveThreeWay } from '../merge/threeWay';
import { nativeFields } from './fields';

describe('native fields bridge', () => {
  const fields = nativeFields([
    { id: 'title', label: 'Назва', keys: ['title'] },
    {
      id: 'metric',
      label: 'Показник та ціль',
      keys: ['metric', 'unit', 'target'],
      decimals: ['target'],
    },
  ]);
  const base = { title: 'Пілот', metric: 'Продажі', unit: 'шт', target: '10.0000' };
  it('preserves independent server fields and never mutates snapshots', () => {
    const mine = { ...base, title: 'Мій пілот' },
      server = { ...base, target: '20' };
    expect(resolveThreeWay(base, mine, server, fields, {})).toEqual({
      ...server,
      title: 'Мій пілот',
    });
    expect(base.title).toBe('Пілот');
    expect(server.title).toBe('Пілот');
  });
  it('compares decimals exactly and requires one explicit choice for the whole metric group', () => {
    expect(compareThreeWay(base, { ...base, target: '010,0' }, base, fields)).toEqual([]);
    const mine = { ...base, target: '12' },
      server = { ...base, unit: 'кг' };
    expect(compareThreeWay(base, mine, server, fields)[0]?.status).toBe('conflict');
    expect(resolveThreeWay(base, mine, server, fields, {})).toBeNull();
    expect(resolveThreeWay(base, mine, server, fields, { metric: 'server' })).toEqual(server);
    expect(resolveThreeWay(base, mine, server, fields, { metric: 'mine' })).toEqual(mine);
  });
  it('formats responsible names while retaining authoritative IDs', () => {
    const names = nativeFields([
      {
        id: 'responsible',
        label: 'Відповідальний',
        keys: ['responsible'],
        valueLabels: { '1': 'Олена', '2': 'Тарас', '3': 'Збережений працівник · неактивний' },
      },
    ]);
    const base = { responsible: 1 },
      mine = { responsible: 2 },
      server = { responsible: 3 };
    expect(compareThreeWay(base, mine, server, names)[0]).toMatchObject({
      base: 'Олена',
      mine: 'Тарас',
      server: 'Збережений працівник · неактивний',
    });
    expect(resolveThreeWay(base, mine, server, names, { responsible: 'mine' })).toEqual({
      responsible: 2,
    });
  });
  it('rejects duplicate and unsafe application descriptors', () => {
    expect(() => nativeFields([{ id: 'x', label: 'X', keys: ['__proto__'] }])).toThrow();
    expect(() => nativeFields([{ id: 'x', label: 'X', keys: ['name', 'name'] }])).toThrow();
  });
});
