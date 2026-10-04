import { createRoot } from 'react-dom/client';
import { I18nProvider } from 'react-aria-components';
import { MonthPicker, monthCaption } from '../ui/MonthPicker';
import { Select } from '../ui/Select';

/** Keep the legacy form's names, values and explicit Open action authoritative. */
export function mountBudgetPeriod(form: HTMLFormElement) {
  const month = form.elements.namedItem('month') as HTMLInputElement;
  const past = form.elements.namedItem('past') as HTMLSelectElement;
  const mountField = (input: HTMLInputElement | HTMLSelectElement) => {
    const label = input.parentElement!;
    const field = document.createElement('div');
    field.className = 'trade-directory-field';
    input.hidden = true;
    field.append(input);
    const host = document.createElement('div');
    host.className = 'tk-root';
    field.append(host);
    label.replaceWith(field);
    return createRoot(host);
  };
  const monthRoot = mountField(month),
    pastRoot = mountField(past);
  let active = true;
  const render = () => {
    if (!active) return;
    monthRoot.render(
      <I18nProvider locale="uk-UA">
        <MonthPicker
          label="Місяць"
          value={month.value}
          isDisabled={month.disabled}
          onChange={(value) => {
            if (!active || month.disabled) return;
            month.value = value;
            past.value = '';
            month.dispatchEvent(new Event('change', { bubbles: true }));
            render();
          }}
        />
      </I18nProvider>,
    );
    const options = Array.from(past.options)
      .filter((option) => option.value)
      .map((option) => ({ id: option.value, label: monthCaption(option.value) }));
    pastRoot.render(
      <I18nProvider locale="uk-UA">
        <Select
          label="Збережені місяці"
          options={options}
          placeholder={options.length ? 'Вибрати місяць' : 'Ще немає бюджетів'}
          isDisabled={past.disabled || !options.length}
          selectedKey={past.value || null}
          onSelectionChange={(key) => {
            if (!active || past.disabled || key === null) return;
            past.value = String(key);
            past.dispatchEvent(new Event('change', { bubbles: true }));
            render();
          }}
        />
      </I18nProvider>,
    );
  };
  const unmount = () => {
    if (!active) return;
    active = false;
    observer.disconnect();
    monthRoot.unmount();
    pastRoot.unmount();
  };
  // Navigation guards may cancel leaving. Dispose only once the form actually leaves the DOM.
  const observer = new MutationObserver(() => {
    if (!form.isConnected) unmount();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  render();
  return { sync: render, unmount };
}
