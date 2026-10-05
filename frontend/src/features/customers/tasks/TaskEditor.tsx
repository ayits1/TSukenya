import { useEffect, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from 'react-aria-components';
import { Button } from '../../../shared/ui/Button';
import { TextField } from '../../../shared/ui/TextField';
import { Select } from '../../../shared/ui/Select';
import { NativeConflict } from '../../../shared/native/NativeConflict';
import { TaskMachine, installTaskRecovery, openTask } from './machine';
import * as api from './api';
import './tasks.css';
export const taskFields = [
  { id: 'title', label: 'Назва', keys: ['title'] },
  { id: 'note', label: 'Примітка', keys: ['note'] },
  {
    id: 'workflow',
    label: 'Стан, архів, виконавець і строк',
    keys: ['status', 'archived', 'assignee', 'due_on'],
  },
];
export function TaskEditor({
  machine,
  close,
  portalContainer,
}: {
  machine: TaskMachine;
  close: () => void;
  portalContainer?: Element;
}) {
  const v = useSyncExternalStore(machine.subscribe, machine.snapshot),
    s = api.state(v.payload.baseline),
    r = api.raw(v.payload.draft);
  const [people, setPeople] = useState<{ id: string; label: string }[]>([]),
    [search, setSearch] = useState(''),
    [page, setPage] = useState(1),
    [pages, setPages] = useState(1),
    [peopleError, setPeopleError] = useState('');
  useEffect(() => {
    if (!v.visible) return;
    const c = new AbortController();
    void api
      .request(
        '/api/v1/crm/contact-task-assignees?' +
          new URLSearchParams({ store: String(s.store), q: search, page: String(page) }),
        {},
        c.signal,
      )
      .then((value) => {
        const x = api.assignees(value, s.store);
        const items = x.items.map((u) => ({ id: String(u.id), label: u.name }));
        if (!c.signal.aborted) {
          setPeople(items);
          setPages(api.integer(x.pages));
          setPeopleError('');
        }
      })
      .catch((e) => {
        if (!c.signal.aborted) {
          setPeopleError(String(e));
          if (e && typeof e === 'object' && 'status' in e && (e.status === 401 || e.status === 403))
            void machine.denied(e.status);
        }
      });
    return () => c.abort();
  }, [v.visible, s.store, search, page, machine]);
  const change = (next: Partial<api.Raw>) => machine.raw({ ...r, ...next });
  return (
    <div className="contact-task-editor tk-root">
      <h2>Задача контакту</h2>
      {!v.visible ? (
        <>
          <p role="status">Поля приховані до перевірки чинного доступу.</p>
          {v.existing ? (
            <Button onPress={() => void machine.restoreExisting()}>
              Відновити наявну чернетку задачі
            </Button>
          ) : (
            <Button onPress={() => void machine.verify()}>Перевірити доступ</Button>
          )}
        </>
      ) : (
        <>
          <p>
            Клієнт №{s.customer} · Магазин №{s.store}
          </p>
          <TextField label="Назва задачі" value={r.title} onChange={(title) => change({ title })} />
          <TextField label="Примітка задачі" value={r.note} onChange={(note) => change({ note })} />
          <TextField
            label="Запланована дата"
            description="РРРР-ММ-ДД; порожнє поле — без дати"
            value={r.due_on}
            onChange={(due_on) => change({ due_on })}
          />
          <TextField
            label="Пошук виконавця"
            value={search}
            onChange={(value) => {
              setSearch(value);
              setPage(1);
            }}
          />
          <Select
            label="Виконавець"
            selectedKey={r.assignee || 'none'}
            onSelectionChange={(key) => change({ assignee: key === 'none' ? '' : String(key) })}
            options={[
              { id: 'none', label: 'Не призначено' },
              ...(r.assignee && !people.some((u) => u.id === r.assignee)
                ? [{ id: r.assignee, label: 'Збережений виконавець №' + r.assignee }]
                : []),
              ...people,
            ]}
            {...(portalContainer ? { portalContainer } : {})}
          />
          <div className="customer-actions">
            <Button isDisabled={page <= 1} onPress={() => setPage(page - 1)}>
              Попередні виконавці
            </Button>
            <Button isDisabled={page >= pages} onPress={() => setPage(page + 1)}>
              Наступні виконавці
            </Button>
          </div>
          {peopleError ? <p role="alert">{peopleError}</p> : null}
          <Select
            label="Стан задачі"
            selectedKey={r.status}
            onSelectionChange={(key) => change({ status: String(key) })}
            options={api.statuses}
            {...(portalContainer ? { portalContainer } : {})}
          />
          <label className="contact-task-check">
            <input
              type="checkbox"
              checked={r.archived}
              onChange={(e) => change({ archived: e.target.checked })}
            />
            Архівна задача
          </label>
          <div className="customer-actions">
            <Button
              isDisabled={v.busy || !!v.payload.firstIntent || s.needsReview}
              onPress={() => void machine.save()}
            >
              Зберегти задачу
            </Button>
            {v.payload.firstIntent ? (
              <>
                <Button isDisabled={v.busy} onPress={() => void machine.save()}>
                  Повторити первісний запит
                </Button>
                <Button isDisabled={v.busy} onPress={() => void machine.identity()}>
                  Перевірити первісний запис
                </Button>
              </>
            ) : null}
            {s.confirmed ? (
              <Button isDisabled={v.busy} onPress={() => void machine.current()}>
                Перечитати поточну задачу
              </Button>
            ) : null}
            {v.current && !v.payload.firstIntent ? (
              <Button onPress={() => machine.compare()}>Порівняти зміни</Button>
            ) : null}
          </div>
          {v.comparison && v.current && !v.payload.firstIntent ? (
            <NativeConflict
              fields={taskFields}
              base={s.base}
              mine={r}
              server={api.project(v.current.record.terms)}
              onApply={(draft) => machine.apply(api.raw(draft))}
              onCancel={() => machine.cancelCompare()}
              title="Порівняти задачу контакту"
            />
          ) : null}
        </>
      )}
      {v.busy ? <p role="status">Перевіряємо…</p> : null}
      {v.error ? <p role="alert">{v.error}</p> : null}
      <p className="tk-help">
        Задача не надсилає повідомлень і не змінює облік. Порівняння лише змінює локальні поля;
        запис — окремою кнопкою.
      </p>
      <div className="customer-actions">
        <Button onPress={close}>Закрити редактор задачі</Button>
        <Button
          onPress={() => {
            if (window.confirm('Відкинути локальну чернетку задачі?')) {
              void machine.discard().then((removed) => {
                if (removed) close();
              });
            }
          }}
        >
          Відкинути чернетку задачі
        </Button>
      </div>
    </div>
  );
}
export function installContactTaskEditor() {
  let dialog: HTMLDialogElement | null = null,
    dispose: (() => void) | null = null;
  installTaskRecovery((machine) => {
    dispose?.();
    const opener = document.activeElement;
    dialog = document.createElement('dialog');
    dialog.setAttribute('aria-label', 'Редактор задачі контакту');
    dialog.className = 'tk-recovery-dialog contact-task-editor-dialog';
    document.body.append(dialog);
    const root = createRoot(dialog);
    const close = () => {
      machine.dispose();
      dialog?.close();
      root.unmount();
      dialog?.remove();
      dialog = null;
      dispose = null;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
    dispose = close;
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      close();
    });
    root.render(
      <I18nProvider locale="uk-UA">
        <TaskEditor machine={machine} close={close} portalContainer={dialog} />
      </I18nProvider>,
    );
    dialog.showModal();
  });
}
export { openTask };
