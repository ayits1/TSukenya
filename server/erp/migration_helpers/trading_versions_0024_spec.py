"""Frozen 0024 projection map shared by PG SQL generation and SQLite QA.

Keys are resource + role + store, never the audit sequence. Each FK store route
is evaluated for BOTH rows. A monetary aggregate audience is distinct from its
restricted document journal. No accounting calculation lives here.
"""
ROLES = ('owner', 'manager', 'cashier', 'warehouse', 'accountant')
FINANCE = ('owner', 'manager', 'accountant')
SALARY = ('owner', 'accountant')
COST = ('owner', 'manager', 'warehouse', 'accountant')
STOCK_KINDS = ('opening', 'transfer', 'writeoff', 'inventory', 'production')
PURCHASE_KINDS = ('purchase_order', 'receipt', 'supplier_return')
SALE_KINDS = ('sale', 'customer_return', 'customer_order')
FINANCE_KINDS = ('payment', 'advance_allocation', 'payment_refund', 'expense', 'cash_opening', 'debt_opening', 'cash_transfer', 'cash_difference')
RESOURCES = {
    'stock': ROLES, 'assortment': ROLES, 'stock_documents': ROLES,
    'purchases_documents': ('owner', 'manager', 'warehouse'), 'replenishment': ('owner', 'manager', 'warehouse'),
    'sales_documents': ('owner', 'manager', 'cashier'), 'sales_shifts': ('owner', 'manager', 'cashier', 'accountant'),
    'finance_accounts': FINANCE, 'finance_ledger': FINANCE, 'finance_documents': FINANCE,
    'finance_debts': FINANCE, 'finance_advances': FINANCE,
    'staff_employees': SALARY, 'staff_shifts': SALARY, 'staff_documents': SALARY,
    'directories': ROLES, 'policy': ROLES,
}
# Each route is zero or more FK hops ending in a store_id (id for Store itself).
ROUTES = {
    'own': ((), 'store_id'), 'store': ((), 'id'), 'global': ((), None),
    'warehouse': ((('warehouse_id', 'warehouse'),), 'store_id'),
    'target': ((('target_id', 'warehouse'),), 'store_id'),
    'lot': ((('lot_id', 'stocklot'), ('warehouse_id', 'warehouse')), 'store_id'),
    'account': ((('account_id', 'cashaccount'),), 'store_id'),
    'voucher': ((('voucher_id', 'voucher'),), 'store_id'),
    'source': ((('source_id', 'voucher'),), 'store_id'),
    'payment': ((('payment_id', 'voucher'),), 'store_id'),
    'settlement': ((('settlement_id', 'voucher'),), 'store_id'),
    'order': ((('order_id', 'voucher'),), 'store_id'),
    'order_line': ((('order_line_id', 'voucherline'), ('voucher_id', 'voucher')), 'store_id'),
}
RULES = []


def rule(table, resources, roles=ROLES, fields=None, routes=('own',), condition=None):
    RULES.append(dict(table=table, resources=tuple(resources.split()), roles=roles,
                      fields=fields, routes=routes, condition=condition))


HEADER = ('id', 'kind', 'status', 'date', 'store_id', 'warehouse_id', 'target_id',
          'party_id', 'employee_id', 'account_id', 'shift_id', 'reference_id', 'total', 'note', 'posted_at', 'reversed_at')
rule('voucher', 'stock_documents', ('owner','manager','warehouse'), HEADER, ('own',), 'stock_kind')
rule('voucher', 'purchases_documents replenishment', ('owner','manager','warehouse'), HEADER, condition='purchase_kind')
rule('voucher', 'sales_documents', ('owner','manager','cashier'), HEADER, condition='sale_kind')
rule('voucher', 'sales_documents', ('owner','manager'), ('cost','revision'), condition='sale_kind')
rule('voucher', 'purchases_documents', ('owner','manager','warehouse'), ('cost','revision'), condition='purchase_kind')
rule('voucher', 'stock_documents', ('owner','manager','warehouse'), ('cost','revision'), condition='stock_kind')
rule('voucher', 'finance_documents', FINANCE, ('id','kind','status','date','store_id','party_id','total','revision','payload'), condition='finance_kind')
rule('voucher', 'finance_ledger', FINANCE, ('id','kind','date','reversed_at','note','party_id'), ('voucher_accounts',), 'ledger_header')
rule('voucher', 'finance_debts', FINANCE, HEADER + ('payload',), condition='debt_kind')
rule('voucher', 'finance_advances', FINANCE, HEADER + ('payload',), condition='advance_kind')
rule('voucher', 'staff_documents staff_employees staff_shifts', SALARY, HEADER + ('payload',), condition='salary_kind')
# Source/order state also governs holds, availability and replenishment eligibility.
rule('voucher', 'stock replenishment', ROLES, ('status','date','warehouse_id'), ('own',), 'stock_or_order_kind')
rule('voucherline', 'purchases_documents replenishment', ('owner','manager','warehouse'), None, ('voucher',), 'parent_purchase')
rule('voucherline', 'sales_documents', ('owner','manager','cashier'), ('id','voucher_id','product_id','name','unit','quantity','price','amount','lot','expiry','line_key','reference_line_id'), ('voucher',), 'parent_sale')
rule('stocklot', 'stock replenishment', ROLES, ('id','warehouse_id','product_id','code','expiry','quantity'), ('warehouse',))
rule('stocklot', 'stock', COST, ('value',), ('warehouse',))
rule('assortment', 'stock assortment replenishment', ROLES, None, ('warehouse',))
rule('stockreservation', 'stock replenishment', ROLES, ('order_line_id','lot_id','expires_on','quantity','used','released'), ('lot','order_line'))

ROUTES['reservation'] = ((('reservation_id','stockreservation'),('lot_id','stocklot'),('warehouse_id','warehouse')), 'store_id')
rule('ordercontrol', 'stock', ROLES, ('order_id','closed_at'), ('order',))
rule('ordercontrol', 'replenishment', ('owner','manager','warehouse'), ('order_id','closed_at','expected_date','minimum_amount'), ('order',))
rule('cashentry', 'finance_accounts', FINANCE, ('account_id','amount'), ('account',))
rule('cashentry', 'finance_ledger', FINANCE, None, ('account',), 'ledger_entry')
rule('paymentallocation', 'finance_debts finance_advances', FINANCE, None, ('source','payment','settlement'))
rule('cashshift', 'sales_shifts', ('owner','manager','cashier','accountant'), ('id','store_id','account_id','employee_id','opened_by_id','opened_at','closed_at','opening_cash','expected_cash','counted_cash'))
rule('cashshift', 'directories', ('owner','manager','cashier','accountant'), ('store_id','account_id','closed_at'))
rule('workshift', 'staff_shifts', SALARY, None)
rule('employee', 'directories', ROLES, ('id','store_id','name','active'))
rule('employee', 'directories staff_employees staff_shifts staff_documents', SALARY, None)
rule('store', 'directories stock replenishment sales_documents purchases_documents finance_accounts finance_documents staff_employees staff_shifts staff_documents', ROLES, None, ('store',))
rule('warehouse', 'directories stock replenishment', ROLES, None)
rule('cashaccount', 'directories finance_accounts finance_ledger sales_shifts', ROLES, None)
rule('counterparty', 'directories', ROLES, None, ('global',))
rule('counterparty', 'sales_documents purchases_documents replenishment finance_debts finance_advances finance_ledger', ROLES, ('id','name'), ('global',))
rule('expensecategory', 'directories finance_documents', FINANCE, None, ('global',))
rule('ledgerlock', 'policy', ROLES, None, ('global',))
rule('setting', 'policy', ROLES, None, ('global',), 'public_setting')
rule('document', 'stock assortment replenishment directories', ROLES, None, ('global',), 'public_product')
rule('document', 'stock replenishment directories', COST, None, ('global',), 'cost_product')


rule('cashshift', 'staff_shifts', SALARY, ('id','store_id','closed_at'))
rule('document', 'directories', ROLES, None, ('global',), 'pricing_settings')

rule('user', 'sales_shifts', ('owner','manager','cashier'), ('id','username'), ('opened_shifts',))

TABLES = tuple(sorted({r['table'] for r in RULES}))
DB_TABLES = {table: ('auth_user' if table=='user' else 'erp_'+table) for table in TABLES}
