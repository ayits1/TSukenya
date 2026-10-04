import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from 'react-aria-components';
import { ABCReport, initialABC } from './features/abc/ABCReport';
import { createABCApi, type ABCFilters } from './features/abc/api';
import { createTradingApi } from './features/trading/api';
import './shared/ui/controls.css';
declare global {
  interface Window {
    ReactABCReport?: {
      mount: (
        element: HTMLElement,
        options: {
          store: string;
          from: string;
          to: string;
          onFilters?: (filters: ABCFilters) => void;
        },
      ) => void;
      leave: () => void;
    };
  }
}
const api = createABCApi(),
  directories = createTradingApi();
let root: Root | undefined, filters: ABCFilters | undefined;
window.ReactABCReport = {
  mount(element, options) {
    root?.unmount();
    root = createRoot(element);
    root.render(
      <I18nProvider locale="uk-UA">
        <ABCReport
          api={api}
          directories={directories}
          initial={{
            ...(filters || initialABC()),
            store: options.store,
            from: options.from,
            to: options.to,
          }}
          onFilters={(value) => {
            filters = value;
            options.onFilters?.(value);
          }}
        />
      </I18nProvider>,
    );
  },
  leave() {
    root?.unmount();
    root = undefined;
  },
};
window.dispatchEvent(new Event('tsukenya:abc-ready'));
