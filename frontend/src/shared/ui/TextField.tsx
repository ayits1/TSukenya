import { TextField as AriaTextField, Input, Label, Text, FieldError } from 'react-aria-components';
import type { TextFieldProps } from 'react-aria-components';

type Props = Omit<TextFieldProps, 'children' | 'className'> & {
  label: string;
  description?: string;
  error?: string;
  placeholder?: string;
};

export function TextField({ label, description, error, placeholder, ...props }: Props) {
  return (
    <AriaTextField
      {...props}
      className="tk-field"
      validationBehavior="aria"
      isInvalid={!!error || !!props.isInvalid}
    >
      <Label className="tk-label">{label}</Label>
      <Input className="tk-input" {...(placeholder === undefined ? {} : { placeholder })} />
      {description ? (
        <Text slot="description" className="tk-help">
          {description}
        </Text>
      ) : null}
      <FieldError className="tk-error">{error}</FieldError>
    </AriaTextField>
  );
}
