import { ApiError } from '../../../shared/api/client';
export function isCurrentAuthFailure(error: unknown, current: () => boolean) {
  return current() && error instanceof ApiError && [401, 403].includes(error.status);
}
export function throwCurrentAuthFailure(
  error: unknown,
  current: () => boolean,
  signal: AbortSignal,
): never {
  if (signal.aborted || !isCurrentAuthFailure(error, current))
    throw new DOMException('Скасовано', 'AbortError');
  throw error;
}
