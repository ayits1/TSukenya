import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { I18nProvider } from 'react-aria-components';
import { Stock } from './features/stock/Stock';
import { StockModel, type StockOptions } from './features/stock/state';
import { createStockApi } from './features/stock/api';
import type { TradingApi } from './features/trading/api';
import './shared/ui/controls.css';
declare global {
  interface Window {
    ReactStock?: {
      mount: (host: HTMLElement, options: StockOptions) => Promise<void>;
      leave: () => void;
      canLeave: () => boolean;
      hasDrafts: () => boolean;
    };
  }
}
let root: Root | undefined,
  element: HTMLElement | undefined,
  csrf = '';
const model = new StockModel(createStockApi(() => csrf));
const guarded = (api: TradingApi): TradingApi =>
  new Proxy(api, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        const token = model.accessToken();
        try {
          return await Reflect.apply(value, target, args);
        } catch (error) {
          if (
            error &&
            typeof error === 'object' &&
            'status' in error &&
            (error.status === 401 || error.status === 403) &&
            model.isCurrent(token)
          )
            model.deny(error instanceof Error ? error.message : 'Доступ відкликано.');
          throw error;
        }
      };
    },
  });
window.ReactStock = {
  async mount(host, options) {
    csrf = options.bootstrap.csrf;
    const next = { ...options, directoryApi: guarded(options.directoryApi) };
    model.options = next;
    if (element !== host) {
      root?.unmount();
      root = createRoot(host);
      element = host;
      flushSync(() =>
        root!.render(
          <I18nProvider locale="uk-UA">
            <Stock model={model} />
          </I18nProvider>,
        ),
      );
    }
    await model.activate(next);
    if (model.state.error) throw Error(model.state.error);
  },
  leave() {
    model.leave();
    root?.unmount();
    root = undefined;
    element = undefined;
  },
  canLeave: () => model.canLeave(),
  hasDrafts: () => model.hasDrafts(),
};
window.addEventListener('beforeunload', (event) => {
  if (model.hasDrafts()) {
    event.preventDefault();
    event.returnValue = '';
  }
});
window.dispatchEvent(new Event('tsukenya:stock-ready'));
