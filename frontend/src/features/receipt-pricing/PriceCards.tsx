import { Checkbox } from 'react-aria-components';
import { MoneyField } from '../../shared/ui/MoneyField';
import { TextField } from '../../shared/ui/TextField';
import { Button } from '../../shared/ui/Button';
import { Select } from '../../shared/ui/Select';
import type { Current } from './api';
import { sourceCents, type Draft, type Row } from './model';
import { useState } from 'react';
export function PriceCards({
  current,
  draft,
  onRow,
  isDisabled,
  portalContainer,
}: {
  current: Current;
  draft: Draft;
  onRow: (id: string, row: Row) => void;
  isDisabled: boolean;
  portalContainer?: Element;
}) {
  const [page, setPage] = useState(1),
    [choices, setChoices] = useState<Record<string, string>>({}),
    [notice, setNotice] = useState('');
  const ids = [
      ...new Set([...current.source.lines.map((r) => r.product), ...Object.keys(draft.rows)]),
    ],
    pages = Math.max(1, Math.ceil(ids.length / 20)),
    visible = ids.slice((Math.min(page, pages) - 1) * 20, Math.min(page, pages) * 20);
  return (
    <section aria-label="Товари накладної">
      <p className="tk-error" role="alert">
        {notice}
      </p>
      {visible.map((id) => {
        const product = current.products.find((p) => p.id === id),
          rows = current.source.lines.filter((r) => r.product === id),
          row = draft.rows[id];
        if (!product || !row)
          return (
            <article className="tk-receipt-card" key={id}>
              <h3>{rows[0]?.name || id}</h3>
              <p className="tk-error">
                Товар відсутній у каталозі. Перегляд за назвою не підміняє його ID.
              </p>
              {row?.selected ? (
                <Button
                  isDisabled={isDisabled}
                  onPress={() => onRow(id, { ...row, selected: false })}
                >
                  Виключити недоступний товар із цього перегляду
                </Button>
              ) : null}
            </article>
          );
        const update = (value: Partial<Row['values']>) =>
          onRow(id, {
            ...row,
            sourceLine: 'cost' in value ? null : row.sourceLine,
            values: { ...row.values, ...value },
          });
        return (
          <article className="tk-receipt-card" key={id} data-product={id}>
            <h3>{product.name}</h3>
            <p className="tk-help">
              Каталог: {product.unit}. Закупівля {product.cost} грн · звичайна{' '}
              {product.regularPrice} грн · чинна {product.salePrice} грн
              {product.effectivePromotion ? ' · ' + product.effectivePromotion.name : ''}.
            </p>
            {product.hidden ? (
              <p className="tk-error">Товар прихований. Спочатку відновіть його в каталозі.</p>
            ) : null}
            <Checkbox
              className="tk-checkbox"
              isSelected={row.selected}
              onChange={(selected) => onRow(id, { ...row, selected })}
              isDisabled={isDisabled || (!row.selected && (product.hidden || !product.canEdit))}
            >
              Включити «{product.name}» у перегляд
            </Checkbox>
            <details>
              <summary>Партії та суми джерела ({rows.length})</summary>
              <p>
                Ціна за історичну одиницю накладної. Перевірте відповідність одиниці каталогу;
                автоматичного перерахунку немає.
              </p>
              {rows.map((r) => (
                <p key={r.lineKey}>
                  Рядок № {r.id} · {r.name} · {r.quantity} {r.unit} × <strong>{r.price} грн</strong>{' '}
                  · сума {r.amount} грн · партія {r.lot || 'не вказана'}
                  {r.expiry ? ' · до ' + r.expiry : ''}
                  {r.landedAmount !== null
                    ? ' · складська вартість рядка ' + r.landedAmount + ' грн'
                    : ''}
                </p>
              ))}
            </details>
            {row.selected ? (
              <div className="tk-receipt-fields">
                <Select
                  {...(portalContainer ? { portalContainer } : {})}
                  label={'Джерельний рядок для ' + product.name}
                  options={rows.map((r) => ({
                    id: String(r.id),
                    label: `№ ${r.id} · ${r.price} грн / ${r.unit} · ${r.lot || 'без партії'}`,
                  }))}
                  selectedKey={choices[id] || null}
                  onSelectionChange={(key) => setChoices({ ...choices, [id]: String(key) })}
                  isDisabled={isDisabled}
                />
                <Button
                  type="button"
                  isDisabled={isDisabled || !choices[id]}
                  onPress={() => {
                    const source = rows.find((r) => String(r.id) === choices[id]);
                    if (!source) return;
                    if (source.unit !== product.unit) {
                      setNotice(
                        `Одиниця джерела «${source.unit || 'не вказана'}» відрізняється від каталогу «${product.unit}». Введіть закупівлю явно; автоматичного перерахунку немає.`,
                      );
                      return;
                    }
                    const value = sourceCents(source.price);
                    if (value === null) {
                      setNotice(
                        `Ціна ${source.price} грн має частки копійки. Введіть явну закупівлю каталогу для «${product.name}»; джерело не округлено.`,
                      );
                      return;
                    }
                    setNotice('');
                    onRow(id, {
                      ...row,
                      sourceLine: { id: source.id, lineKey: source.lineKey },
                      values: { ...row.values, cost: value },
                    });
                  }}
                >
                  Використати вибраний рядок
                </Button>
                <MoneyField
                  label={'Закупівля ' + product.name}
                  value={row.values.cost}
                  onChange={(cost) => update({ cost })}
                  isDisabled={isDisabled}
                />
                <TextField
                  label={'Націнка ' + product.name + ', %'}
                  value={row.values.markup}
                  onChange={(markup) => update({ markup })}
                  inputMode="decimal"
                  isDisabled={isDisabled}
                />
                <Checkbox
                  className="tk-checkbox"
                  isSelected={row.values.manualPrice}
                  onChange={(manualPrice) =>
                    update({ manualPrice, price: manualPrice ? product.regularPrice : null })
                  }
                  isDisabled={isDisabled}
                >
                  Ручна продажна ціна для «{product.name}»
                </Checkbox>
                {row.values.manualPrice ? (
                  <MoneyField
                    label={'Продаж ' + product.name}
                    value={row.values.price || ''}
                    onChange={(price) => update({ price })}
                    isDisabled={isDisabled}
                  />
                ) : null}
                <Checkbox
                  className="tk-checkbox"
                  isSelected={row.values.priceReviewed}
                  onChange={(priceReviewed) => update({ priceReviewed })}
                  isDisabled={isDisabled}
                >
                  Підтвердити перевірку ціни сьогодні для «{product.name}»
                </Checkbox>
                <p className="tk-help">
                  {row.sourceLine
                    ? 'Обрано рядок № ' +
                      row.sourceLine.id +
                      '. Зміна закупівлі вручну скасує це прив’язування.'
                    : 'Закупівля задається явно; складська вартість і додаткові витрати її не визначають.'}
                </p>
              </div>
            ) : null}
          </article>
        );
      })}
      <nav aria-label="Сторінки товарів накладної" className="tk-receipt-actions">
        <Button
          onPress={() => setPage((p) => Math.max(1, p - 1))}
          isDisabled={page <= 1 || isDisabled}
        >
          Попередня
        </Button>
        <span role="status">
          Сторінка {Math.min(page, pages)} з {pages}; товарів {ids.length}
        </span>
        <Button
          onPress={() => setPage((p) => Math.min(pages, p + 1))}
          isDisabled={page >= pages || isDisabled}
        >
          Далі
        </Button>
      </nav>
    </section>
  );
}
