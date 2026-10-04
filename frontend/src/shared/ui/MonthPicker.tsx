import { useId, useState } from 'react';
import {
  Button,
  Dialog,
  DialogTrigger,
  ListBox,
  ListBoxItem,
  Popover,
} from 'react-aria-components';
import { today } from '@internationalized/date';

const months = [
  'Січень',
  'Лютий',
  'Березень',
  'Квітень',
  'Травень',
  'Червень',
  'Липень',
  'Серпень',
  'Вересень',
  'Жовтень',
  'Листопад',
  'Грудень',
];
export const currentMonth = () => today('Europe/Kyiv').toString().slice(0, 7);
export function monthCaption(value: string) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value);
  return match ? `${months[Number(match[2]) - 1]} ${match[1]}` : 'Вибрати місяць';
}

/** ISO month boundary. React Aria owns the popup, grid keyboard navigation and focus. */
export function MonthPicker({
  label,
  value,
  onChange,
  isDisabled = false,
}: {
  label: string;
  value: string;
  onChange: (month: string) => void;
  isDisabled?: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [year, setYear] = useState(Number((value || currentMonth()).slice(0, 4)));
  const yearText = String(year).padStart(4, '0');
  const choose = (month: string) => {
    onChange(month);
    setOpen(false);
  };
  return (
    <div className="tk-field" data-disabled={isDisabled || undefined}>
      <span className="tk-label" id={`${id}-label`}>
        {label}
      </span>
      <DialogTrigger
        isOpen={open && !isDisabled}
        onOpenChange={(next) => {
          if (next) setYear(Number((value || currentMonth()).slice(0, 4)));
          setOpen(next);
        }}
      >
        <Button
          className="tk-select-trigger tk-month-trigger"
          isDisabled={isDisabled}
          aria-labelledby={`${id}-label ${id}-value`}
        >
          <span className="tk-select-value" id={`${id}-value`}>
            {monthCaption(value)}
          </span>
          <svg
            aria-hidden="true"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
          >
            <rect x="3" y="5" width="18" height="16" rx="2" />
            <path d="M16 3v4M8 3v4M3 11h18" />
          </svg>
        </Button>
        <Popover
          className="tk-calendar-popover tk-month-popover"
          placement="bottom start"
          containerPadding={8}
        >
          <Dialog className="tk-calendar-dialog" aria-label={`Вибір місяця: ${label}`}>
            <header className="tk-month-year">
              <Button
                className="tk-calendar-nav"
                aria-label="Попередній рік"
                isDisabled={year <= 1}
                onPress={() => setYear(year - 1)}
              >
                ‹
              </Button>
              <strong aria-live="polite">{yearText}</strong>
              <Button
                className="tk-calendar-nav"
                aria-label="Наступний рік"
                isDisabled={year >= 9999}
                onPress={() => setYear(year + 1)}
              >
                ›
              </Button>
            </header>
            <ListBox
              className="tk-month-grid"
              aria-label={`Місяці ${yearText} року`}
              layout="grid"
              selectionMode="single"
              disallowEmptySelection
              autoFocus
              selectedKeys={value.startsWith(yearText + '-') ? [value.slice(5)] : []}
              onSelectionChange={(keys) => {
                const key = [...keys][0];
                if (key) choose(`${yearText}-${key}`);
              }}
            >
              {months.map((name, index) => (
                <ListBoxItem
                  key={name}
                  id={String(index + 1).padStart(2, '0')}
                  textValue={name}
                  className="tk-month-option"
                >
                  {name}
                </ListBoxItem>
              ))}
            </ListBox>
            <Button className="tk-button tk-calendar-close" onPress={() => choose(currentMonth())}>
              Цей місяць
            </Button>
          </Dialog>
        </Popover>
      </DialogTrigger>
    </div>
  );
}
