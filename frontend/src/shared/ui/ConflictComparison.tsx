import { useEffect, useId, useRef } from 'react';
import { Label, Radio, RadioGroup } from 'react-aria-components';
import { Button } from './Button';
import type { MergeChoice, MergeChoices, MergeRow } from '../merge/threeWay';
import './conflict-comparison.css';

export type ConflictComparisonProps = {
  rows: MergeRow[];
  choices: MergeChoices;
  onChoice: (id: string, choice: MergeChoice) => void;
  onApply: () => void;
  onCancel: () => void;
  isDisabled?: boolean;
  title?: string;
};
const descriptions = {
  mine: 'Лише ваші зміни — буде перенесено',
  server: 'Лише зміни сервера — буде збережено',
  same: 'Однакові зміни',
  conflict: 'Різні зміни — виберіть версію',
};

/** Inline review, usable inside an editor dialog or a workspace. It performs no requests. */
export function ConflictComparison({
  rows,
  choices,
  onChoice,
  onApply,
  onCancel,
  isDisabled = false,
  title = 'Порівняти зміни',
}: ConflictComparisonProps) {
  const id = useId(),
    heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    heading.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  const unresolved = rows.filter((row) => row.status === 'conflict' && !choices[row.id]).length;
  return (
    <section className="tk-conflict" aria-labelledby={id}>
      <h3 id={id} ref={heading} tabIndex={-1}>
        {title}
      </h3>
      <p>Перегляньте зміни. Узгодження оновить чернетку; збережіть її окремою дією.</p>
      {!rows.length ? <p>Редаговані поля не змінилися. Можна оновити версію чернетки.</p> : null}
      <div className="tk-conflict-rows">
        {rows.map((row) => (
          <article key={row.id} className="tk-conflict-row">
            <h4>{row.label}</h4>
            <p className={row.status === 'conflict' ? 'tk-error' : 'tk-help'}>
              {descriptions[row.status]}
            </p>
            <dl>
              <div>
                <dt>Було</dt>
                <dd>{row.base}</dd>
              </div>
              <div>
                <dt>Мої зміни</dt>
                <dd>{row.mine}</dd>
              </div>
              <div>
                <dt>Зараз на сервері</dt>
                <dd>{row.server}</dd>
              </div>
            </dl>
            {row.status === 'conflict' ? (
              <RadioGroup
                className="tk-conflict-choices"
                value={choices[row.id] || ''}
                onChange={(choice) => {
                  if (choice === 'mine' || choice === 'server') onChoice(row.id, choice);
                }}
                isDisabled={isDisabled}
              >
                <Label>Версія для поля «{row.label}»</Label>
                <Radio value="mine">
                  <span aria-hidden="true" className="tk-conflict-radio" />
                  Залишити мої зміни
                </Radio>
                <Radio value="server">
                  <span aria-hidden="true" className="tk-conflict-radio" />
                  Взяти зміни сервера
                </Radio>
              </RadioGroup>
            ) : null}
          </article>
        ))}
      </div>
      <p role="status">
        {unresolved ? `Потрібно узгодити: ${unresolved}.` : 'Усі зміни узгоджено.'}
      </p>
      <div className="tk-conflict-actions">
        <Button type="button" onPress={onCancel} isDisabled={isDisabled}>
          Повернутися до чернетки
        </Button>
        <Button
          type="button"
          variant="primary"
          onPress={onApply}
          isDisabled={isDisabled || unresolved > 0}
        >
          Застосувати узгоджені зміни
        </Button>
      </div>
    </section>
  );
}
