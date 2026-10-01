import { useState } from 'react';
import {
  DatePicker as AriaDatePicker,
  DateInput,
  DateSegment,
  Label,
  Group,
  Button,
  Popover,
  Dialog,
  Calendar,
  CalendarGrid,
  CalendarGridHeader,
  CalendarHeaderCell,
  CalendarGridBody,
  CalendarCell,
  Heading,
  FieldError,
} from 'react-aria-components';
import { parseDate, today } from '@internationalized/date';

export const ukraineToday = () => today('Europe/Kyiv').toString();
function dateValue(value: string) {
  try {
    return value ? parseDate(value) : null;
  } catch {
    return null;
  }
}

/** Date-only ISO boundary, with localized segments and a keyboard accessible calendar. */
export function DatePicker({
  label,
  value,
  onChange,
  maxValue,
  isDisabled = false,
}: {
  label: string;
  value: string;
  onChange: (date: string) => void;
  maxValue?: string;
  isDisabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const date = dateValue(value);
  const maximum = maxValue ? dateValue(maxValue) : null;
  const current = today('Europe/Kyiv');
  return (
    <AriaDatePicker
      className="tk-field tk-date"
      value={date}
      onChange={(next) => onChange(next?.toString() || '')}
      {...(maximum ? { maxValue: maximum } : {})}
      isDisabled={isDisabled}
      {...(value && !date ? { isInvalid: true } : {})}
      validationBehavior="native"
      isOpen={open}
      onOpenChange={setOpen}
    >
      <Label className="tk-label">{label}</Label>
      <Group className="tk-date-group">
        <DateInput className="tk-date-input">
          {(segment) => <DateSegment segment={segment} className="tk-date-segment" />}
        </DateInput>
        <Button className="tk-date-trigger" aria-label="Вибрати дату">
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
            <path d="M16 3v4M8 3v4M3 11h18M7 15h3M14 15h3" />
          </svg>
        </Button>
      </Group>
      <div className="tk-date-actions">
        <Button
          slot={null}
          className="tk-button"
          isDisabled={isDisabled || !!(maximum && current.compare(maximum) > 0)}
          onPress={() => onChange(current.toString())}
        >
          Сьогодні
        </Button>
        <Button
          slot={null}
          className="tk-button"
          isDisabled={isDisabled || !value}
          onPress={() => onChange('')}
        >
          Очистити дату
        </Button>
      </div>
      <FieldError className="tk-error">
        {({ validationDetails }) =>
          value && !date
            ? 'Некоректна збережена дата. Виберіть день у календарі.'
            : validationDetails.rangeOverflow
              ? 'Дата не може бути в майбутньому.'
              : 'Виберіть коректну дату.'
        }
      </FieldError>
      <Popover className="tk-calendar-popover" placement="bottom start" containerPadding={2}>
        <Dialog className="tk-calendar-dialog" aria-label={`Календар: ${label}`}>
          <Calendar className="tk-calendar" firstDayOfWeek="mon">
            <header>
              <Button slot="previous" className="tk-calendar-nav" aria-label="Попередній місяць">
                ‹
              </Button>
              <Heading />
              <Button slot="next" className="tk-calendar-nav" aria-label="Наступний місяць">
                ›
              </Button>
            </header>
            <CalendarGrid className="tk-calendar-grid">
              <CalendarGridHeader>
                {(day) => <CalendarHeaderCell>{day}</CalendarHeaderCell>}
              </CalendarGridHeader>
              <CalendarGridBody>
                {(day) => <CalendarCell date={day} className="tk-calendar-cell" />}
              </CalendarGridBody>
            </CalendarGrid>
          </Calendar>
          <Button
            slot={null}
            className="tk-button tk-calendar-close"
            onPress={() => setOpen(false)}
          >
            Закрити календар
          </Button>
        </Dialog>
      </Popover>
    </AriaDatePicker>
  );
}
