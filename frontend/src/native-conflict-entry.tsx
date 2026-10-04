import * as voucherEditor from './shared/native/voucher';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from 'react-aria-components';
import { NativeConflict, type NativeConflictProps } from './shared/native/NativeConflict';
import { nativeFields } from './shared/native/fields';
import {
  captureWorkShiftDraft,
  decodeWorkShift,
  employeeWorkTerms,
  workShiftFields,
  workShiftIdentityMatches,
  workShiftProjection,
} from './shared/native/workShift';
import './shared/ui/controls.css';
import * as budgetTemplateEditor from './shared/native/budgetTemplate';
import * as entityEditor from './shared/native/entity';
import * as legacyEditor from './shared/native/legacy';
import * as recipeEditor from './shared/native/recipe';

declare global {
  interface Window {
    NativeVoucherEditor?: typeof voucherEditor;
    NativeBudgetTemplateEditor?: typeof budgetTemplateEditor;
    NativeEntityEditor?: typeof entityEditor;
    NativeLegacyEditor?: typeof legacyEditor;
    NativeRecipeEditor?: typeof recipeEditor;
    NativeWorkShiftEditor?: {
      captureWorkShiftDraft: typeof captureWorkShiftDraft;
      decodeWorkShift: typeof decodeWorkShift;
      employeeWorkTerms: typeof employeeWorkTerms;
      workShiftFields: typeof workShiftFields;
      workShiftIdentityMatches: typeof workShiftIdentityMatches;
      workShiftProjection: typeof workShiftProjection;
    };
    NativeConflictComparison?: {
      mount: (host: HTMLElement, props: NativeConflictProps) => { unmount: () => void };
    };
  }
}
window.NativeBudgetTemplateEditor = budgetTemplateEditor;
window.NativeEntityEditor = entityEditor;
window.NativeLegacyEditor = legacyEditor;
window.NativeRecipeEditor = recipeEditor;
window.NativeVoucherEditor = voucherEditor;
window.NativeWorkShiftEditor = {
  captureWorkShiftDraft,
  decodeWorkShift,
  employeeWorkTerms,
  workShiftFields,
  workShiftIdentityMatches,
  workShiftProjection,
};
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
