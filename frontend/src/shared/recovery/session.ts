export type DraftSession = {
  draftOwner: string;
  draftSession: string;
  role: 'owner' | 'manager' | 'accountant' | 'warehouse' | 'cashier';
  storeId: number | null;
  networkOwner: boolean;
};
const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
export function decodeDraftSession(value: unknown): DraftSession {
  if (!object(value)) throw Error('Не підтверджено сеанс чернетки.');
  const { draftOwner, draftSession, role, storeId, networkOwner, csrf } = value;
  if (
    typeof draftOwner !== 'string' ||
    !/^[a-f0-9]{64}$/.test(draftOwner) ||
    typeof draftSession !== 'string' ||
    !/^[a-f0-9]{64}$/.test(draftSession) ||
    typeof role !== 'string' ||
    !['owner', 'manager', 'accountant', 'warehouse', 'cashier'].includes(String(role)) ||
    !(
      storeId === null ||
      (typeof storeId === 'number' && Number.isSafeInteger(storeId) && storeId > 0)
    ) ||
    typeof networkOwner !== 'boolean' ||
    networkOwner !== (role === 'owner' && storeId === null) ||
    typeof csrf !== 'string' ||
    csrf.length === 0
  )
    throw Error('Не підтверджено сеанс чернетки.');
  // Credentials are deliberately not returned to the storage layer.
  return { draftOwner, draftSession, role: role as DraftSession['role'], storeId, networkOwner };
}
export async function readDraftSession(signal: AbortSignal): Promise<DraftSession> {
  const response = await fetch('/api/v1/session', {
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
  });
  if (!response.ok)
    throw Object.assign(Error('Не вдалося перевірити сеанс чернетки.'), {
      status: response.status,
    });
  return decodeDraftSession(await response.json());
}
export const sameSession = (a: DraftSession, b: DraftSession) =>
  a.draftOwner === b.draftOwner &&
  a.draftSession === b.draftSession &&
  a.role === b.role &&
  a.storeId === b.storeId &&
  a.networkOwner === b.networkOwner;

export function decodeBinding(value: unknown): DraftSession {
  if (
    !object(value) ||
    Object.keys(value).length !== 5 ||
    !['draftOwner', 'draftSession', 'role', 'storeId', 'networkOwner'].every((k) =>
      Object.hasOwn(value, k),
    )
  )
    throw Error('Некоректний власник чернетки.');
  return decodeDraftSession({ ...value, csrf: 'validation-only' });
}
