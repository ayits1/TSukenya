import { createRoot } from 'react-dom/client';
import { I18nProvider } from 'react-aria-components';
import { ReceiptPricing } from './features/receipt-pricing/ReceiptPricing';
import { createReceiptPricingApi } from './features/receipt-pricing/api';
import './shared/ui/controls.css';
declare global {
  interface Window {
    ReactReceiptPricing?: {
      mount: (
        host: HTMLElement,
        options: {
          id: number;
          onClose: () => void;
          onOpenLabels: (key: string) => void;
          onState: (dirty: boolean, busy: boolean) => void;
        },
      ) => () => void;
    };
  }
}
window.ReactReceiptPricing = {
  mount(host, options) {
    const root = createRoot(host),
      api = createReceiptPricingApi();
    root.render(
      <I18nProvider locale="uk-UA">
        <ReceiptPricing
          {...options}
          api={api}
          {...(host.closest('dialog') ? { portalContainer: host.closest('dialog')! } : {})}
        />
      </I18nProvider>,
    );
    return () => root.unmount();
  },
};
window.dispatchEvent(new Event('tsukenya:receipt-pricing-ready'));
