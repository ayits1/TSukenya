import type { TradingApi } from '../../features/trading/api';

type ReaderGuard = {
  accessToken: () => number;
  isCurrent: (token: number) => boolean;
  deny: (message: string) => void;
};

export const guardTradingDirectories = (model: ReaderGuard, api: TradingApi): TradingApi =>
  new Proxy(api, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        const token = model.accessToken(),
          signal = args.find((arg): arg is AbortSignal => arg instanceof AbortSignal);
        try {
          return await Reflect.apply(value, target, args);
        } catch (error) {
          if (
            error &&
            typeof error === 'object' &&
            'status' in error &&
            (error.status === 401 || error.status === 403) &&
            model.isCurrent(token) &&
            !signal?.aborted
          )
            model.deny(error instanceof Error ? error.message : 'Доступ відкликано.');
          throw error;
        }
      };
    },
  });
