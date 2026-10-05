import { registerTradingReader, type TradingResource } from './shared/api/tradingFreshness';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { I18nProvider } from 'react-aria-components';
import { Staff } from './features/staff/Staff';
import { StaffModel, type Options } from './features/staff/state';
import { createStaffApi } from './features/staff/api';
import { guardStaffDirectories } from './features/staff/guard';
import './shared/ui/controls.css';
declare global {
  interface Window {
    ReactStaff?: {
      mount: (host: HTMLElement, options: Options) => Promise<void>;
      leave: () => void;
    };
  }
}
let root: Root | undefined, element: HTMLElement | undefined;
let unregisterFreshness: (() => void) | undefined;
let mountGeneration = 0;
const model = new StaffModel(createStaffApi());
// Clear rendered private fields synchronously, including before a401 redirect.
function denyWorkspace(message: string) {
  model.deny(message);
  root?.unmount();
  root = undefined;
  element = undefined;
}
window.ReactStaff = {
  async mount(host, options) {
    const ticket = ++mountGeneration;
    unregisterFreshness?.();
    unregisterFreshness = undefined;
    const next = { ...options, directoryApi: guardStaffDirectories(model, options.directoryApi) };
    if (element !== host) {
      root?.unmount();
      root = createRoot(host);
      element = host;
      flushSync(() =>
        root!.render(
          <I18nProvider locale="uk-UA">
            <Staff model={model} />
          </I18nProvider>,
        ),
      );
    }
    await model.activate(next);
    if (ticket !== mountGeneration || element !== host || !host.isConnected) return;
    if (model.state.error) throw Error(model.state.error);
    const keys = {
      employees: 'staff_employees',
      'work-shifts': 'staff_shifts',
      documents: 'staff_documents',
    } as const;
    unregisterFreshness = registerTradingReader({
      name: 'staff',
      host,
      identity: { role: options.bootstrap.role, scopeStore: options.bootstrap.storeId },
      context: () => ({
        store: model.state.store,
        resources: [keys[model.state.view], 'directories', 'policy'] satisfies TradingResource[],
      }),
      readStamp: () => model.accessToken(),
      blocked: () => model.hasFilterDraft() || model.state.busy || model.state.actionBusy,
      refresh: async () => {
        // Reset only after the coordinator has accepted the committed read.
        model.allowPolicyRefresh();
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
window.dispatchEvent(new Event('tsukenya:staff-ready'));
