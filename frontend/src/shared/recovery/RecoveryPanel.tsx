import { useRef, useState } from 'react';
import { Button } from '../ui/Button';
import type { RecoveryView } from './controller';
import './recovery.css';
export type RecoveryPanelProps = {
  view: RecoveryView;
  onRetry: () => void;
  onRestore: (id: string) => void;
  onDiscard: (id: string) => void;
  onClose: () => void;
};
export function RecoveryPanel({
  view,
  onRetry,
  onRestore,
  onDiscard,
  onClose,
}: RecoveryPanelProps) {
  const [discard, setDiscard] = useState<string | null>(null),
    confirmRef = useRef<HTMLButtonElement>(null);
  return (
    <section className="tk-recovery" aria-labelledby="recoveryHeading">
      <h2 id="recoveryHeading">Чернетки цієї вкладки</h2>
      <p>
        Відновлення повертає локальне введення. Збереження та точний повтор запиту виконуються
        окремо.
      </p>
      {view.state === 'checking' ? (
        <p role="status">Перевіряємо чинний сеанс…</p>
      ) : view.state === 'error' ? (
        <>
          <p role="alert">{view.error}</p>
          <Button onPress={onRetry}>Повторити перевірку</Button>
        </>
      ) : (
        <>
          {!view.entries.length ? (
            <p>Збережених чернеток підключених редакторів немає.</p>
          ) : (
            <ul>
              {view.entries.map((entry) => (
                <li key={entry.id}>
                  <h3>{entry.label}</h3>
                  <p>
                    {entry.state === 'unknown'
                      ? 'Результат первісного запиту невідомий. Він міг уже виконатися.'
                      : entry.state === 'confirmed'
                        ? 'Запис підтверджено. Новіші поля або оновлення даних ще потребують уваги.'
                        : entry.state === 'unreadable'
                          ? 'Непідтримувана або пошкоджена чернетка. Її поля не прочитано.'
                          : 'Є незбережене локальне введення.'}
                  </p>
                  {discard === entry.id ? (
                    <div role="group" aria-label="Підтвердити відкидання">
                      <p>
                        Відкинути лише локальну чернетку? Це не скасує запит, який міг уже
                        виконатися на сервері.
                      </p>
                      <Button
                        ref={confirmRef}
                        onPress={() => {
                          setDiscard(null);
                          onDiscard(entry.id);
                        }}
                      >
                        Відкинути локальну чернетку
                      </Button>
                      <Button onPress={() => setDiscard(null)}>Залишити чернетку</Button>
                    </div>
                  ) : (
                    <div className="tk-recovery-actions">
                      <Button
                        isDisabled={entry.state === 'unreadable'}
                        variant="primary"
                        onPress={() => onRestore(entry.id)}
                      >
                        Відновити введення
                      </Button>
                      <Button
                        onPress={() => {
                          setDiscard(entry.id);
                          queueMicrotask(() => confirmRef.current?.focus());
                        }}
                      >
                        Відкинути…
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <Button onPress={onClose}>Закрити</Button>
    </section>
  );
}
