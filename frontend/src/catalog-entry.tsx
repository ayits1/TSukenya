import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from 'react-aria-components';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Catalog } from './features/catalog/Catalog';
import { emptyFilters, type Filters } from './features/catalog/api';
import './shared/ui/controls.css';
import { PricingContext } from './features/promotions/PricingContext';
import type { PromotionContext } from './features/promotions/api';

declare global {
  interface Window {
    ReactCatalog?: {
      mount: (element: HTMLElement) => void;
      leave: () => void;
      dirty: () => boolean;
      filters: () => Filters;
      priceContext: () => { context: PromotionContext | null; blocked: boolean };
      pricingFilter: () => Pick<Filters, 'q' | 'type' | 'category' | 'pack' | 'promotion'> & {
        store: string;
      };
    };
    TSUKENYA_REFRESH?: () => Promise<void>;
  }
}
const client = new QueryClient();
let root: Root | undefined;
let container: HTMLElement | undefined;
let dirty = false;
let filters = emptyFilters;
let pricingStore: number | null = null;
let confirmedContext: { context: PromotionContext | null; blocked: boolean } = {
  context: null,
  blocked: true,
};
const onContextState = (value: typeof confirmedContext) => {
  confirmedContext = value;
};
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
    confirmedContext = { context: null, blocked: true };
    container = element;
    root = createRoot(element);
    root.render(
      <I18nProvider locale="uk-UA">
        <QueryClientProvider client={client}>
          <PricingContext onState={onContextState}>
            {(api, store, context, promotions) => {
              pricingStore = store;
              return (
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
              );
            }}
          </PricingContext>
        </QueryClientProvider>
      </I18nProvider>,
    );
  },
  leave() {
    root?.unmount();
    root = undefined;
    container = undefined;
    confirmedContext = { context: null, blocked: true };
    dirty = false;
  },
  dirty: () => dirty,
  filters: () => filters,
  priceContext: () => confirmedContext,
  pricingFilter: () => ({
    q: filters.q,
    type: filters.type,
    category: filters.category,
    pack: filters.pack,
    promotion: filters.promotion,
    store: pricingStore == null ? '' : String(pricingStore),
  }),
};
window.dispatchEvent(new Event('tsukenya:catalog-ready'));
