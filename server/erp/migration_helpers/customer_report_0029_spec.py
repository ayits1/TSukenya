"""Frozen 0029 audience/column map. No accounting formula or mutable import."""
FINANCE = ('owner','manager','accountant')
SALARY = ('owner','accountant')
CUSTOMERS = ('owner','manager','cashier','accountant')
RESOURCES = {'customers_contacts':CUSTOMERS,'customers_metrics':CUSTOMERS,'customers_debts':FINANCE,
             'reports_period':FINANCE,'reports_balances':FINANCE,'reports_salary':SALARY,'reports_abc':FINANCE}
ROUTES = {
 'own':((),'store_id'), 'store':((),'id'), 'global':((),None), 'network':((),None),
 'warehouse':((('warehouse_id','warehouse'),),'store_id'),
 'lot':((('lot_id','stocklot'),('warehouse_id','warehouse')),'store_id'),
 'account':((('account_id','cashaccount'),),'store_id'),
 'shift':((('cash_shift_id','cashshift'),),'store_id'),
 'voucher':((('voucher_id','voucher'),),'store_id'),
 'source':((('source_id','voucher'),),'store_id'),
 'payment':((('payment_id','voucher'),),'store_id'),
 'settlement':((('settlement_id','voucher'),),'store_id'),
}
RULES=[]
def rule(table,resources,fields,routes=('own',),condition='always'):
 RULES.append({'table':table,'resources':resources.split(),'fields':fields.split(),'routes':routes,'condition':condition})
CHRONO='id kind status date store_id posted_at reversed_at'
rule('counterparty','customers_contacts','id kind name phone email notes active',('global',),'customer')
rule('counterparty','reports_balances customers_debts','id name kind',('global',))
rule('voucher','customers_metrics',CHRONO+' total party_id reference_id',condition='customer_metric')
rule('voucher','customers_debts reports_balances',CHRONO+' total party_id reference_id due_date payload_type payments direction allocations',condition='debt')
rule('voucher','reports_period',CHRONO+' total cost expense_scope category differences difference',condition='period_store')
rule('voucher','reports_period',CHRONO+' total expense_scope category payload_type',('network',),'period_network')
rule('voucher','reports_period','id kind status store_id payload_type expense_scope',condition='period_payload')
# Private payroll metadata cannot change manager's public aggregate validator.
rule('voucher','reports_period',CHRONO+' total',condition='payroll')
rule('voucher','reports_salary',CHRONO+' total employee_id shift_id reference_id',condition='salary')
rule('voucher','reports_period reports_balances',CHRONO,('voucher_accounts',),'effective')
rule('voucher','reports_balances',CHRONO,('voucher_lots',),'effective')
rule('voucher','reports_period',CHRONO+' total employee_id shift_id reference_id',condition='sale')
rule('voucher','reports_abc',CHRONO,condition='sale')
rule('voucherline','reports_period','id voucher_id product_id name unit quantity amount cost',('voucher',),'parent_product')
rule('voucherline','reports_abc','id voucher_id product_id name unit quantity amount cost',('voucher',),'parent_sale')
rule('cashentry','reports_period reports_balances','id voucher_id account_id amount is_reversal',('account',))
rule('stockentry','reports_balances','id voucher_id lot_id quantity value is_reversal',('lot',))
rule('paymentallocation','customers_debts reports_balances','id settlement_id payment_id source_id amount',('source','payment','settlement'))
rule('stocklot','reports_balances','id warehouse_id product_id code expiry',('warehouse',))
rule('cashaccount','reports_balances','id store_id name kind')
rule('cashaccount','reports_period','id store_id')
rule('warehouse','reports_balances','id store_id name')
rule('store','reports_period reports_balances reports_abc customers_metrics customers_debts reports_salary','id name active',('store',))
rule('cashshift','reports_period','id store_id employee_id opened_by_id opened_at closed_at expected_cash counted_cash')
rule('employee','reports_period','id name',('employee_shifts',))
rule('employee','reports_salary','id store_id name',('own','employee_shifts','employee_payroll','employee_work_shifts'))
rule('workshift','reports_salary','id store_id employee_id cash_shift_id payroll_id bonus_basis basis_amount bonus_percent',('own','shift'))
rule('user','reports_period','id username',('opened_shifts',))
rule('document','reports_balances','path data_name data_unit',('global',),'product')
rule('document','reports_abc','path data_hidden',('global',),'product')
TABLES=tuple(sorted({r['table'] for r in RULES}))
DB_TABLES={t:'auth_user' if t=='user' else 'erp_'+t for t in TABLES}
PAYLOAD={'due_date','payments','direction','allocations','expense_scope','category','differences','difference'}
DATA={'data_name':'name','data_unit':'unit','data_hidden':'hidden'}
