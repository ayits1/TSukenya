import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from 'react-aria-components';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Catalog } from './features/catalog/Catalog';
import { createCatalogApi, emptyFilters, type Filters } from './features/catalog/api';
import './shared/ui/controls.css';

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
const api = createCatalogApi();
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
          <Catalog
            api={api}
            onChanged={onChanged}
            onDirty={onDirty}
            initialFilters={filters}
            onFiltersChanged={onFiltersChanged}
          />
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
