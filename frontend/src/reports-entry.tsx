import { registerTradingReader, type TradingResource } from './shared/api/tradingFreshness';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { I18nProvider } from 'react-aria-components';
import { Reports } from './features/reports/Reports';
import { ReportsModel, type Options } from './features/reports/state';
import { createReportsApi } from './features/reports/api';
import { createFinanceApi } from './features/finance/api';
import { createABCApi } from './features/abc/api';
import './shared/ui/controls.css';
declare global {
  interface Window {
    ReactReports?: {
      mount: (host: HTMLElement, options: Options) => Promise<void>;
      leave: () => void;
    };
  }
}
let root: Root | undefined, element: HTMLElement | undefined;
let unregisterFreshness: (() => void) | undefined;
let mountGeneration = 0;
const model = new ReportsModel(createReportsApi(), createFinanceApi(), createABCApi());
window.ReactReports = {
  async mount(host, options) {
    const ticket = ++mountGeneration;
    unregisterFreshness?.();
    unregisterFreshness = undefined;
    if (element !== host) {
      model.leave();
      root?.unmount();
      root = createRoot(host);
      element = host;
    }
    const pending = model.activate(options);
    flushSync(() =>
      root!.render(
        <I18nProvider locale="uk-UA">
          <Reports model={model} />
        </I18nProvider>,
      ),
    );
    await pending;
    if (ticket !== mountGeneration || element !== host || !host.isConnected || model.state.denied)
      return;
    unregisterFreshness = registerTradingReader({
      name: 'reports',
      host,
      identity: { role: options.bootstrap.role, scopeStore: options.bootstrap.storeId },
      context: () => {
        const salary = ['owner', 'accountant'].includes(options.bootstrap.role);
        const resources: TradingResource[] =
          model.state.view === 'abc'
            ? ['reports_abc']
            : model.state.view === 'period'
              ? ['reports_period', 'reports_balances']
              : ['reports_balances'];
        if (salary && model.state.view !== 'abc') resources.push('reports_salary');
        return { store: model.freshnessStore(), resources };
      },
      readStamp: () => model.freshnessStamp(),
      blocked: () => model.freshnessBlocked(),
      refresh: (signal) => model.refreshCommitted(signal),
      revalidate: async (signal) => {
        const fresh = await options.directoryApi.bootstrap(signal);
        if (signal.aborted) return;
        if (fresh.role !== options.bootstrap.role || fresh.storeId !== options.bootstrap.storeId)
          throw Object.assign(Error('Доступ до звітів змінився.'), { status: 403 });
      },
      deny: () => {
        model.deny('Доступ до звітів змінився. Перечитайте контекст.');
        root?.unmount();
        root = undefined;
        element = undefined;
      },
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
  mountGeneration++;
  unregisterFreshness?.();
  unregisterFreshness = undefined;
  if (!model.state.denied) model.deny('Сеанс завершився. Увійдіть знову.');
  // The event runs before the native caller redirects: clear private DOM synchronously.
  root?.unmount();
  root = undefined;
  element = undefined;
});
window.dispatchEvent(new Event('tsukenya:reports-ready'));
