import { useEffect, useRef, useState } from 'react';
import { ComboBox } from '../../shared/ui/ComboBox';
import { Button } from '../../shared/ui/Button';
import type { Choice } from '../../shared/ui/Select';
import type {
  DirectoryItem,
  DirectoryPage,
  DirectoryQuery,
  DirectoryType,
  TradingApi,
} from './api';
import './trading.css';
export type DirectoryComboBoxProps = {
  api: TradingApi;
  type: DirectoryType;
  query: DirectoryQuery;
  label: string;
  value: string;
  selected: DirectoryItem | null;
  disabled?: boolean;
  required?: boolean;
  portalContainer?: Element;
  externalSearch?: { id: number; text: string };
  onCommit: (item: DirectoryItem | null) => void;
  onItems?: (items: DirectoryItem[]) => void;
};
const choice = (item: DirectoryItem): Choice => ({
  id: item.id,
  label:
    item.name +
    (item.active === false ? ' · неактивний' : '') +
    (item.hidden ? ' · прихований' : '') +
    (item.unit ? ' · ' + item.unit : '') +
    (item.promotion ? ' · Акція' : ''),
});
export function DirectoryComboBox({
  api,
  type,
  query,
  label,
  value,
  selected,
  disabled = false,
  required = false,
  portalContainer,
  externalSearch,
  onCommit,
  onItems,
}: DirectoryComboBoxProps) {
  const signature = JSON.stringify([type, query]);
  const identity = signature + ':' + value;
  const labelText = selected ? choice(selected).label : '';
  const [observedLabel, setObservedLabel] = useState(labelText);
  const [searchCommand, setSearchCommand] = useState(externalSearch?.id);
  const [observed, setObserved] = useState(identity);
  const [input, setInput] = useState(
    externalSearch?.text ?? (selected ? choice(selected).label : ''),
  );
  const [page, setPage] = useState(1),
    [retry, setRetry] = useState(0);
  const [active, setActive] = useState(false);
  const [result, setResult] = useState<{
    signature: string;
    search: string;
    data: DirectoryPage;
  } | null>(null);
  const [error, setError] = useState(''),
    [pending, setPending] = useState(true);
  const request = useRef(0),
    onItemsRef = useRef(onItems);
  const host = useRef<HTMLDivElement>(null),
    returnFocus = useRef(false);
  useEffect(() => {
    onItemsRef.current = onItems;
  }, [onItems]);
  if (observed !== identity) {
    setObserved(identity);
    setInput(selected ? choice(selected).label : '');
    setPage(1);
  }
  if (observedLabel !== labelText) {
    setObservedLabel(labelText);
    if (input === observedLabel) setInput(labelText);
  }
  if (searchCommand !== externalSearch?.id) {
    setSearchCommand(externalSearch?.id);
    setInput(externalSearch?.text || '');
    setPage(1);
  }
  const committed = selected ? choice(selected) : null;
  const search = input === committed?.label ? '' : input;
  const current =
    result?.signature === signature && result.search === search && result.data.page === page
      ? result.data
      : null;
  useEffect(() => {
    if (!active || disabled) return;
    const token = ++request.current,
      controller = new AbortController();
    const timer = window.setTimeout(
      () => {
        setPending(true);
        setError('');
        void api
          .list(type, { ...query, q: search, page }, controller.signal)
          .then((data) => {
            if (token !== request.current || controller.signal.aborted) return;
            setResult({ signature, search, data });
            if (data.page !== page) setPage(data.page);
            onItemsRef.current?.(data.items);
            if (returnFocus.current) {
              returnFocus.current = false;
              host.current?.querySelector<HTMLInputElement>('[role=combobox]')?.focus();
            }
          })
          .catch((cause: unknown) => {
            if (token !== request.current || controller.signal.aborted) return;
            setError(cause instanceof Error ? cause.message : 'Не вдалося завантажити довідник.');
            setResult(null);
          })
          .finally(() => {
            if (token === request.current && !controller.signal.aborted) setPending(false);
          });
      },
      search ? 250 : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // query is represented by its complete signature; callbacks do not restart GETs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, type, signature, search, page, retry, active, disabled]);
  const loading = pending || (!current && !error);
  const navigate = (step: number) => {
    if (!current || loading) return;
    const next = current.page + step;
    if (next < 1 || next > current.pages) return;
    returnFocus.current = !!document.activeElement?.closest('[data-directory-paging]');
    setPage(next);
  };
  return (
    <div className="tk-directory-control" ref={host}>
      <ComboBox
        {...(portalContainer ? { portalContainer } : {})}
        label={label}
        onOpenChange={setActive}
        options={current?.items.map(choice) || []}
        search="server"
        selectedOption={committed}
        selectedKey={value || null}
        inputValue={input}
        onInputChange={(text) => {
          if (text === input) return;
          setInput(text);
          setPage(1);
          setPending(true);
          setError('');
        }}
        onSelectionChange={(key) => {
          if (String(key) === value && committed) {
            setInput(committed.label);
            setPage(1);
            return;
          }
          if (loading) return;
          const item = current?.items.find((item) => item.id === String(key));
          if (!item) return;
          setInput(choice(item).label);
          onCommit(item);
        }}
        isLoading={loading}
        isDisabled={disabled}
        isRequired={required}
        {...(error ? { error } : {})}
        {...(required && !value
          ? { description: 'Оберіть запис зі списку. Введений текст ще не є вибором.' }
          : {})}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !value) {
            setInput('');
            setPage(1);
          }
          if (event.altKey && ['PageDown', 'PageUp'].includes(event.key)) {
            event.preventDefault();
            navigate(event.key === 'PageDown' ? 1 : -1);
          }
        }}
        popoverFooter={
          <div className="tk-directory-paging" data-directory-paging>
            <span role="status">
              {loading
                ? 'Шукаємо…'
                : current
                  ? `${current.total} записів · ${current.page} / ${current.pages}`
                  : error
                    ? 'Читання не вдалося'
                    : '0 записів'}
            </span>
            {error ? (
              <Button
                onPress={() => {
                  setRetry((n) => n + 1);
                  setPending(true);
                  setError('');
                }}
              >
                Повторити
              </Button>
            ) : (
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
            )}
            <small>Alt + PageUp / PageDown — сторінки</small>
          </div>
        }
      />
      {value && !required ? (
        <Button
          aria-label={`Очистити вибір: ${label}`}
          isDisabled={disabled}
          onPress={() => {
            setInput('');
            setPage(1);
            onCommit(null);
          }}
        >
          Очистити
        </Button>
      ) : null}
    </div>
  );
}
