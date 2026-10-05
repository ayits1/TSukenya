/** Mounted read-only child: facts are never remounted to refresh them. */
export type CommittedReader = {
  store: () => number | null;
  stamp: () => number;
  blocked: () => boolean;
  refresh: (signal: AbortSignal) => Promise<boolean>;
};
