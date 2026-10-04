import type { CSSProperties, ReactNode } from 'react';
import {
  buildPrintPages,
  FIELD_LABELS,
  fieldStyle,
  LABEL_FONTS,
  pageGeometry,
  tagParts,
} from './domain';
import type { LabelConfig, LabelField, LabelProduct, LabelSettings } from './domain';
import './label-print.css';

export type LabelProps = {
  product: LabelProduct;
  config: LabelConfig;
  settings: LabelSettings;
  selectedField?: LabelField;
  onSelectField?: (field: LabelField) => void;
  date?: Date;
};

/** The same physical DOM is rendered on the canvas, print sheets and PDF capture. */
export function Label({
  product,
  config,
  settings,
  selectedField,
  onSelectField,
  date,
}: LabelProps) {
  const parts = tagParts(product, config, settings, date);
  const geometry = pageGeometry(config);
  const field = (key: LabelField, className = '', after?: ReactNode) => {
    if (!parts[key]) return null;
    const style = fieldStyle(config, key);
    return (
      <div
        key={key}
        className={`tk-label-field ${className} ${onSelectField && selectedField === key ? 'tk-label-field--selected' : ''}`}
        data-field={key}
        style={{
          fontFamily: LABEL_FONTS[style.font],
          fontSize: `${style.size}pt`,
          color: style.color,
          fontWeight: style.weight,
          textAlign: style.align,
        }}
        {...(onSelectField
          ? {
              role: 'button',
              tabIndex: 0,
              'aria-label': `Налаштувати: ${FIELD_LABELS[key]}`,
              'aria-pressed': selectedField === key,
              onClick: () => onSelectField(key),
              onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelectField(key);
                }
              },
            }
          : {})}
      >
        {parts[key]}
        {after}
      </div>
    );
  };
  const physicalStyle = {
    width: `${geometry.width}mm`,
    height: `${geometry.height}mm`,
    '--tk-label-k': config.size === 'l' ? 1.65 : config.size === 'm' ? 1.25 : 1,
  } as CSSProperties;
  return (
    <div
      className={`tk-label tag ${config.size} b-${config.border}`}
      data-product={product.id || 'sample'}
      style={physicalStyle}
    >
      <div className="t-top">
        {(parts.chain || parts.store) && (
          <div className="t-hd">
            {field('chain')}
            {field('store')}
          </div>
        )}
        {field('custom', 't-cu')}
        {field('name', 'nm')}
        {field('pack', 't-pk')}
        {field('psize', 't-size')}
      </div>
      <div className="t-bottom">
        {parts.promo || parts.oldPrice ? (
          <div className="t-promotion-price">
            <div className="t-promotion-meta">
              {field('promo', 't-promo')}
              {field('oldPrice', 't-old-price')}
            </div>
            {field('price', 'pr', !config.unit && <small>грн</small>)}
          </div>
        ) : (
          field('price', 'pr', !config.unit && <small>грн</small>)
        )}
        {field('unit', 'un')}
        {field('per100', 'per100')}
        {(parts.category || parts.date) && (
          <div className="ft">
            {field('category')}
            {field('date')}
          </div>
        )}
      </div>
    </div>
  );
}

export function PrintPages({
  products,
  config,
  settings,
  date,
  pageOffset = 0,
}: {
  products: readonly LabelProduct[];
  pageOffset?: number;
  config: LabelConfig;
  settings: LabelSettings;
  date?: Date;
}) {
  const geometry = pageGeometry(config);
  return buildPrintPages(products, config).map((page, index) => (
    <div
      key={index}
      className="tk-label-print-page print-page"
      data-page={pageOffset + index + 1}
      style={{
        gridTemplateColumns: `repeat(${geometry.columns},${geometry.width}mm)`,
        gridAutoRows: `${geometry.height}mm`,
      }}
    >
      {page.map((product, copy) => (
        <Label
          key={`${product.id}-${copy}`}
          product={product}
          config={config}
          settings={settings}
          {...(date ? { date } : {})}
        />
      ))}
    </div>
  ));
}
