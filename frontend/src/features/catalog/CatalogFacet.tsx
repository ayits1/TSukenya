import { useEffect, useRef, useState } from 'react';
import { Button } from '../../shared/ui/Button';
import { ComboBox } from '../../shared/ui/ComboBox';
import type { FacetApi, FacetField, FacetPage, Filters } from './api';

/** A committed facet is independent of temporary search and the current page. */
export function CatalogFacet({
  label,
  allLabel,
  field,
  filters,
  value,
  load,
  onChange,
  disabled = false,
}: {
  label: string;
  allLabel: string;
  field: FacetField;
  filters: Filters;
  value: string;
  load: FacetApi;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const [input, setInput] = useState(value);
  const [observed, setObserved] = useState(value);
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(false);
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ identity: string; data: FacetPage } | null>(null);
  const generation = useRef(0);
  const host = useRef<HTMLDivElement>(null);
  const returnFocus = useRef(false);
  const search = input === value ? '' : input;
  const parents = { ...filters, page: 1 };
  // Field and descendants never constrain their own choices.
  for (const key of (field === 'type'
    ? ['type', 'category', 'pack']
    : field === 'category'
      ? ['category', 'pack']
      : ['pack']) as FacetField[])
    parents[key] = '';
  const signature = JSON.stringify(parents);
  const identity = JSON.stringify([signature, field, search, page]);
  if (observed !== value) {
    setObserved(value);
    setInput(value);
    setPage(1);
  }
  const current = result?.identity === identity ? result.data : null;
  useEffect(() => {
    if (!open || disabled) return;
    const token = ++generation.current;
    const controller = new AbortController();
    let active = true;
    const timer = setTimeout(
      () => {
        setError('');
        void load(JSON.parse(signature) as Filters, field, search, page, controller.signal)
          .then((data) => {
            if (!active || token !== generation.current || controller.signal.aborted) return;
            setResult({ identity, data });
            if (data.page !== page) setPage(data.page);
            if (returnFocus.current) {
              returnFocus.current = false;
              host.current?.querySelector<HTMLInputElement>('[role=combobox]')?.focus();
            }
          })
          .catch((cause: unknown) => {
            if (!active || token !== generation.current || controller.signal.aborted) return;
            setResult(null);
            setError(cause instanceof Error ? cause.message : 'Не вдалося прочитати фільтри.');
          });
      },
      search ? 200 : 0,
    );
    return () => {
      clearTimeout(timer);
      active = false;
      controller.abort();
    };
  }, [load, signature, identity, field, search, page, open, disabled, retry]);
  const navigate = (step: number) => {
    if (!current) return;
    returnFocus.current = !!document.activeElement?.closest('.tk-paging-footer');
    setPage(current.page + step);
  };
  return (
    <div ref={host} className="tk-catalog-facet">
      <ComboBox
        label={label}
        placeholder={value ? 'Знайдіть значення…' : allLabel}
        search="server"
        selectedKey={value || null}
        selectedOption={value ? { id: value, label: value } : null}
        options={current?.items.map((item) => ({ id: item, label: item })) || []}
        inputValue={input}
        onInputChange={(text) => {
          setInput(text);
          setPage(1);
        }}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            returnFocus.current = false;
            setInput(value);
            setPage(1);
          }
        }}
        isLoading={open && !current && !error}
        isDisabled={disabled}
        onSelectionChange={(key) => {
          if (current?.items.includes(String(key))) onChange(String(key));
        }}
        popoverFooter={
          <>
            {error ? (
              <span role="alert">
                {error} <Button onPress={() => setRetry((n) => n + 1)}>Повторити читання</Button>
              </span>
            ) : (
              <span role="status">
                {current
                  ? `Сторінка ${current.page} із ${current.pages} · знайдено ${current.total}`
                  : 'Читаємо фільтри…'}
              </span>
            )}
            <Button
              onPress={() => {
                onChange('');
                setInput('');
                setPage(1);
              }}
              isDisabled={disabled}
            >
              {allLabel}
            </Button>
            <Button
              aria-label={`Попередні значення: ${label}`}
              onPress={() => navigate(-1)}
              isDisabled={!current || current.page === 1}
            >
              Назад
            </Button>
            <Button
              aria-label={`Наступні значення: ${label}`}
              onPress={() => navigate(1)}
              isDisabled={!current || current.page === current.pages}
            >
              Далі
            </Button>
          </>
        }
      />
    </div>
  );
}
