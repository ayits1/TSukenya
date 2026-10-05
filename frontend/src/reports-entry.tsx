import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { I18nProvider } from 'react-aria-components';
import { Reports } from './features/reports/Reports';
import { ReportsModel, type Options } from './features/reports/state';
import { createReportsApi } from './features/reports/api';
import { createFinanceApi } from './features/finance/api';
import { createABCApi } from './features/abc/api';
import './shared/ui/controls.css';
declare global {
  interface Window {
    ReactReports?: {
      mount: (host: HTMLElement, options: Options) => Promise<void>;
      leave: () => void;
    };
  }
}
let root: Root | undefined, element: HTMLElement | undefined;
const model = new ReportsModel(createReportsApi(), createFinanceApi(), createABCApi());
window.ReactReports = {
  async mount(host, options) {
    if (element !== host) {
      model.leave();
      root?.unmount();
      root = createRoot(host);
      element = host;
    }
    const pending = model.activate(options);
    flushSync(() =>
      root!.render(
        <I18nProvider locale="uk-UA">
          <Reports model={model} />
        </I18nProvider>,
      ),
    );
    await pending;
  },
  leave() {
    model.leave();
    root?.unmount();
    root = undefined;
    element = undefined;
  },
};
window.addEventListener('tsukenya:session-invalidated', () => {
  if (!model.state.denied) model.deny('Сеанс завершився. Увійдіть знову.');
  // The event runs before the native caller redirects: clear private DOM synchronously.
  root?.unmount();
  root = undefined;
  element = undefined;
});
window.dispatchEvent(new Event('tsukenya:reports-ready'));
