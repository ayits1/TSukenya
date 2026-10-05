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
const model = new StaffModel(createStaffApi());
window.ReactStaff = {
  async mount(host, options) {
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
    if (model.state.error) throw Error(model.state.error);
  },
  leave() {
    model.leave();
    root?.unmount();
    root = undefined;
    element = undefined;
  },
};
window.addEventListener('tsukenya:session-invalidated', () => {
  model.deny('Сеанс завершився. Увійдіть знову.');
});
window.dispatchEvent(new Event('tsukenya:staff-ready'));
