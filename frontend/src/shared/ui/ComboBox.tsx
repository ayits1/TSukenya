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
import { useContext, useRef, type ReactNode, type RefObject } from 'react';
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

export function ComboBox({
  label,
  options,
  description,
  error,
  placeholder,
  popoverFooter,
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
            if (event.key === 'Escape' && popoverFooter && footerRef.current)
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
      <Popover
        className={'tk-popover' + (popoverFooter ? ' tk-popover--paged' : '')}
        placement="bottom start"
        // The native dialog is itself scrollable. Keep Aria's viewport boundary rather than
        // using that same scrolled containing block as its boundary. Native dialogs are inset
        // at most 24px vertically; 8px more keeps the menu/focus border within that visible area.
        {...(portalContainer
          ? { UNSTABLE_portalContainer: portalContainer, containerPadding: 32 }
          : {})}
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
      </Popover>
    </AriaComboBox>
  );
}
