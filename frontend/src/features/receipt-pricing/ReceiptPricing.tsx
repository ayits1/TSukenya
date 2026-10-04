import { Button } from '../../shared/ui/Button';
import { TextField } from '../../shared/ui/TextField';
import { PriceContextControl } from './PriceContextControl';
import { ConflictComparison } from '../../shared/ui/ConflictComparison';
import type { ReceiptPricingApi } from './api';
import type { TradingApi } from '../trading/api';
import { PriceCards } from './PriceCards';
import { useReceiptReview } from './useReceiptReview';
import './receipt-pricing.css';
const sourceStatus = {
  draft: 'чернетка, ще не проведено',
  posted: 'проведено',
  reversed: 'скасовано',
};
export function ReceiptPricing({
  id,
  api,
  onClose,
  onOpenLabels,
  onState,
  portalContainer,
  directoryApi,
}: {
  id: number;
  api: ReceiptPricingApi;
  onClose: () => void;
  onOpenLabels: (key: string) => void;
  onState?: (dirty: boolean, busy: boolean) => void;
  portalContainer?: Element;
  directoryApi?: TradingApi;
}) {
  const state = useReceiptReview(api, id, onState),
    { current, draft, review, result } = state,
    disabled = state.busy || state.writeBusy || !!state.comparison;
  return (
    <section className="tk-root tk-receipt-review" aria-label="Перегляд цін із накладної">
      <p role="status" tabIndex={-1}>
        {state.status}
      </p>
      {state.error ? (
        <p className="tk-error" role="alert" tabIndex={-1}>
          {state.error}
        </p>
      ) : null}
      {!current ? (
        <>
          <p>Відкриття не змінює каталог. Ціни потрібно запропонувати й підтвердити окремо.</p>
          <Button onPress={() => void state.load()} isDisabled={state.busy}>
            Повторити читання джерела
          </Button>
        </>
      ) : null}
      {state.busy ? (
        <Button onPress={state.cancelRead} isDisabled={state.writeBusy}>
          Скасувати читання
        </Button>
      ) : null}
      {current && draft ? (
        <>
          <header>
            <h3>
              Накладна № {current.source.id} · {sourceStatus[current.source.status]}
            </h3>
            <p>
              {current.source.storeName} · облікова дата {current.source.date} · сума{' '}
              {current.source.total} грн · додаткові витрати {current.source.additionalCost} грн.
            </p>
            <p>
              {current.source.status === 'draft'
                ? 'Розподілу складської вартості ще немає.'
                : 'Складська вартість рядка показана окремо від ціни закупівлі.'}{' '}
              Жодного автоматичного перенесення вартості в каталог.
            </p>
            <p>
              Підтверджений контекст цін:{' '}
              <strong>{current.priceContext.storeName || 'мережа'}</strong> · день перегляду{' '}
              {current.effectiveDay}. Закупівля та звичайна ціна каталогу спільні для мережі;
              магазин визначає чинні акції.
            </p>
          </header>
          <PriceContextControl
            current={current}
            {...(directoryApi ? { api: directoryApi } : {})}
            isDisabled={disabled || state.uncertain}
            onChoose={(store) => void state.load(store)}
            {...(portalContainer ? { portalContainer } : {})}
          />
          {state.needsRead && !state.uncertain ? (
            <p className="tk-help">
              Новий запис заблоковано до читання й явного узгодження поточної версії.
            </p>
          ) : null}
          <Button
            onPress={() => void state.load(current.priceContext.storeId)}
            isDisabled={disabled || state.uncertain}
          >
            Прочитати поточні ціни та порівняти
          </Button>
          <PriceCards
            current={current}
            {...(portalContainer ? { portalContainer } : {})}
            draft={draft}
            onRow={(id, row) => state.edit({ ...draft, rows: { ...draft.rows, [id]: row } })}
            isDisabled={disabled || !current.canEdit}
          />
          <TextField
            label="Причина перегляду цін"
            value={draft.reason}
            maxLength={300}
            onChange={(reason) => state.edit({ ...draft, reason })}
            isDisabled={disabled || !current.canEdit}
          />
          {state.comparison ? (
            <>
              <p>
                Поточне джерело: {sourceStatus[state.comparison.current.source.status]} · версія{' '}
                {state.comparison.current.source.revision} · контекст{' '}
                {state.comparison.current.priceContext.storeName || 'мережа'} · день{' '}
                {state.comparison.current.effectiveDay}. Після застосування перевірте відповідність
                партій і одиниць.
              </p>
              <ConflictComparison
                rows={state.mergeRows}
                choices={state.choices}
                onChoice={(id, choice) => state.setChoices({ ...state.choices, [id]: choice })}
                onApply={state.apply}
                onCancel={state.cancelComparison}
                isDisabled={
                  (disabled && state.busy) || !state.comparison.current.canEdit || state.uncertain
                }
              />
            </>
          ) : null}
          <div className="tk-receipt-actions">
            <Button
              variant="primary"
              onPress={() => void state.preview()}
              isDisabled={disabled || state.needsRead || state.uncertain || !current.canEdit}
            >
              Переглянути зміни перед записом
            </Button>
          </div>
          {review ? (
            <section aria-label="Перевірений план">
              <h3>Перевірений план · {review.data.effectiveDay}</h3>
              {review.data.entries.map((r) => (
                <article className="tk-receipt-card" key={r.id}>
                  <h4>{current.products.find((p) => p.id === r.id)?.name || r.id}</h4>
                  {r.error ? (
                    <p className="tk-error">{r.error}</p>
                  ) : (
                    <p>
                      Звичайна ціна: {r.comparison?.before?.regularPrice} →{' '}
                      {r.comparison?.after.regularPrice} грн. Чинна продажна:{' '}
                      {r.comparison?.before?.salePrice} → {r.comparison?.after.salePrice} грн.{' '}
                      {r.comparison?.retailChanged
                        ? 'Продажна ціна зміниться.'
                        : r.comparison?.displayChanged
                          ? 'Зміниться тільки відображення старої ціни.'
                          : 'Відображувані ціни не зміняться.'}
                    </p>
                  )}
                </article>
              ))}
              <Button
                variant="primary"
                onPress={() => void state.save()}
                isDisabled={disabled || !review.data.valid || state.needsRead || state.uncertain}
              >
                Підтвердити запис перевіреного плану
              </Button>
            </section>
          ) : null}
        </>
      ) : null}
      {state.uncertain ? (
        <section aria-label="Відновлення початкового запису">
          <p>Нові поля залишаються у формі. Початковий запит не зміниться.</p>
          <div className="tk-receipt-actions">
            <Button
              onPress={() => void state.save(true)}
              isDisabled={state.busy || state.writeBusy}
            >
              Повторити початковий запис точно
            </Button>
            <Button
              onPress={() => void state.readResult()}
              isDisabled={state.busy || state.writeBusy}
            >
              Прочитати результат без запису
            </Button>
          </div>
        </section>
      ) : null}
      {result ? (
        <section aria-label="Підтверджений результат">
          <h3>Операцію підтверджено</h3>
          <p>
            Перевірених товарів записано: {result.counts.updated}. Операція {result.idempotencyKey}.
            Це історичний результат; Studio повторно перевірить актуальні ціни.
          </p>
          <Button
            variant="primary"
            onPress={() => onOpenLabels(result.idempotencyKey)}
            isDisabled={state.busy || state.writeBusy}
          >
            Вибрати змінені цінники у Studio
          </Button>
        </section>
      ) : null}
      <Button onPress={onClose} isDisabled={state.busy || state.writeBusy}>
        Повернутися до накладних
      </Button>
    </section>
  );
}
