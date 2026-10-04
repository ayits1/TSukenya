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
window.ReactCustomers = {
  mount(element, options) {
    root?.unmount();
    // Native editor refreshes the ERP state after confirmed writes; never reuse stale contact facts.
    client.removeQueries({ queryKey: ['customers'] });
    root = createRoot(element);
    root.render(
      <I18nProvider locale="uk-UA">
        <QueryClientProvider client={client}>
          <Customers
            {...options}
            api={api}
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
    root?.unmount();
    root = undefined;
  },
};
window.dispatchEvent(new Event('tsukenya:customers-ready'));
