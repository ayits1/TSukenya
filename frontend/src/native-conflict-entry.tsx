import { createRoot } from 'react-dom/client';
import { I18nProvider } from 'react-aria-components';
import { NativeConflict, type NativeConflictProps } from './shared/native/NativeConflict';
import { nativeFields } from './shared/native/fields';
import './shared/ui/controls.css';

declare global {
  interface Window {
    NativeConflictComparison?: {
      mount: (host: HTMLElement, props: NativeConflictProps) => { unmount: () => void };
    };
  }
}
window.NativeConflictComparison = {
  mount(host, props) {
    nativeFields(props.fields);
    const root = createRoot(host);
    let active = true;
    const callback = (fn: () => void) =>
      queueMicrotask(() => {
        if (active) fn();
      });
    // Freeze the reviewed snapshots; a native form must start a new comparison after editing.
    root.render(
      <I18nProvider locale="uk-UA">
        <NativeConflict
          {...props}
          base={structuredClone(props.base)}
          mine={structuredClone(props.mine)}
          server={structuredClone(props.server)}
          onApply={(draft) => callback(() => props.onApply(draft))}
          onCancel={() => callback(props.onCancel)}
        />
      </I18nProvider>,
    );
    return {
      unmount() {
        if (active) {
          active = false;
          root.unmount();
        }
      },
    };
  },
};
window.dispatchEvent(new Event('tsukenya:native-conflict-ready'));
