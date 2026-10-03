import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from 'react-aria-components';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Catalog } from './features/catalog/Catalog';
import { emptyFilters, type Filters } from './features/catalog/api';
import './shared/ui/controls.css';
import { PricingContext } from './features/promotions/PricingContext';

declare global {
  interface Window {
    ReactCatalog?: {
      mount: (element: HTMLElement) => void;
      leave: () => void;
      dirty: () => boolean;
      filters: () => Filters;
    };
    TSUKENYA_REFRESH?: () => Promise<void>;
  }
}
const client = new QueryClient();
let root: Root | undefined;
let container: HTMLElement | undefined;
let dirty = false;
let filters = emptyFilters;
const onFiltersChanged = (value: Filters) => {
  filters = value;
};
const onDirty = (value: boolean) => {
  dirty = value;
};
const onChanged = () => {
  void window.TSUKENYA_REFRESH?.().catch(() => {});
};
window.ReactCatalog = {
  mount(element) {
    if (container === element && root) return;
    root?.unmount();
    dirty = false;
    container = element;
    root = createRoot(element);
    root.render(
      <I18nProvider locale="uk-UA">
        <QueryClientProvider client={client}>
          <PricingContext>
            {(api, store, context, promotions) => (
              <Catalog
                api={api}
                priceStore={store}
                priceContext={context}
                promotions={promotions}
                onChanged={onChanged}
                onDirty={onDirty}
                initialFilters={filters}
                onFiltersChanged={onFiltersChanged}
              />
            )}
          </PricingContext>
        </QueryClientProvider>
      </I18nProvider>,
    );
  },
  leave() {
    root?.unmount();
    root = undefined;
    container = undefined;
    dirty = false;
  },
  dirty: () => dirty,
  filters: () => filters,
};
window.dispatchEvent(new Event('tsukenya:catalog-ready'));
