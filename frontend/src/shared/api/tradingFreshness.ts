import type { components } from './tradingFreshness.generated';
/** Separate namespace; catalogue/portal metadata decoders never accept this DTO. */
export const tradingResources = [
  'stock',
  'assortment',
  'stock_documents',
  'purchases_documents',
  'replenishment',
  'sales_documents',
  'sales_shifts',
  'finance_accounts',
  'finance_ledger',
  'finance_documents',
  'finance_debts',
  'finance_advances',
  'staff_employees',
  'staff_shifts',
  'staff_documents',
  'directories',
  'policy',
  'customers_contacts',
  'customers_metrics',
  'customers_debts',
  'reports_period',
  'reports_balances',
  'reports_salary',
  'reports_abc',
] as const;
export type TradingResource = components['schemas']['TradingResource'];
export type TradingRole = components['schemas']['TradingRole'];
export type FreshnessRegistration = {
  name: string;
  host: HTMLElement;
  identity: { role: TradingRole; scopeStore: number | null };
  context: () => { store: number | null; resources: TradingResource[] };
  readStamp: () => number;
  blocked: () => boolean;
  refresh: (signal: AbortSignal) => Promise<boolean>;
  revalidate?: (signal: AbortSignal) => Promise<void>;
  deny: () => void;
  mode?: 'manual';
};
declare global {
  interface Window {
    TradingFreshness?: { register: (registration: FreshnessRegistration) => () => void };
  }
}
/** Native modal dirty/unknown state joins the reader's own action/draft hold. */
declare global {
  interface Window {
    Trade?: { freshnessBlocked?: () => boolean; freshnessDeny?: () => void };
  }
}
export function registerTradingReader(input: FreshnessRegistration): () => void {
  return (
    window.TradingFreshness?.register({
      ...input,
      refresh: async (signal) => {
        window.TradeDirectories?.invalidate();
        return input.refresh(signal);
      },
      blocked: () =>
        Boolean(window.Trade?.freshnessBlocked?.()) ||
        input.blocked() ||
        Boolean(
          document.activeElement &&
          input.host.contains(document.activeElement) &&
          document.activeElement.matches('input,textarea,select,button,a,[role=combobox]'),
        ),
    }) ?? (() => {})
  );
}
