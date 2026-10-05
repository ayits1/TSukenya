import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from 'react-aria-components';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Customers, type CustomerOptions } from './features/customers/Customers';
import { createCustomerApi, emptyCustomerFilters } from './features/customers/api';
import './shared/ui/controls.css';

declare global {
  interface Window {
    ReactCustomers?: {
      mount: (element: HTMLElement, options: CustomerOptions) => void;
      leave: () => void;
    };
  }
}
const client = new QueryClient();
const api = createCustomerApi();
let root: Root | undefined;
let filters = emptyCustomerFilters;
let selected: number | null = null;
let epoch = 0;
function denyWorkspace() {
  epoch++;
  root?.unmount();
  root = undefined;
  client.clear();
  filters = emptyCustomerFilters;
  selected = null;
}
window.addEventListener('tsukenya:session-invalidated', denyWorkspace);
window.ReactCustomers = {
  mount(element, options) {
    const token = ++epoch;
    const scoped: typeof api = {
      list: (...args) => guarded(() => api.list(...args), args[1]),
      profile: (...args) => guarded(() => api.profile(...args), args[2]),
    };
    const live = (signal?: AbortSignal) => token === epoch && !signal?.aborted;
    async function grant(signal?: AbortSignal) {
      if (!live(signal)) throw new DOMException('Скасовано', 'AbortError');
      if (!options.bootstrap || !options.directoryApi)
        throw Error('Контекст клієнтської бази недоступний.');
      const fresh = await options.directoryApi.bootstrap(signal);
      if (!live(signal)) throw new DOMException('Скасовано', 'AbortError');
      const expected = options.bootstrap;
      if (
        [fresh.username, fresh.role, fresh.storeId, fresh.csrf].join('|') !==
        [expected.username, expected.role, expected.storeId, expected.csrf].join('|')
      )
        throw Object.assign(Error('Права або сеанс змінилися.'), { status: 403 });
    }
    async function guarded<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      try {
        await grant(signal);
        const result = await read();
        await grant(signal);
        if (!live(signal)) throw new DOMException('Скасовано', 'AbortError');
        return result;
      } catch (error) {
        if (
          live(signal) &&
          error &&
          typeof error === 'object' &&
          'status' in error &&
          (error.status === 401 || error.status === 403)
        ) {
          denyWorkspace();
          window.Trade?.freshnessDeny?.();
          if (error.status === 401) {
            window.dispatchEvent(new Event('tsukenya:session-invalidated'));
            location.assign('/');
          } else void window.NativeDraftRecovery?.controller.check(false).catch(() => {});
        }
        throw error;
      }
    }
    root?.unmount();
    // Native editor refreshes the ERP state after confirmed writes; never reuse stale contact facts.
    client.removeQueries({ queryKey: ['customers'] });
    root = createRoot(element);
    root.render(
      <I18nProvider locale="uk-UA">
        <QueryClientProvider client={client}>
          <Customers
            {...options}
            api={scoped}
            onDenied={denyWorkspace}
            initialFilters={filters}
            initialCustomer={selected}
            onSelected={(value) => {
              selected = value;
            }}
            onFilters={(value) => {
              filters = value;
            }}
          />
        </QueryClientProvider>
      </I18nProvider>,
    );
  },
  leave() {
    epoch++;
    client.clear();
    root?.unmount();
    root = undefined;
  },
};
window.dispatchEvent(new Event('tsukenya:customers-ready'));
