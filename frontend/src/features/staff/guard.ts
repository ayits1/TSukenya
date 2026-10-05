import type { TradingApi } from '../trading/api';
import type { StaffModel } from './state';

export const guardStaffDirectories = (model: StaffModel, api: TradingApi): TradingApi =>
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
