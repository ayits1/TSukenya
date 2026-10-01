import {
  Select as AriaSelect,
  Label,
  Button,
  SelectValue,
  Popover,
  ListBox,
  ListBoxItem,
  Text,
  FieldError,
} from 'react-aria-components';
import type { SelectProps } from 'react-aria-components';
import { Chevron } from './Chevron';

export type Choice = { id: string; label: string };
type Props = Omit<SelectProps<Choice>, 'children' | 'className'> & {
  label: string;
  options: Choice[];
  description?: string;
  error?: string;
};

export function Select({ label, options, description, error, ...props }: Props) {
  return (
    <AriaSelect
      {...props}
      className="tk-field"
      validationBehavior="aria"
      isInvalid={!!error || !!props.isInvalid}
    >
      <Label className="tk-label">{label}</Label>
      <Button className="tk-select-trigger">
        <SelectValue className="tk-select-value" />
        <Chevron />
      </Button>
      {description ? (
        <Text slot="description" className="tk-help">
          {description}
        </Text>
      ) : null}
      <FieldError className="tk-error">{error}</FieldError>
      <Popover className="tk-popover" placement="bottom start">
        <ListBox className="tk-listbox" items={options}>
          {(option) => (
            <ListBoxItem className="tk-option" id={option.id} textValue={option.label}>
              {option.label}
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </AriaSelect>
  );
}
