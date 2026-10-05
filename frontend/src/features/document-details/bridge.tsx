import { createRoot } from 'react-dom/client';
import { I18nProvider } from 'react-aria-components';
import { DocumentDetails } from './DocumentDetails';
import { DocumentModel, type Options } from './state';
export { createDocumentApi } from './api';
export function mount(host: HTMLElement, options: Options) {
  const root = createRoot(host),
    model = new DocumentModel(options);
  let active = true;
  root.render(
    <I18nProvider locale="uk-UA">
      <DocumentDetails
        model={model}
        initial={options.initial}
        {...(host.closest('dialog') ? { portalContainer: host.closest('dialog')! } : {})}
      />
    </I18nProvider>,
  );
  return {
    ready: model.read(),
    confirmedRead: model.confirmedRead.bind(model),
    cancel() {
      if (active) {
        active = false;
        model.cancel();
        root.unmount();
      }
    },
  };
}
