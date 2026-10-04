import { Button } from '../../shared/ui/Button';
import type { Ref } from 'react';
import type { CustomerProfile as Profile } from './api';

export function moneyText(value: string | null) {
  if (value === null) return '—';
  const [whole, cents] = value.split('.');
  return `${BigInt(whole!).toLocaleString('uk-UA')},${cents} грн`;
}
const dateText = (value: string | null) =>
  value ? new Intl.DateTimeFormat('uk-UA', { timeZone: 'UTC' }).format(new Date(value)) : '—';
const segments = {
  none: 'Ще немає покупок',
  single: 'Один проведений чек',
  repeat: 'Повторні покупки',
};

export function CustomerProfile({
  data,
  storeName,
  onHistory,
  onEdit,
  onBack,
  historyRef,
  busy = false,
}: {
  data: Profile;
  storeName: string;
  onHistory: () => void;
  onEdit: () => void;
  onBack?: () => void;
  historyRef?: Ref<HTMLButtonElement>;
  busy?: boolean;
}) {
  const { customer, purchases, debt } = data;
  return (
    <section className="customer-profile" aria-labelledby="customer-profile-title">
      <p className="customer-eyebrow">Картка клієнта · {storeName}</p>
      <h3 id="customer-profile-title" tabIndex={-1}>
        {customer.name}
      </h3>
      <p>
        {segments[purchases.segment]}
        {customer.active ? '' : ' · Неактивний'}
      </p>
      <dl className="customer-contact">
        <div>
          <dt>Телефон</dt>
          <dd>{customer.phone || 'Не вказано'}</dd>
        </div>
        <div>
          <dt>Email</dt>
          <dd>{customer.email || 'Не вказано'}</dd>
        </div>
      </dl>
      {customer.notes ? <p className="customer-notes">{customer.notes}</p> : null}
      <dl className="customer-facts">
        <div>
          <dt>Проведених чеків</dt>
          <dd>{purchases.checks}</dd>
        </div>
        <div>
          <dt>Середній чек продажу</dt>
          <dd>{moneyText(purchases.averageCheck)}</dd>
        </div>
        <div>
          <dt>Продажі</dt>
          <dd>{moneyText(purchases.gross)}</dd>
        </div>
        <div>
          <dt>Повернення</dt>
          <dd>{moneyText(purchases.returned)}</dd>
        </div>
        <div>
          <dt>Продажі мінус повернення</dt>
          <dd>{moneyText(purchases.net)}</dd>
        </div>
        <div>
          <dt>Перша / остання покупка</dt>
          <dd>
            {dateText(purchases.first)} / {dateText(purchases.last)}
          </dd>
        </div>
        {debt ? (
          <>
            <div>
              <dt>Поточний борг · {debt.documents} док.</dt>
              <dd>{moneyText(debt.outstanding)}</dd>
            </div>
            <div>
              <dt>Прострочено · {debt.overdueDocuments} док.</dt>
              <dd>{moneyText(debt.overdue)}</dd>
            </div>
          </>
        ) : null}
      </dl>
      {debt && debt.unknownDueDocuments > 0 ? (
        <p role="status">
          У {debt.unknownDueDocuments} документах некоректний строк оплати. Вони включені в борг,
          але стан прострочення не визначено.
        </p>
      ) : null}
      <p className="tk-help">
        Поточні проведені документи за весь час до {dateText(data.scope.today)}. Скасовані документи
        виключено. Середній чек — продажі / кількість чеків; повернення показані окремо. Повністю
        повернений чек залишається фактом покупки.
      </p>
      <div className="customer-actions">
        {onBack ? <Button onPress={onBack}>До списку клієнтів</Button> : null}
        <Button ref={historyRef} isDisabled={busy} onPress={onHistory}>
          Історія документів
        </Button>
        {data.canEdit ? (
          <Button isDisabled={busy} onPress={onEdit}>
            Редагувати клієнта
          </Button>
        ) : null}
      </div>
    </section>
  );
}
