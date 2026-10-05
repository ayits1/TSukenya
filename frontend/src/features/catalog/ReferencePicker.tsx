import { useEffect, useRef, useState } from 'react';
import { ComboBox } from '../../shared/ui/ComboBox';
import { Button } from '../../shared/ui/Button';
import type {
  ReferenceDirectoryApi,
  ReferencePage,
  ReferenceQuery,
  ManagedReference,
} from './referenceDirectoryApi';

/** Only a server option commits; search text and pagination never replace a draft. */
export function ReferencePicker({
  api,
  query,
  label,
  selected,
  value,
  onCommit,
  disabled = false,
  required = false,
  description,
}: {
  api: ReferenceDirectoryApi;
  query: ReferenceQuery;
  label: string;
  selected: ManagedReference | null;
  value: string;
  onCommit: (item: ManagedReference) => void;
  disabled?: boolean;
  required?: boolean;
  description?: string;
}) {
  const signature = JSON.stringify(query),
    identity = signature + ':' + (selected?.id || '') + ':' + value;
  const caption =
    value +
    (selected?.state === 'archived'
      ? ' · Архівований'
      : selected?.state === 'merged'
        ? ' · Об’єднаний'
        : '');
  const pinned = value ? { id: selected?.id || 'historical-' + query.field, label: caption } : null;
  const [observed, setObserved] = useState(identity),
    [input, setInput] = useState(caption),
    [observedCaption, setObservedCaption] = useState(caption);
  const [page, setPage] = useState(1),
    [retry, setRetry] = useState(0),
    [active, setActive] = useState(false);
  const [result, setResult] = useState<{
      signature: string;
      search: string;
      data: ReferencePage;
    } | null>(null),
    [error, setError] = useState(''),
    [pending, setPending] = useState(true);
  const sequence = useRef(0),
    host = useRef<HTMLDivElement>(null),
    returnFocus = useRef(false);
  if (observed !== identity) {
    setObserved(identity);
    setInput(caption);
    setPage(1);
    setError('');
  }
  if (observedCaption !== caption) {
    setObservedCaption(caption);
    if (input === observedCaption) setInput(caption);
  }
  const search = input === caption ? '' : input;
  const current =
    result?.signature === signature && result.search === search && result.data.page === page
      ? result.data
      : null;
  useEffect(() => {
    if (!active || disabled) return;
    const currentSequence = ++sequence.current,
      abort = new AbortController();
    const timer = setTimeout(
      () => {
        setPending(true);
        setError('');
        void api
          .page({ ...query, q: search }, page, abort.signal)
          .then((data) => {
            if (currentSequence !== sequence.current || abort.signal.aborted) return;
            setResult({ signature, search, data });
            if (data.page !== page) setPage(data.page);
            if (returnFocus.current) {
              returnFocus.current = false;
              host.current?.querySelector<HTMLInputElement>('[role=combobox]')?.focus();
            }
          })
          .catch((cause: unknown) => {
            if (currentSequence !== sequence.current || abort.signal.aborted) return;
            setResult(null);
            setError(cause instanceof Error ? cause.message : 'Не вдалося прочитати довідник.');
          })
          .finally(() => {
            if (currentSequence === sequence.current && !abort.signal.aborted) setPending(false);
          });
      },
      search ? 250 : 0,
    );
    return () => {
      clearTimeout(timer);
      abort.abort();
      sequence.current += 1;
    };
    // query is represented by the exact scalar signature.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, signature, search, page, retry, active, disabled]);
  const loading = pending || (!current && !error);
  const navigate = (step: number) => {
    if (!current || loading || current.page + step < 1 || current.page + step > current.pages)
      return;
    returnFocus.current = !!document.activeElement?.closest('[data-reference-paging]');
    setPending(true);
    setPage(current.page + step);
  };
  return (
    <div
      ref={host}
      className="tk-reference-picker"
      onKeyDownCapture={(event) => {
        if (event.key === 'Escape' && active) {
          // A null selection has no Aria item label to restore. The caller's
          // committed caption remains authoritative even for an empty draft.
          setInput(caption);
          setPage(1);
          setActive(false);
        }
      }}
    >
      <ComboBox
        label={label}
        options={
          current?.items.map((item) => ({
            id: item.id,
            label: item.value + (item.parentType ? ` · ${item.parentType}` : ''),
          })) || []
        }
        search="server"
        selectedKey={pinned?.id || null}
        selectedOption={pinned}
        inputValue={input}
        onInputChange={(text) => {
          if (text !== input) {
            setInput(text);
            setPage(1);
            setPending(true);
            setError('');
          }
        }}
        onOpenChange={(open) => {
          setActive(open);
          if (!open) {
            setInput(caption);
            setPage(1);
          }
        }}
        onSelectionChange={(key) => {
          if (pinned && key === pinned.id) {
            setInput(caption);
            setPage(1);
            return;
          }
          if (loading) return;
          const item = current?.items.find((item) => item.id === key);
          if (!item) return;
          setInput(item.value);
          onCommit(item);
        }}
        isLoading={loading}
        isDisabled={disabled}
        isRequired={required}
        placeholder="Виберіть або знайдіть"
        widePopover
        {...(description ? { description } : {})}
        {...(error ? { error } : {})}
        onKeyDown={(event) => {
          if (event.altKey && ['PageDown', 'PageUp'].includes(event.key)) {
            event.preventDefault();
            navigate(event.key === 'PageDown' ? 1 : -1);
          }
        }}
        popoverFooter={
          error || loading || (current && current.pages > 1) ? (
            <div className="tk-reference-paging" data-reference-paging>
              <span role="status">
                {loading
                  ? 'Шукаємо…'
                  : current
                    ? `${current.total} записів · ${current.page} / ${current.pages}`
                    : 'Читання не вдалося'}
              </span>
              {error ? (
                <Button
                  onPress={() => {
                    setPending(true);
                    setError('');
                    setRetry((value) => value + 1);
                  }}
                >
                  Повторити читання
                </Button>
              ) : result?.signature === signature && result.data.pages > 1 ? (
                <div>
                  <Button
                    isDisabled={loading || !current || current.page <= 1}
                    onPress={() => navigate(-1)}
                  >
                    Назад
                  </Button>
                  <Button
                    isDisabled={loading || !current || current.page >= current.pages}
                    onPress={() => navigate(1)}
                  >
                    Далі
                  </Button>
                </div>
              ) : null}
              {current && current.pages > 1 ? (
                <small>Alt + PageUp / PageDown — сторінки</small>
              ) : null}
            </div>
          ) : null
        }
      />
    </div>
  );
}
