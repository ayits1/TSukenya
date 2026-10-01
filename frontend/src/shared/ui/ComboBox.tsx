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
} from 'react-aria-components';
import type { ComboBoxProps } from 'react-aria-components';
import type { Choice } from './Select';
import { Chevron } from './Chevron';

type Props = Omit<ComboBoxProps<Choice>, 'children' | 'className' | 'items' | 'defaultItems'> & {
  label: string;
  options: Choice[];
  description?: string;
  error?: string;
  placeholder?: string;
};

export function ComboBox({ label, options, description, error, placeholder, ...props }: Props) {
  return (
    <AriaComboBox
      {...props}
      onSelectionChange={(key) => {
        // Search text is temporary. Clearing it must not discard a committed product.
        if (key !== null) props.onSelectionChange?.(key);
      }}
      defaultItems={options}
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
          renderEmptyState={() => <div className="tk-empty">Нічого не знайдено</div>}
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
