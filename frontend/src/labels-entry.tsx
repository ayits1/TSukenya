import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from 'react-aria-components';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Studio, initialStudioMemory } from './features/labels/Studio';
import type { StudioMemory } from './features/labels/Studio';
import { createLabelApi } from './features/labels/api';
import { PricingContext } from './features/promotions/PricingContext';
import './shared/ui/controls.css';
import { createOperationPriceApi } from './shared/api/operationPrices';
import type { OperationKind } from './shared/api/operationPrices';
import type { PriceOperation } from './features/labels/operationSelection';

declare global {
  interface Window {
    CatalogPriceWorkflow?: {
      context: () => { storeId: number | null };
      read: (
        kind: OperationKind,
        id: string,
        signal?: AbortSignal,
      ) => ReturnType<typeof results.result>;
      open: (kind: OperationKind, id: string) => void;
    };
    TSUKENYA_OPEN_PRICE_LABELS?: (kind: OperationKind, id: string) => void;
    ReactLabels?: {
      mount: (element: HTMLElement) => void;
      leave: () => void;
      dirty: () => boolean;
      openOperation: (kind: OperationKind, id: string) => void;
    };
  }
}
const results = createOperationPriceApi();
let operation: PriceOperation | null = null;
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
function draw() {
  root?.render(
    <I18nProvider locale="uk-UA">
      <QueryClientProvider client={client}>
        <PricingContext layout="toolbar">
          {(catalog, store, context, promotions, controls) => (
            <Studio
              priceStore={store}
              priceContext={context}
              operation={operation}
              operationContext={context}
              operationContextGuard={controls.guard}
              promotions={promotions}
              onOperationApply={controls.adopt}
              onOperationCancel={() => {
                operation = null;
                draw();
                requestAnimationFrame(() =>
                  document
                    .querySelector<HTMLElement>('#react-labels [role="tab"][aria-selected="true"]')
                    ?.focus(),
                );
              }}
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
}
window.ReactLabels = {
  mount(element) {
    if (container === element && root) return;
    root?.unmount();
    container = element;
    dirty = false;
    root = createRoot(element);
    draw();
  },
  leave() {
    root?.unmount();
    root = undefined;
    container = undefined;
    dirty = false;
  },
  dirty: () => dirty,
  openOperation(kind, id) {
    if (
      typeof kind !== 'string' ||
      !['pricing', 'import'].includes(kind) ||
      typeof id !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)
    )
      throw Error('Некоректний номер операції.');
    operation = { kind, id, token: crypto.randomUUID() };
    draw();
  },
};
window.CatalogPriceWorkflow = {
  context() {
    const state = window.ReactCatalog?.priceContext();
    if (!state?.context || state.blocked)
      throw Error(
        'Спершу підтвердьте магазин ціни в каталозі. Під час читання контексту операція не починається.',
      );
    return { storeId: state.context.storeId };
  },
  read: (kind, id, signal) => results.result(kind, id, {}, signal),
  open: (kind, id) => {
    if (!window.TSUKENYA_OPEN_PRICE_LABELS) throw Error('Студію цінників ще не завантажено.');
    window.TSUKENYA_OPEN_PRICE_LABELS(kind, id);
  },
};
window.dispatchEvent(new Event('tsukenya:labels-ready'));
