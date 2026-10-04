import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from 'react-aria-components';
import { Select } from '../ui/Select';

// Preserve the native form's submission and status values; only replace its visual control.
const controls = new Map<HTMLSelectElement, { root: Root; render: () => void }>();
export function syncShiftStatus(container: ParentNode = document) {
  for (const [input, control] of controls) {
    if (!input.isConnected) {
      control.root.unmount();
      controls.delete(input);
    } else if (container === document || (container instanceof Node && container.contains(input))) {
      control.render();
    }
  }
  container
    .querySelectorAll<HTMLSelectElement>(
      '[data-shift-history] select[name=status]:not([data-status-mounted])',
    )
    .forEach((input) => {
      const label = input.parentElement;
      if (!label || label.tagName !== 'LABEL') return;
      const field = document.createElement('div');
      field.className = 'trade-directory-field';
      input.hidden = true;
      input.dataset.statusMounted = 'true';
      field.append(input);
      const host = document.createElement('div');
      host.className = 'tk-root trade-directory-host';
      field.append(host);
      label.replaceWith(field);
      const root = createRoot(host);
      const render = () =>
        root.render(
          <I18nProvider locale="uk-UA">
            <Select
              label="Стан"
              options={Array.from(input.options).map((option) => ({
                id: option.value || 'all',
                label: option.text,
              }))}
              selectedKey={input.value || 'all'}
              isDisabled={input.matches(':disabled')}
              onSelectionChange={(key) => {
                if (key === null || !input.isConnected || input.matches(':disabled')) return;
                input.value = key === 'all' ? '' : String(key);
                input.dispatchEvent(new Event('change', { bubbles: true }));
                render();
              }}
            />
          </I18nProvider>,
        );
      controls.set(input, { root, render });
      render();
    });
}
export function disposeShiftStatus(container: Node) {
  for (const [input, control] of controls)
    if (container.contains(input)) {
      control.root.unmount();
      controls.delete(input);
    }
}
