import { useId, useRef, useState } from 'react';
import { TextField, Input, FieldError } from 'react-aria-components';

function split(value: string) {
  const [hryvnias = '', fraction] = value.replace(',', '.').split('.');
  return {
    source: value,
    hryvnias,
    kopecks: fraction === undefined ? '' : fraction.padEnd(2, '0'),
  };
}

/** Two editable parts, one decimal-string value. No floating-point arithmetic. */
export function MoneyField({
  label,
  value,
  onChange,
  isRequired = false,
  isDisabled = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  isRequired?: boolean;
  isDisabled?: boolean;
}) {
  const labelId = useId();
  const helpId = useId();
  const centsInput = useRef<HTMLInputElement>(null);
  const [parts, setParts] = useState(() => split(value));
  // Keep typing drafts (e.g. a single kopeck digit) while accepting external reloads.
  if (value !== parts.source) setParts(split(value));
  const update = (hryvnias: string, kopecks: string) => {
    const amount = hryvnias ? `${hryvnias}.${(kopecks || '0').padStart(2, '0')}` : '';
    setParts({ source: amount, hryvnias, kopecks });
    onChange(amount);
  };
  const paste = (event: React.ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData
      .getData('text')
      .trim()
      .replace(/[\s\u00a0\u202f]/g, '');
    const amount = /^(\d+)[,.](\d{1,2})$/.exec(text);
    if (!amount) return;
    event.preventDefault();
    update(amount[1]!, amount[2]!.padEnd(2, '0'));
  };
  return (
    <div className="tk-field tk-money" data-disabled={isDisabled || undefined}>
      <span className="tk-label" id={labelId}>
        {label}
      </span>
      <div
        className="tk-money-group"
        role="group"
        aria-labelledby={labelId}
        aria-describedby={helpId}
      >
        <TextField
          className="tk-money-part tk-money-hryvnias"
          aria-label={`${label}: гривні`}
          value={parts.hryvnias}
          onChange={(hryvnias) => update(hryvnias, parts.kopecks)}
          isRequired={isRequired}
          isDisabled={isDisabled}
          validationBehavior="native"
        >
          <div className="tk-money-entry">
            <Input
              className="tk-money-input"
              inputMode="numeric"
              pattern="[0-9]*"
              placeholder="0"
              onPaste={paste}
              onKeyDown={(event) => {
                if (event.key === ',' || event.key === '.') {
                  event.preventDefault();
                  centsInput.current?.focus();
                  centsInput.current?.select();
                }
              }}
            />
            <span className="tk-money-unit" aria-hidden="true">
              грн
            </span>
          </div>
          <FieldError className="tk-error">Введіть цілу кількість гривень.</FieldError>
        </TextField>
        <TextField
          className="tk-money-part tk-money-kopecks"
          aria-label={`${label}: копійки`}
          value={parts.kopecks}
          onChange={(kopecks) => update(parts.hryvnias, kopecks)}
          isDisabled={isDisabled}
          validationBehavior="native"
        >
          <div className="tk-money-entry">
            <Input
              ref={centsInput}
              className="tk-money-input"
              inputMode="numeric"
              pattern="[0-9]{0,2}"
              maxLength={2}
              placeholder="00"
              onPaste={paste}
              onBlur={() => {
                if (/^\d$/.test(parts.kopecks))
                  update(parts.hryvnias, parts.kopecks.padStart(2, '0'));
              }}
            />
            <span className="tk-money-unit" aria-hidden="true">
              коп.
            </span>
          </div>
          <FieldError className="tk-error">Копійки: від 0 до 99.</FieldError>
        </TextField>
      </div>
      <span className="tk-help" id={helpId}>
        Можна вставити суму повністю: 21,99. Кома переводить до копійок.
      </span>
    </div>
  );
}
