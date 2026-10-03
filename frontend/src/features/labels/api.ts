import { createApiClient } from '../../shared/api/client';
import type { components } from '../../shared/api/generated';
import { decodeProduct } from '../catalog/api';
import type { Product } from '../catalog/api';
import { decodeLabelConfig, labelConfigWarnings } from './domain';
import type { LabelConfig, LabelSettings } from './domain';

export type Selection = components['schemas']['LabelSelection'];
export type Workspace = {
  config: LabelConfig;
  settings: LabelSettings;
  revision: string;
  canEdit: boolean;
  csrf: string;
  warnings: string[];
};
export type Proof = Workspace & {
  products: Product[];
  selection: Selection;
  date: string;
  snapshot: string;
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected object');
  return value as Record<string, unknown>;
}
export function decodeWorkspace(value: unknown): Workspace {
  const raw = object(value),
    config = object(raw.config),
    info = object(raw.settings);
  if (
    typeof raw.revision !== 'string' ||
    !raw.revision ||
    typeof raw.canEdit !== 'boolean' ||
    typeof raw.csrf !== 'string' ||
    !raw.csrf
  )
    throw new Error('Invalid workspace');
  if (
    typeof info.chainName !== 'string' ||
    !Array.isArray(info.storeNames) ||
    !info.storeNames.every((name) => typeof name === 'string') ||
    !Number.isInteger(info.staleDays) ||
    Number(info.staleDays) < 1
  )
    throw new Error('Invalid label identity');
  const settings: LabelSettings = {
    chainName: info.chainName,
    storeNames: info.storeNames,
    staleDays: Number(info.staleDays),
  };
  return {
    config: decodeLabelConfig(config),
    settings,
    revision: raw.revision,
    canEdit: raw.canEdit,
    csrf: raw.csrf,
    warnings: labelConfigWarnings(config),
  };
}
export function decodeProof(value: unknown): Proof {
  const raw = object(value),
    workspace = decodeWorkspace(value);
  if (
    !Array.isArray(raw.products) ||
    !Array.isArray(raw.selection) ||
    typeof raw.date !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(raw.date) ||
    !Number.isFinite(Date.parse(raw.date)) ||
    typeof raw.snapshot !== 'string' ||
    !raw.snapshot
  )
    throw new Error('Invalid print snapshot');
  const products = raw.products.map(decodeProduct),
    selection: Selection = raw.selection.map((value) => {
      const row = object(value);
      if (
        typeof row.id !== 'string' ||
        !row.id ||
        !Number.isInteger(row.quantity) ||
        Number(row.quantity) < 1 ||
        Number(row.quantity) > 500
      )
        throw new Error('Invalid print quantity');
      return { id: row.id, quantity: Number(row.quantity) };
    });
  if (
    !selection.length ||
    new Set(selection.map((row) => row.id)).size !== selection.length ||
    selection.reduce((sum, row) => sum + row.quantity, 0) > 1000 ||
    products.length !== selection.length ||
    products.some((product, index) => product.id !== selection[index]?.id)
  )
    throw new Error('Invalid print products');
  return { ...workspace, products, selection, date: raw.date, snapshot: raw.snapshot };
}
export function createLabelApi() {
  let csrf: string | undefined;
  const client = createApiClient({ getCsrf: () => csrf });
  return {
    async workspace(signal?: AbortSignal) {
      const result = await client.get('/api/v1/labels/workspace', decodeWorkspace, signal);
      csrf = result.csrf;
      return result;
    },
    async save(revision: string, config: LabelConfig, settings: LabelSettings) {
      const payload: components['schemas']['LabelWorkspacePatch'] = { revision, config, settings };
      const result = await client.mutate(
        'PATCH',
        '/api/v1/labels/workspace',
        payload,
        decodeWorkspace,
      );
      csrf = result.csrf;
      return result;
    },
    prepare(selection: Selection, signal?: AbortSignal) {
      return client.mutate('POST', '/api/v1/labels/prepare', { selection }, decodeProof, signal);
    },
  };
}
export type LabelApi = ReturnType<typeof createLabelApi>;
