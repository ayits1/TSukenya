import { Button as AriaButton } from 'react-aria-components';
import type { ButtonProps } from 'react-aria-components';

type Props = Omit<ButtonProps, 'className'> & {
  variant?: 'primary' | 'secondary';
  className?: string;
};

export function Button({ variant = 'secondary', className, ...props }: Props) {
  return (
    <AriaButton
      {...props}
      className={`tk-button tk-button--${variant} ${typeof className === 'string' ? className : ''}`}
    />
  );
}
