# B24: версії торгових читань

## Межа

Окремий `/api/v1/trading/versions?resources=stock,directories&store=1`, контракт `trading-versions-v1` у `contracts/trading-freshness.openapi.json`. До 8 ресурсів; `store` не розширює `Profile.store`. Server робить fresh `current_actor` + перевірку поточного PortalSession **всередині READ ONLY REPEATABLE READ**. GET не записує нічого; 304 вибирає скалярні counters, не завантажує каталогу/рухів. HMAC прив’язаний до користувача, session/CSRF, ролі, scope/selected store і Київської дати; відповіді не містять credential або permission grant. ETag має окремий namespace, weak/gzip/br/zstd spelling приймається лише з тим самим base.

Міграція `0024_trading_versions` → реальна `0023_operation_price_results`. Transactional AFTER triggers охоплюють INSERT/UPDATE/DELETE, ORM bulk та direct SQL; rollback відкочує counter разом із source. Keys: `resource:role:store:ID`, network `all`, тільки справді спільні поля `global`. Немає per-user/per-query keys або audit/global money sequence. `migration_helpers/trading_versions_0024_spec.py` та `trading_versions_0024_sql.py` — заморожена PG/SQLite selection map і генератор саме0024. Runtime wrappers посилаються на чинну версію; будь-яка наступна зміна projection/schema потребує нового versioned helper і нової міграції, а не редагування0024. SQLite oracle використовує заморожені Decimal `regular_price`/`sale_price` у companion `trading_versions_0024_price.py`, скопійовані з чинного catalog без зміни semantics лише для порівняння публічного validator, не posting. FK chain читає тільки наступний FK/final scope column; не матеріалізує Voucher.payload або `SELECT *`. Відсутній register row явно має revision0 у підписі. Reverse видаляє лише власні triggers/functions/model, forward перевстановлює їх без зміни бухгалтерських source rows.

## Field / audience map

| Source | Ресурси / selection |
| --- | --- |
| Voucher + VoucherLine | Дозволені види stock/purchase/sale/finance/staff journal; role whitelist. Cashier не отримує інвалідацію від cost/revision-only. Salary journal лише owner/accountant. Manager network-expense document journal виключено. Header/line children не додають нових read/mutation прав |
| StockLot | Публічні quantity/code/expiry/product/warehouse → stock/replenishment відповідного warehouse.store; value тільки cost roles |
| Assortment | stock/assortment/replenishment warehouse.store; старий і новий warehouse |
| StockReservation / OrderControl / posted orders | Поточні reserve/availability/eligibility поля; обидві сторони FK scope. Немає origin-line-only ReservationUse або draft foreign transfer activity в cashier token |
| CashEntry | Accounts: лише account/amount і account.store. Ledger: доступні row поля, manager salary виключено. Зміни Voucher note/date/reversed_at для ledger адресуються **всіма фактичними CashEntry.account.store**, включно цільовим рахунком іншого магазину |
| PaymentAllocation + settlement/source/payment headers | Debt/advance ресурси, source/payment/settlement store. Чинні settlement/obligation формули не змінені |
| CashShift | Публічні shift DTO поля → sales_shifts; відкритість рахунку → directories; closed eligibility → staff_shifts. Приватна note не є полем sales shift DTO |
| User.username | sales_shifts за store фактичних CashShift.opened_by; password/auth/profile не є money/domain counter — перевіряються fresh identity/session |
| Employee / WorkShift | Спільні name/store/active → directories; ставки/зарплата/work shifts лише owner/accountant. Salary voucher впливає на salary aggregate, не manager personal journal |
| Store/Warehouse/CashAccount/Counterparty/ExpenseCategory | Реальні directory поля та captions відповідних читань; store audience старий і новий, shared counterparties/categories — global. Balance не береться із metadata CashAccount: він змінюється через CashEntry |
| Product Document / pricing settings | Публічні name/unit/barcode/hidden/minStock + фактично regular/sale price; cost тільки cost roles; defaultMarkup/rounding. Cashier cost change, що не змінює округлену ціну, не bump. PG Decimal projection лише порівнює validator, не замінює authoritative price/posting helpers; SQLite користується чинними helpers; oracle parity test |
| Campaign | Завжди durable per-campaign register з прийнятої 0015, але validator вибирає лише current Kyiv-day active/nonarchived campaigns свого store/network. Future/foreign IDs невидимі, current IDs включають explicit0; commit-safe зміна membership/price не залежить від trigger transaction-start date. Модель має дати, не внутрішньодобові timestamps |
| LedgerLock + public fiscal/discount Settings | policy ресурс; salary/detail за чинною роллю; приватні settings/audit/receipts не використані |

## Цільові серверні докази

Ізольована PostgreSQL18 `localhost:61144`, DB `tsukenya_trading_versions`, без production/Sheet. `tests/test_trading_versions.py`: cheap304/no-DML/no product/voucher/lot/cashentry scans на500SKU; direct/bulk/noop/rollback/old+new store; cashier salary/cost/public-rounded-price, manager account vs salary ledger/documents; fresh actor/session/selected store; real concurrent READ ONLY RR snapshot; target-account reversal + foreign/future campaign; migration reverse/reinstall/absence; regular/sale price oracle.

`/tmp/tsukenya-trading-versions-final-pg.log`: 7 scenarios PASS, новий campaign fixture спочатку мав string-date помилку. Тільки цей fixture виправлено й повторено: `/tmp/tsukenya-trading-versions-campaign-pg.log` PASS. Після username trigger фінальна приватність+amplification2 PASS у `/tmp/tsukenya-trading-versions-final-user-pg.log` (третій loader-name був помилковий, не proof); окремий правильний migration target `/tmp/tsukenya-trading-versions-final-migration-pg.log` PASS. SQLite приватність+reverse/reinstall2 PASS `/tmp/tsukenya-trading-versions-final-sqlite.log`.

Unchanged path: **4 domain SELECT**, HTTP middleware додає1; CaptureQueriesContext total8 SQL включає transaction controls. Це скалярний query proof, не latency/capacity SLA. Actual save+post receipt5/10 різних lines:28 змінених keys,334/614 сумарних counter increments; ~0.089/~0.1141с у конкретному ізольованому запуску. Dedup в межах одного source trigger; операція з багатьма rows має write amplification. Немає100k benchmark чи production load claim. Ролі/store/resource key cardinality, не per-user/query.

## Consumer integration

Поки consumer layer і його докази завершуються; сам endpoint не доводить, що всі actual readers оновлюються. Потрібні active registration stock/purchases/sales/finance/staff, committed query/page, dirty/unknown-modal hold, current identity immediate hide, strict protocol/old401/304 barrier. Reports/setup/customers/orders/detail мають окрему explicit-read policy; до відповідної actual реєстрації вони не названі automatically live.

Delta cursor, tombstone retention, persisted immutable snapshot, cache/capacity completion, VPS worker/scheduler/backup0.1 не входять у цю роботу. Business ledger locks, postings, money/stock/salary формули й roles unchanged.

Migration freeze/scalar FK follow-up: `/tmp/tsukenya-trading-versions-scalar-frozen-pg.log`, лише affected reverse/reinstall/absence та direct/bulk/rollback/old-new audience2 PASS. Generated SQL/source guard забороняє whole-related-row to_jsonb/SQLite SELECT*. Незмінені PG8 формули/приватність не повторювалися.

Freeze follow-up companion не імпортує runtime catalog/spec. SQLite direct/rollback + migration freeze guard2 PASS у `/tmp/tsukenya-trading-versions-sqlite-frozen-price.log` (окремий помилково названий price loader не був доказом); правильний price parity target1 PASS `/tmp/tsukenya-trading-versions-sqlite-frozen-price-only.log`. PG результати незмінені.
