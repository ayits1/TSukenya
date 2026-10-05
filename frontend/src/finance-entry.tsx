import { guardTradingDirectories } from './shared/api/tradingDirectoryGuard';
import { registerTradingReader, type TradingResource } from './shared/api/tradingFreshness';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { I18nProvider } from 'react-aria-components';
import { Finance } from './features/finance/Finance';
import { FinanceModel, type Options } from './features/finance/state';
import { createFinanceApi } from './features/finance/api';
import type { TradingApi } from './features/trading/api';
import './shared/ui/controls.css';
declare global {
  interface Window {
    ReactFinance?: {
      mount: (host: HTMLElement, options: Options) => Promise<void>;
      leave: () => void;
    };
  }
}
let root: Root | undefined, element: HTMLElement | undefined;
let unregisterFreshness: (() => void) | undefined;
let mountGeneration = 0;
const model = new FinanceModel(createFinanceApi());
const guarded = (api: TradingApi): TradingApi => guardTradingDirectories(model, api);
// Clear rendered private fields synchronously, including before a401 redirect.
function denyWorkspace(message: string) {
  model.deny(message);
  root?.unmount();
  root = undefined;
  element = undefined;
}
window.ReactFinance = {
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
            <Finance model={model} />
          </I18nProvider>,
        ),
      );
    }
    await model.activate(next);
    if (ticket !== mountGeneration || element !== host || !host.isConnected) return;
    if (model.state.error) throw Error(model.state.error);
    const keys = {
      accounts: 'finance_accounts',
      ledger: 'finance_ledger',
      documents: 'finance_documents',
      debts: 'finance_debts',
      advances: 'finance_advances',
    } as const;
    unregisterFreshness = registerTradingReader({
      name: 'finance',
      host,
      identity: { role: options.bootstrap.role, scopeStore: options.bootstrap.storeId },
      context: () => ({
        store: model.state.store,
        resources: [keys[model.state.view], 'directories', 'policy'] satisfies TradingResource[],
      }),
      readStamp: () => model.accessToken(),
      blocked: () => model.hasFilterDraft() || model.state.busy || model.state.actionBusy,
      refresh: async () => {
        await model.refreshCommitted();
        return !model.state.error && !!model.state.data;
      },
      revalidate: async (signal) => {
        // Coordinator owns auth denial after its issued request/generation fence.
        const fresh = await options.directoryApi.bootstrap(signal);
        if (signal.aborted) return;
        if (fresh.role !== options.bootstrap.role || fresh.storeId !== options.bootstrap.storeId)
          throw Object.assign(Error('Доступ змінився.'), { status: 403 });
        next.bootstrap = fresh;
        model.allowPolicyRefresh();
      },
      deny: () => denyWorkspace('Доступ змінився. Перечитайте контекст обліку.'),
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
  denyWorkspace('Сеанс завершився. Увійдіть знову.');
});
window.dispatchEvent(new Event('tsukenya:finance-ready'));
