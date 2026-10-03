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
} from 'react-aria-components';
import type { ComboBoxProps } from 'react-aria-components';
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
} & Search;

export function ComboBox({
  label,
  options,
  description,
  error,
  placeholder,
  search = 'local',
  selectedOption = null,
  isLoading = false,
  ...props
}: Props) {
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
        <Input className="tk-combo-input" {...(placeholder === undefined ? {} : { placeholder })} />
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
      <Popover className="tk-popover" placement="bottom start">
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
      </Popover>
    </AriaComboBox>
  );
}
