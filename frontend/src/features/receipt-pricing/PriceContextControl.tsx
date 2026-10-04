import { useState } from 'react';
import { DirectoryComboBox } from '../trading/DirectoryComboBox';
import { createTradingApi, type TradingApi } from '../trading/api';
import { Button } from '../../shared/ui/Button';
import type { Current } from './api';
export function PriceContextControl({
  current,
  isDisabled,
  onChoose,
  portalContainer,
  api: supplied,
}: {
  current: Current;
  isDisabled: boolean;
  onChoose: (store: number | null) => void;
  portalContainer?: Element;
  api?: TradingApi;
}) {
  const [api] = useState(() => supplied || createTradingApi()),
    selected =
      current.priceContext.storeId === null
        ? null
        : { id: String(current.priceContext.storeId), name: current.priceContext.storeName! };
  return (
    <div className="tk-receipt-fields">
      <DirectoryComboBox
        api={api}
        type="stores"
        query={{ purpose: 'receipt' }}
        label="Магазин для перегляду цін"
        value={selected?.id || ''}
        selected={selected}
        onCommit={(store) => {
          if (store) onChoose(Number(store.id));
        }}
        disabled={isDisabled}
        required={current.priceContext.storeId !== null}
        emptyLabel="Контекст мережі"
        {...(portalContainer ? { portalContainer } : {})}
      />
      {current.canSelectNetwork ? (
        <Button
          isDisabled={isDisabled || current.priceContext.storeId === null}
          onPress={() => onChoose(null)}
        >
          Порівняти ціни у контексті мережі
        </Button>
      ) : null}
    </div>
  );
}
