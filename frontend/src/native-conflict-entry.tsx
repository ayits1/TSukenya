import * as entityPersistence from './shared/native/entityPersistence';
import * as voucherPersistence from './shared/native/voucherPersistence';
import { createDraftRecovery } from './shared/recovery/bridge';
import * as monthlyBudgetEditor from './shared/native/monthlyBudget';
import { mountBudgetPeriod } from './shared/native/budgetPeriod';
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
import * as planningCategoryEditor from './shared/native/planningCategory';
import * as recipeEditor from './shared/native/recipe';

declare global {
  interface Window {
    NativeVoucherPersistence?: typeof voucherPersistence;
    NativeEntityPersistence?: typeof entityPersistence;
    NativeDraftRecovery?: ReturnType<typeof createDraftRecovery>;
    NativePlanningCategoryEditor?: typeof planningCategoryEditor;
    NativeMonthlyBudgetEditor?: typeof monthlyBudgetEditor;
    NativeBudgetPeriodControls?: { mount: typeof mountBudgetPeriod };
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
window.NativeVoucherPersistence = voucherPersistence;
window.NativeBudgetTemplateEditor = budgetTemplateEditor;
window.NativePlanningCategoryEditor = planningCategoryEditor;
window.NativeMonthlyBudgetEditor = monthlyBudgetEditor;
window.NativeBudgetPeriodControls = { mount: mountBudgetPeriod };
window.NativeEntityEditor = entityEditor;
window.NativeEntityPersistence = entityPersistence;
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

if (document.querySelector('#accountLink')) {
  try {
    window.NativeDraftRecovery = createDraftRecovery(window);
  } catch {
    /* Unavailable storage must be reported by enrollment before any send. */
  }
}
window.dispatchEvent(new Event('tsukenya:native-conflict-ready'));
