import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { I18nProvider } from 'react-aria-components';
import { Sales } from './features/sales/Sales';
import { SalesModel, type Options } from './features/sales/state';
import { createSalesApi } from './features/sales/api';
import type { TradingApi } from './features/trading/api';
import './shared/ui/controls.css';
declare global {
  interface Window {
    ReactSales?: {
      mount: (host: HTMLElement, options: Options) => Promise<void>;
      leave: () => void;
    };
  }
}
let root: Root | undefined, element: HTMLElement | undefined;
const model = new SalesModel(createSalesApi());
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
window.ReactSales = {
  async mount(host, options) {
    const next = { ...options, directoryApi: guarded(options.directoryApi) };
    model.options = next;
    if (element !== host) {
      root?.unmount();
      root = createRoot(host);
      element = host;
      flushSync(() =>
        root!.render(
          <I18nProvider locale="uk-UA">
            <Sales model={model} />
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
};
window.addEventListener('tsukenya:session-invalidated', () => {
  model.deny('Сеанс завершився. Увійдіть знову.');
});
window.dispatchEvent(new Event('tsukenya:sales-ready'));
