/** Synthetic bounded protocol for stories; never used by production. */
import { referenceKey, type ReferenceData } from './api';
import type {
  ReferenceDirectoryApi,
  ManagedReference,
  ReferenceQuery,
} from './referenceDirectoryApi';
export function fixtureReferenceDirectory(
  read: () => Promise<Pick<ReferenceData, 'items' | 'canEdit' | 'archivedItems'>>,
): ReferenceDirectoryApi {
  async function records() {
    const data = await read();
    const items: ManagedReference[] = [
      ...data.items.map((item) => ({
        ...item,
        state: ('state' in item ? item.state : 'active') as ManagedReference['state'],
      })),
      ...(data.archivedItems || []).map((item) => ({ ...item, state: 'archived' as const })),
    ].map((raw) => {
      const item = raw as ManagedReference;
      return {
        ...item,
        parentId:
          item.parentId ??
          (item.field === 'category'
            ? data.items.find(
                (group) =>
                  group.field === 'type' &&
                  referenceKey(group.value) === referenceKey(item.parentType),
              )?.id || null
            : null),
        mergedInto: item.mergedInto ?? null,
        revision: item.revision || 'a'.repeat(64),
      };
    });
    return { items, canEdit: data.canEdit };
  }
  return {
    async page(query: ReferenceQuery, page = 1) {
      const data = await records();
      const all = data.items.filter(
        (item) =>
          item.field === query.field &&
          item.state === query.state &&
          item.value.toLocaleLowerCase('uk-UA').includes(query.q.toLocaleLowerCase('uk-UA')) &&
          (query.parentId === null || item.parentId === query.parentId) &&
          (query.parentType === null || item.parentType === query.parentType),
      );
      const total = all.length,
        pages = Math.max(1, Math.ceil(total / 30));
      page = Math.min(page, pages);
      return {
        contract: 'catalog-reference-page-v1',
        items: all.slice((page - 1) * 30, page * 30),
        total,
        page,
        pages,
        limit: 30,
        query,
        canEdit: data.canEdit,
        csrf: 'synthetic',
      };
    },
    async details(selected) {
      const data = await records();
      return {
        contract: 'catalog-reference-details-v1',
        canEdit: data.canEdit,
        items: selected.map((value) => {
          const item =
            data.items.find((item) =>
              value.id
                ? item.id === value.id
                : item.field === value.field &&
                  referenceKey(item.value) === referenceKey(value.value) &&
                  (value.field !== 'category' ||
                    referenceKey(item.parentType) === referenceKey(value.parentType || '')),
            ) || null;
          return { selected: value, item, resolved: item !== null };
        }),
      };
    },
    async impact() {
      throw new Error('Сторінка впливу не використовується в цій синтетичній історії.');
    },
  };
}
