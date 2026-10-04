import {
  ComboBox as AriaComboBox,
  Input,
  Button,
  Label,
  Group,
  Popover,
  ListBox,
  ListBoxItem,
  Text,
  FieldError,
  useFilter,
  ComboBoxStateContext,
} from 'react-aria-components';
import type { ComboBoxProps } from 'react-aria-components';
import {
  useContext,
  useRef,
  useState,
  useLayoutEffect,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import type { Choice } from './Select';
import { Chevron } from './Chevron';

type Search =
  | {
      /** Options are the complete local list; typed text filters them in the browser. */
      search?: 'local';
      selectedOption?: never;
      isLoading?: never;
    }
  | {
      /**
       * Options are already the server's matches for the typed text (any word order, barcode).
       * They are listed as received: a second substring filter would hide valid matches.
       */
      search: 'server';
      /** Committed option, kept so the input shows its label while it is absent from results. */
      selectedOption?: Choice | null;
      /** The server has not answered for the current text yet (including a pending debounce). */
      isLoading?: boolean;
    };
type Props = Omit<
  ComboBoxProps<Choice>,
  'children' | 'className' | 'items' | 'defaultItems' | 'defaultFilter'
> & {
  label: string;
  options: Choice[];
  description?: string;
  error?: string;
  placeholder?: string;
  /** Composed navigation for a server page; stays inside the same Aria popover. */
  popoverFooter?: ReactNode;
  /** Server directories need readable options even with a compact trigger. */
  widePopover?: boolean;
  /** Native dialog forms must keep their overlay in the dialog's top layer. */
  portalContainer?: Element;
} & Search;

function PagingFooter({
  children,
  input,
  host,
}: {
  children: ReactNode;
  input: RefObject<HTMLInputElement | null>;
  host: RefObject<HTMLDivElement | null>;
}) {
  const state = useContext(ComboBoxStateContext);
  return (
    <div
      ref={host}
      className="tk-paging-footer"
      onKeyDownCapture={(event) => {
        const buttons = Array.from(
          host.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [],
        );
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          state?.revert();
          input.current?.focus();
        }
        if (event.key === 'Tab' && event.shiftKey && event.target === buttons[0]) {
          event.preventDefault();
          event.stopPropagation();
          input.current?.focus();
        }
      }}
    >
      {children}
    </div>
  );
}

/** Native dialogs are top-layer scroll containers. Use their visible rectangle rather than
 * mixing document and dialog scroll offsets in overlay positioning. Aria still owns focus/menu. */
function ChoicePopover({
  input,
  portalContainer,
  wide,
  paged,
  children,
}: {
  input: RefObject<HTMLInputElement | null>;
  portalContainer?: Element;
  wide: boolean;
  paged: boolean;
  children: ReactNode;
}) {
  const state = useContext(ComboBoxStateContext);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [geometry, setGeometry] = useState<CSSProperties>();
  const dialog = portalContainer instanceof HTMLDialogElement ? portalContainer : null;
  useLayoutEffect(() => {
    if (!dialog || !state?.isOpen || !menu) return;
    const measure = () => {
      if (!input.current) return;
      const trigger = input.current.closest('.tk-combo-group')!.getBoundingClientRect();
      const bounds = dialog.getBoundingClientRect();
      const leftEdge = Math.max(8, bounds.left + 8),
        rightEdge = Math.min(innerWidth - 8, bounds.right - 8);
      const topEdge = Math.max(8, bounds.top + 8),
        bottomEdge = Math.min(innerHeight - 8, bounds.bottom - 8);
      const minimum = wide
        ? 20 * parseFloat(getComputedStyle(document.documentElement).fontSize)
        : 0;
      const width = Math.min(Math.max(trigger.width, minimum), rightEdge - leftEdge);
      const below = Math.max(0, bottomEdge - trigger.bottom - 4),
        above = Math.max(0, trigger.top - topEdge - 4);
      const down = below >= Math.min(menu.scrollHeight, 300) || below >= above;
      const maxHeight = Math.max(44, down ? below : above);
      const height = Math.min(menu.scrollHeight, maxHeight);
      const next = {
        position: 'fixed' as const,
        width,
        minWidth: width,
        left: Math.max(leftEdge, Math.min(trigger.left, rightEdge - width)),
        top: down ? trigger.bottom + 4 : Math.max(topEdge, trigger.top - height - 4),
        maxHeight,
      };
      setGeometry((previous) =>
        JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(menu);
    observer.observe(dialog);
    window.addEventListener('resize', measure);
    measure();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [dialog, state?.isOpen, menu, input, wide]);
  return (
    <Popover
      ref={setMenu}
      className={
        'tk-popover' + (wide ? ' tk-popover--directory' : '') + (paged ? ' tk-popover--paged' : '')
      }
      placement="bottom start"
      {...(dialog
        ? {
            UNSTABLE_portalContainer: dialog,
            shouldUpdatePosition: false,
            style: geometry || { position: 'fixed', visibility: 'hidden' },
          }
        : {})}
    >
      {children}
    </Popover>
  );
}

export function ComboBox({
  label,
  options,
  description,
  error,
  placeholder,
  popoverFooter,
  widePopover = false,
  portalContainer,
  search = 'local',
  selectedOption = null,
  isLoading = false,
  ...props
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null),
    footerRef = useRef<HTMLDivElement>(null);
  const server = search === 'server';
  const { contains } = useFilter({ sensitivity: 'base' });
  const items =
    server && selectedOption && !options.some((option) => option.id === selectedOption.id)
      ? [selectedOption, ...options]
      : options;
  // Fresh server results are listed exactly (React Aria filters by text, so by label); the committed
  // option only resolves the input label. While the answer for the typed text is pending, the
  // previous results are narrowed locally so ArrowDown+Enter cannot pick an unrelated stale item.
  const results = server ? new Set(options.map((option) => option.label)) : null;
  const serverFilter = (text: string, input: string) =>
    results!.has(text) && (!isLoading || contains(text, input));
  return (
    <AriaComboBox
      {...props}
      onSelectionChange={(key) => {
        // Search text is temporary. Clearing it must not discard a committed product.
        if (key !== null) props.onSelectionChange?.(key);
      }}
      defaultItems={items}
      {...(results ? { defaultFilter: serverFilter } : {})}
      menuTrigger="focus"
      allowsEmptyCollection
      allowsCustomValue={false}
      className="tk-field"
      validationBehavior="aria"
      isInvalid={!!error || !!props.isInvalid}
    >
      <Label className="tk-label">{label}</Label>
      <Group className="tk-combo-group">
        <Input
          ref={inputRef}
          className="tk-combo-input"
          {...(placeholder === undefined ? {} : { placeholder })}
          onKeyDownCapture={(event) => {
            // A native dialog must keep Escape within its currently open menu.
            if (
              event.key === 'Escape' &&
              inputRef.current?.getAttribute('aria-expanded') === 'true'
            )
              event.preventDefault();
            if (event.key === 'Tab' && !event.shiftKey && popoverFooter && footerRef.current) {
              const button =
                footerRef.current.querySelector<HTMLButtonElement>('button:not(:disabled)');
              if (button) {
                event.preventDefault();
                event.stopPropagation();
                button.focus();
              }
            }
          }}
        />
        <Button className="tk-combo-toggle" aria-label={`Відкрити список: ${label}`}>
          <Chevron />
        </Button>
      </Group>
      {description ? (
        <Text slot="description" className="tk-help">
          {description}
        </Text>
      ) : null}
      <FieldError className="tk-error">{error}</FieldError>
      <ChoicePopover
        input={inputRef}
        wide={widePopover}
        paged={!!popoverFooter}
        {...(portalContainer ? { portalContainer } : {})}
      >
        <ListBox
          className="tk-listbox"
          renderEmptyState={() => (
            <div className="tk-empty">{isLoading ? 'Шукаємо…' : 'Нічого не знайдено'}</div>
          )}
        >
          {(option: Choice) => (
            <ListBoxItem className="tk-option" id={option.id} textValue={option.label}>
              {option.label}
            </ListBoxItem>
          )}
        </ListBox>
        {popoverFooter ? (
          <PagingFooter input={inputRef} host={footerRef}>
            {popoverFooter}
          </PagingFooter>
        ) : null}
      </ChoicePopover>
    </AriaComboBox>
  );
}
