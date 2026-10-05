import { Button } from '../../shared/ui/Button';
import { TextField } from '../../shared/ui/TextField';
import { ComboBox } from '../../shared/ui/ComboBox';
import { CatalogVisibility } from './CatalogVisibility';
import { Select } from '../../shared/ui/Select';
import {
  hasEffectivePromotion,
  type FacetApi,
  type Filters,
  type Product,
  type ProductPage,
} from './api';
import { CatalogFacet } from './CatalogFacet';

const currency = (value: string | null) =>
  value === null
    ? '—'
    : Number(value).toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// An active filter stays visible even when the current facets no longer contain its value;
// otherwise the field looks empty while it still narrows the list.
const choices = (values: string[], all: string, selected: string) => [
  { id: '*', label: all },
  ...(selected && !values.includes(selected) ? [{ id: selected, label: selected }] : []),
  ...values.map((value) => ({ id: value, label: value })),
];
export function CatalogView({
  data,
  filters,
  onFilters,
  onEdit,
  onPromotion,
  busy = false,
  message = '',
  onReferences,
  showVisibility = true,
  facetApi,
}: {
  showVisibility?: boolean;
  data: ProductPage;
  filters: Filters;
  onFilters: (filters: Filters) => void;
  onEdit: (product?: Product) => void;
  onPromotion: (product: Product) => void;
  busy?: boolean;
  message?: string;
  onReferences?: () => void;
  facetApi?: FacetApi;
}) {
  const change = (patch: Partial<Filters>) => onFilters({ ...filters, ...patch, page: 1 });
  const start = (data.page - 1) * data.limit;
  return (
    <section className="tk-catalog tk-root" aria-label="Каталог товарів" aria-busy={busy}>
      <header className="tk-catalog-heading">
        <div>
          <h2>Каталог товарів</h2>
          <p>Каталог, актуальні ціни та акційні пропозиції</p>
        </div>
        {onReferences ? (
          <Button onPress={onReferences} isDisabled={busy}>
            Довідники
          </Button>
        ) : null}
        {data.canEdit ? (
          <Button variant="primary" onPress={() => onEdit()} isDisabled={busy}>
            Додати товар
          </Button>
        ) : null}
      </header>
      {showVisibility ? (
        <div className="tk-catalog-visibility">
          <CatalogVisibility filters={filters} onChange={onFilters} />
        </div>
      ) : null}
      <div className="tk-catalog-filters">
        <TextField
          label="Пошук товару"
          type="search"
          placeholder="Назва або штрихкод"
          value={filters.q}
          onChange={(q) => change({ q })}
        />
        {facetApi ? (
          <CatalogFacet
            label="Група"
            allLabel="Усі групи"
            field="type"
            filters={filters}
            value={filters.type}
            load={facetApi}
            onChange={(type) => change({ type, category: '', pack: '' })}
          />
        ) : (
          <ComboBox
            label="Група"
            options={choices(data.facets?.type || [], 'Усі групи', filters.type)}
            selectedKey={filters.type || '*'}
            onSelectionChange={(key) =>
              change({ type: key === '*' ? '' : String(key), category: '', pack: '' })
            }
          />
        )}
        {facetApi ? (
          <CatalogFacet
            label="Категорія"
            allLabel="Усі категорії"
            field="category"
            filters={filters}
            value={filters.category}
            load={facetApi}
            disabled={busy}
            onChange={(category) => change({ category, pack: '' })}
          />
        ) : (
          <ComboBox
            label="Категорія"
            isDisabled={busy}
            options={choices(data.facets?.category || [], 'Усі категорії', filters.category)}
            selectedKey={filters.category || '*'}
            onSelectionChange={(key) =>
              change({ category: key === '*' ? '' : String(key), pack: '' })
            }
          />
        )}
        {facetApi ? (
          <CatalogFacet
            label="Пакування"
            allLabel="Усе пакування"
            field="pack"
            filters={filters}
            value={filters.pack}
            load={facetApi}
            disabled={busy}
            onChange={(pack) => change({ pack })}
          />
        ) : (
          <ComboBox
            label="Пакування"
            isDisabled={busy}
            options={choices(data.facets?.pack || [], 'Усе пакування', filters.pack)}
            selectedKey={filters.pack || '*'}
            onSelectionChange={(key) => change({ pack: key === '*' ? '' : String(key) })}
          />
        )}
        <Select
          label="Акція"
          options={[
            { id: '*', label: 'Усі товари' },
            { id: 'yes', label: 'Акційні' },
            { id: 'no', label: 'Без акції' },
          ]}
          selectedKey={filters.promotion || '*'}
          onSelectionChange={(key) => change({ promotion: key === '*' ? '' : String(key) })}
        />
      </div>
      <div className="tk-catalog-summary">
        <span role="status">
          {message || (busy ? 'Оновлюємо список…' : `Знайдено товарів: ${data.total}`)}
        </span>
        <Button
          onPress={() =>
            onFilters({
              q: '',
              type: '',
              category: '',
              pack: '',
              promotion: '',
              page: 1,
              limit: filters.limit,
              visibility: filters.visibility || 'active',
            })
          }
        >
          Скинути фільтри
        </Button>
      </div>
      {data.items.length ? (
        <table className="tk-product-table">
          <caption className="tk-visually-hidden">Ціни та акції товарів</caption>
          <thead>
            <tr>
              <th scope="col">Товар</th>
              {data.items[0]?.cost !== null ? <th scope="col">Закупівля</th> : null}
              <th scope="col">Продаж</th>
              <th scope="col">Акція</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((product) => (
              <tr key={product.id}>
                <td data-label="Товар">
                  <div className="tk-product-title">
                    {data.canEdit && product.canEdit ? (
                      <button
                        type="button"
                        className="tk-product-link"
                        disabled={busy}
                        onClick={() => onEdit(product)}
                      >
                        {product.name}
                      </button>
                    ) : (
                      <strong>{product.name}</strong>
                    )}
                  </div>
                  <small>
                    {[product.type, product.category, product.pack, product.size, product.unit]
                      .filter(Boolean)
                      .join(' · ')}
                  </small>
                  <small className={Number(product.salePrice) <= 0 ? 'tk-error' : ''}>
                    {Number(product.salePrice) <= 0
                      ? 'Немає ціни'
                      : product.priceAt
                        ? `Дата ціни: ${product.priceAt}`
                        : 'Потрібно перевірити дату ціни'}
                  </small>
                </td>
                {product.cost !== null ? (
                  <td data-label="Закупівля">
                    <span className="tk-catalog-number">{currency(product.cost)} грн</span>
                    <small>Націнка {product.markup} %</small>
                  </td>
                ) : null}
                <td data-label="Продаж">
                  {hasEffectivePromotion(product) ? (
                    <>
                      <small className="tk-regular-price">
                        <span className="tk-visually-hidden">Звичайна ціна: </span>
                        <del className="tk-catalog-number">
                          {currency(product.regularPrice)} грн
                        </del>
                      </small>
                      <strong className="tk-catalog-number tk-discount-price">
                        <span className="tk-visually-hidden">Акційна ціна: </span>
                        {currency(product.salePrice)} грн
                      </strong>
                    </>
                  ) : (
                    <strong className="tk-catalog-number">
                      {Number(product.salePrice) > 0 ? `${currency(product.salePrice)} грн` : '—'}
                    </strong>
                  )}
                  <small>
                    {product.manualPrice ? 'Ручна звичайна ціна' : 'Звичайна ціна за націнкою'}
                  </small>
                  {product.promotion && !hasEffectivePromotion(product) ? (
                    <small className="tk-promotion-warning">
                      Акційна ціна не задана або вже не менша за звичайну
                    </small>
                  ) : null}
                </td>
                <td data-label="Акція">
                  {data.canEdit && product.canEdit ? (
                    // The accessible name starts with the visible text. Only an active promotion
                    // is a toggle (pressing ends it); enabling opens the editor for its price.
                    <button
                      type="button"
                      className="tk-promotion"
                      aria-label={`${product.promotion ? 'Акція' : 'Без акції'}: ${product.name}`}
                      {...(product.promotion
                        ? { 'aria-pressed': true }
                        : { 'aria-haspopup': 'dialog' as const })}
                      disabled={busy}
                      onClick={() => onPromotion(product)}
                    >
                      {product.promotion ? 'Акція' : 'Без акції'}
                    </button>
                  ) : product.promotion ? (
                    <span className="tk-promotion">Акція</span>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="tk-catalog-empty">
          <h3>
            {busy
              ? 'Завантажуємо товари…'
              : data.visibility === 'hidden'
                ? 'Прихованих товарів не знайдено'
                : 'Товарів не знайдено'}
          </h3>
          <p>
            {busy
              ? 'Список з’явиться після завершення запиту.'
              : data.canEdit
                ? data.visibility === 'hidden'
                  ? 'Змініть пошук або скиньте фільтри. Приховані товари можна відновити в редакторі.'
                  : 'Змініть пошук, скиньте фільтри або додайте товар.'
                : 'Змініть пошук або скиньте фільтри.'}
          </p>
        </div>
      )}
      <footer className="tk-catalog-pagination">
        <span>
          {data.total
            ? `${start + 1}–${Math.min(start + data.limit, data.total)} із ${data.total}`
            : '0 товарів'}
        </span>
        <Select
          label="На сторінці"
          options={[10, 20, 50].map((n) => ({ id: String(n), label: String(n) }))}
          selectedKey={String(filters.limit)}
          onSelectionChange={(key) => change({ limit: Number(key) })}
        />
        <div>
          <Button
            isDisabled={busy || data.page <= 1}
            onPress={() => onFilters({ ...filters, page: data.page - 1 })}
          >
            Назад
          </Button>
          <span>
            {data.page} / {data.pages}
          </span>
          <Button
            isDisabled={busy || data.page >= data.pages}
            onPress={() => onFilters({ ...filters, page: data.page + 1 })}
          >
            Далі
          </Button>
        </div>
      </footer>
    </section>
  );
}
