import { useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from 'react-aria-components';
import { DraftStore, type Codec } from './storage';
import { RecoveryController } from './controller';
import { RecoveryPanel } from './RecoveryPanel';
function View({ controller, close }: { controller: RecoveryController; close: () => void }) {
  const view = useSyncExternalStore(controller.subscribe, controller.snapshot);
  return (
    <RecoveryPanel
      view={view}
      onRetry={() => {
        void controller.check().catch(() => {});
      }}
      onRestore={(id) => {
        void controller.restore(id).catch(() => {});
      }}
      onDiscard={(id) => {
        void controller.discard(id).catch(() => {});
      }}
      onClose={close}
    />
  );
}
/** Registration is explicit. No business editor is automatically opted into persistence. */
export function createDraftRecovery(target: Window) {
  let store: DraftStore;
  try {
    store = new DraftStore(target.sessionStorage);
  } catch {
    throw Error('Локальне сховище чернеток недоступне.');
  }
  const channel =
    typeof BroadcastChannel === 'undefined'
      ? null
      : new BroadcastChannel('tsukenya-draft-session-v1');
  const controller = new RecoveryController(store, undefined, () =>
      channel?.postMessage({ type: 'revoke' }),
    ),
    uninstall = controller.install(target);
  if (channel)
    channel.onmessage = (event) => {
      if (event.data && event.data.type === 'revoke' && Object.keys(event.data).length === 1) {
        controller.suspend();
        try {
          store.erase();
        } catch {
          /* Private state is already hidden. */
        }
      }
    };
  let dialog: HTMLDialogElement | null = null,
    unmount: (() => void) | null = null;
  const close = () => {
    controller.dismiss();
    dialog?.close();
    unmount?.();
    unmount = null;
    dialog?.remove();
    dialog = null;
  };
  return {
    store,
    controller,
    register: (codec: Codec) => store.register(codec),
    open: () => {
      if (dialog?.open) {
        dialog.focus();
        return;
      }
      const opener = target.document.activeElement;
      dialog = target.document.createElement('dialog');
      dialog.className = 'tk-recovery-dialog';
      dialog.setAttribute('aria-label', 'Відновлення локальних чернеток');
      target.document.body.append(dialog);
      const root = createRoot(dialog);
      unmount = () => {
        root.unmount();
        if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
      };
      dialog.addEventListener('cancel', (event) => {
        event.preventDefault();
        close();
      });
      root.render(
        <I18nProvider locale="uk-UA">
          <View controller={controller} close={close} />
        </I18nProvider>,
      );
      dialog.showModal();
      void controller.check().catch(() => {});
    },
    close,
    invalidate: () => {
      controller.revoke();
      close();
    },
    dispose: () => {
      close();
      uninstall();
      channel?.close();
    },
  };
}
