import { createApiClient } from '../../shared/api/client';
import type { components } from '../../shared/api/generated';
import { decodeReference } from './api';

export type ManagedReference = components['schemas']['ReferenceManagedItem'];
export type ReferenceManagement = components['schemas']['ReferenceManagement'];
export type ReferenceMutation = components['schemas']['ReferenceMutation'];
export type ReferenceImpact = components['schemas']['ReferenceImpact'];
export type ReferenceCommit = components['schemas']['ReferenceCommit'];
export type ReferenceCommitResult = components['schemas']['ReferenceCommitResult'];
const id = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value);
const token = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const operation = (value: unknown) =>
  ['rename', 'merge', 'archive', 'restore'].includes(String(value));
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid object');
  return value as Record<string, unknown>;
}
export function decodeManagedReference(value: unknown): ManagedReference {
  const item = object(value);
  decodeReference(item);
  if (
    !['active', 'archived', 'merged'].includes(String(item.state)) ||
    !token(item.revision) ||
    !(item.parentId === null || id(item.parentId)) ||
    !(item.mergedInto === null || id(item.mergedInto)) ||
    (item.state === 'merged' && !id(item.mergedInto))
  )
    throw new Error('Invalid managed reference');
  return item as ManagedReference;
}
export function decodeManagement(value: unknown): ReferenceManagement {
  const data = object(value);
  if (
    !Array.isArray(data.items) ||
    typeof data.canEdit !== 'boolean' ||
    typeof data.csrf !== 'string' ||
    !data.csrf
  )
    throw new Error('Invalid management');
  const items = data.items.map(decodeManagedReference);
  if (new Set(items.map((item) => item.id)).size !== items.length)
    throw new Error('Duplicate reference ids');
  return { items, canEdit: data.canEdit, csrf: data.csrf };
}
export function decodeImpact(value: unknown): ReferenceImpact {
  const data = object(value);
  if (!token(data.snapshot) || !operation(data.operation)) throw new Error('Invalid impact');
  decodeManagedReference(data.source);
  if (data.target !== null) decodeManagedReference(data.target);
  for (const name of ['productCount', 'usageCount', 'referenceCount', 'blockedCount'])
    if (!Number.isSafeInteger(data[name]) || Number(data[name]) < 0)
      throw new Error('Invalid count');
  for (const name of ['warnings', 'blocked'])
    if (
      !Array.isArray(data[name]) ||
      !data[name].every((text: unknown) => typeof text === 'string')
    )
      throw new Error('Invalid messages');
  if (
    !Array.isArray(data.coalescedCategories) ||
    !data.coalescedCategories.every((value: unknown) => {
      const item = object(value);
      return id(item.sourceId) && id(item.targetId) && typeof item.value === 'string';
    })
  )
    throw new Error('Invalid categories');
  if (
    !Array.isArray(data.examples) ||
    !data.examples.every((value: unknown) => {
      const item = object(value);
      return id(item.id) && typeof item.name === 'string';
    })
  )
    throw new Error('Invalid examples');
  return data as ReferenceImpact;
}
export function decodeCommitResult(value: unknown): ReferenceCommitResult {
  const data = object(value);
  decodeImpact(data);
  if (data.ok !== true) throw new Error('Invalid commit');
  return data as ReferenceCommitResult;
}
export function createReferenceManagementApi() {
  let csrf: string | undefined;
  const client = createApiClient({ getCsrf: () => csrf });
  return {
    async list(signal?: AbortSignal) {
      const result = await client.get(
        '/api/v1/catalog/references/manage',
        decodeManagement,
        signal,
      );
      csrf = result.csrf;
      return result;
    },
    preview(value: ReferenceMutation, signal?: AbortSignal) {
      return client.mutate(
        'POST',
        '/api/v1/catalog/references/preview',
        value,
        decodeImpact,
        signal,
      );
    },
    commit(value: ReferenceCommit) {
      return client.mutate('POST', '/api/v1/catalog/references/commit', value, decodeCommitResult);
    },
  };
}
export type ReferenceManagementApi = ReturnType<typeof createReferenceManagementApi>;
