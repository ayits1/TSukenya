import { registerTradingReader } from './shared/api/tradingFreshness';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { I18nProvider } from 'react-aria-components';
import { Purchases } from './features/purchases/Purchases';
import { PurchasesModel, type Options } from './features/purchases/state';
import { createPurchasesApi } from './features/purchases/api';
import type { TradingApi } from './features/trading/api';
import './shared/ui/controls.css';
declare global {
  interface Window {
    ReactPurchases?: {
      mount: (host: HTMLElement, options: Options) => Promise<void>;
      leave: () => void;
    };
  }
}
let root: Root | undefined, element: HTMLElement | undefined;
let unregisterFreshness: (() => void) | undefined;
let mountGeneration = 0;
const model = new PurchasesModel(createPurchasesApi());
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
window.ReactPurchases = {
  async mount(host, options) {
    const ticket = ++mountGeneration;
    unregisterFreshness?.();
    unregisterFreshness = undefined;
    const next = { ...options, directoryApi: guarded(options.directoryApi) };
    model.options = next;
    if (element !== host) {
      root?.unmount();
      root = createRoot(host);
      element = host;
      flushSync(() =>
        root!.render(
          <I18nProvider locale="uk-UA">
            <Purchases model={model} />
          </I18nProvider>,
        ),
      );
    }
    await model.activate(next);
    if (ticket !== mountGeneration || element !== host || !host.isConnected) return;
    if (model.state.error) throw Error(model.state.error);
    unregisterFreshness = registerTradingReader({
      name: 'purchases',
      host,
      identity: { role: options.bootstrap.role, scopeStore: options.bootstrap.storeId },
      context: () => ({
        store: model.state.store,
        resources: [
          model.state.view === 'documents' ? 'purchases_documents' : 'replenishment',
          'directories',
          'policy',
        ],
      }),
      readStamp: () => model.accessToken(),
      blocked: () =>
        model.hasFilterDraft() ||
        model.state.busy ||
        model.state.actionBusy ||
        model.state.linesBusy ||
        !!model.state.chosen,
      refresh: async () => {
        await model.refreshCommitted();
        return !model.state.error && !!(model.state.documents || model.state.groups);
      },
      revalidate: async (signal) => {
        const fresh = await next.directoryApi.bootstrap(signal);
        if (signal.aborted) return;
        if (fresh.role !== options.bootstrap.role || fresh.storeId !== options.bootstrap.storeId)
          throw Object.assign(Error('Доступ змінився.'), { status: 403 });
        next.bootstrap = fresh;
        model.allowPolicyRefresh();
      },
      deny: () => model.deny('Доступ змінився. Перечитайте контекст обліку.'),
    });
  },
  leave() {
    mountGeneration++;
    unregisterFreshness?.();
    unregisterFreshness = undefined;
    model.leave();
    root?.unmount();
    root = undefined;
    element = undefined;
  },
};
window.addEventListener('tsukenya:session-invalidated', () => {
  model.deny('Сеанс завершився. Увійдіть знову.');
});
window.dispatchEvent(new Event('tsukenya:purchases-ready'));
