import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from 'react-aria-components';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Studio, initialStudioMemory } from './features/labels/Studio';
import type { StudioMemory } from './features/labels/Studio';
import { createLabelApi } from './features/labels/api';
import { PricingContext } from './features/promotions/PricingContext';
import './shared/ui/controls.css';

declare global {
  interface Window {
    ReactLabels?: {
      mount: (element: HTMLElement) => void;
      leave: () => void;
      dirty: () => boolean;
    };
  }
}
const client = new QueryClient(),
  api = createLabelApi();
let root: Root | undefined,
  container: HTMLElement | undefined,
  dirty = false,
  memory = initialStudioMemory();
const onDirty = (value: boolean) => {
  dirty = value;
};
const onMemory = (value: StudioMemory) => {
  memory = value;
};
const onChanged = () => {
  void window.TSUKENYA_REFRESH?.().catch(() => {});
};
window.ReactLabels = {
  mount(element) {
    if (container === element && root) return;
    root?.unmount();
    container = element;
    dirty = false;
    root = createRoot(element);
    root.render(
      <I18nProvider locale="uk-UA">
        <QueryClientProvider client={client}>
          <PricingContext>
            {(catalog, store, context) => (
              <Studio
                priceStore={store}
                priceContext={context}
                api={api}
                catalog={catalog}
                onDirty={onDirty}
                onChanged={onChanged}
                initialMemory={memory}
                onMemory={onMemory}
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
};
window.dispatchEvent(new Event('tsukenya:labels-ready'));
