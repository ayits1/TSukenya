import type { Ref } from 'react';
import { ReferencePicker } from './ReferencePicker';
import type {
  ReferenceDirectoryApi,
  ReferenceQuery,
  ManagedReference,
} from './referenceDirectoryApi';
import { TextField } from '../../shared/ui/TextField';
import { Button } from '../../shared/ui/Button';

export type ReferenceCreation = {
  value: string;
  error: string;
  pending: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
};

/** Selection is committed only from an option; creation is an explicit separate action. */
export function CatalogReferenceField({
  label,
  value,
  api,
  query,
  selected,
  onChange,
  onAdd,
  canAdd,
  isDisabled,
  isRequired = false,
  description,
  creation,
  addButtonRef,
  archived = false,
}: {
  label: string;
  value: string;
  api: ReferenceDirectoryApi;
  query: ReferenceQuery;
  selected: ManagedReference | null;
  onChange: (value: string) => void;
  onAdd: () => void;
  canAdd: boolean;
  isDisabled: boolean;
  isRequired?: boolean;
  description?: string;
  creation?: ReferenceCreation;
  addButtonRef?: Ref<HTMLButtonElement>;
  archived?: boolean;
}) {
  return (
    <div className="tk-reference-field">
      <ReferencePicker
        api={api}
        query={query}
        selected={selected}
        label={label}
        value={value}
        onCommit={(item) => onChange(item.value)}
        disabled={isDisabled}
        required={isRequired}
        {...(description ? { description } : {})}
      />
      {archived ? (
        <p className="tk-help">
          «{value}» архівовано. Запис недоступний для нового вибору. Наявний товар може зберегти
          його без зміни.
        </p>
      ) : null}
      <div className="tk-reference-actions">
        <Button
          ref={addButtonRef}
          onPress={onAdd}
          isDisabled={!canAdd}
          aria-label={`Додати запис: ${label}`}
        >
          + Додати
        </Button>
        {!isRequired && value ? (
          <Button
            onPress={() => onChange('')}
            isDisabled={isDisabled}
            aria-label={`Очистити: ${label}`}
          >
            Очистити
          </Button>
        ) : null}
      </div>
      {creation ? (
        <section
          className="tk-reference-create"
          aria-label={`Новий запис: ${label}`}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
              event.preventDefault();
              if (!creation.pending && creation.value.trim()) creation.onSave();
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              if (!creation.pending) creation.onCancel();
            }
          }}
        >
          <TextField
            label={`Новий запис: ${label}`}
            value={creation.value}
            onChange={creation.onChange}
            autoFocus
            maxLength={label === 'Одиниця' ? 30 : 160}
            isReadOnly={creation.pending}
          />
          <p className="tk-help">Запис залишиться в довіднику, навіть якщо товар не зберегти.</p>
          {creation.error ? (
            <p className="tk-error" role="alert">
              {creation.error}
            </p>
          ) : null}
          <div className="tk-reference-actions">
            <Button
              variant="primary"
              onPress={creation.onSave}
              isDisabled={creation.pending || !creation.value.trim()}
            >
              {creation.pending ? 'Додаємо…' : 'Додати й вибрати'}
            </Button>
            <Button onPress={creation.onCancel} isDisabled={creation.pending}>
              Скасувати додавання
            </Button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
