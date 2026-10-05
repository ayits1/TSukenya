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

Actual registration у `stock-entry`, `purchases-entry`, `sales-entry`, `finance-entry`, `staff-entry`: один активний coordinator у `app/trading-freshness.js`, strict namespace decoder/typed bridge `shared/api/tradingFreshness.ts`. Ресурс вибирається за поточною вкладкою, store — підтверджений committed context, не typed directory search. Видима вкладка перевіряється кожні5с та при focus; hidden/pagehide/leave переривають issued read. Реєстрація після async mount має generation/host fence: leave або новий mount не реєструють старого reader.

| Actual reader | Active keys (плюс directories/policy) | Callback / hold |
| --- | --- | --- |
| Stock | stock, stock_documents, assortment | `model.refresh`, invalid/dirty/uncertain assortment або CSV/pending/action hold |
| Purchases | purchases_documents або replenishment | `refreshCommitted`, committed page/query, selected lines/detail action/filter draft hold |
| Sales | sales_documents або sales_shifts | `refreshCommitted`, submitted query/page, raw filters/action hold |
| Finance | Окремо finance_accounts / finance_ledger / finance_documents / finance_debts / finance_advances | `refreshCommitted`, поточний ресурс, raw/action hold; account balance не є приватним salary journal counter |
| Staff | staff_employees / staff_shifts / staff_documents | existing `refreshCommitted`, committed scope/page/query; invalid/unsubmitted text/action hold |

JSON member order порівнюється семантично (sorted entries), тому server cash-shift query не вигадує dirty state. Після store-change503 немає старих rows під новим store чи fallback, що auto-submit новішого raw query. При same-context503 зберігається лише lastconfirmed query для GETretry. Background refresh не `Trade.mount` і не remount; cached directory captions invalidated та bounded selected IDs reread. Фокус на живому editor/control теж defer, щоб не красти keyboard position.

Будь-який відкритий native dialog/listbox приєднаний до hold: remote update показує public notice, не стирає raw/firstIntent. «Перечитати» робить лише перевірку/read; guard перевіряється заново, а не лишає stale disabled button після Reset. Identity role/scope/session зміна одразу deny reader, закриває приватний native dialog і запускає P0 revalidation/suspend; актуальний401 invalidates session, obsolete401 після context/reader change відкидається перед redirect.503/malformed не є grant і не стирають дозволені чернетки.

Reports/setup/customers/orders/detail **не зареєстровані** у цьому пакеті: лишаються explicit bounded current GET/refresh за чинним UI. Native editor current/identity/Apply/Save лишаються незалежними; remote polling не підтверджує авторство, не підміняє baseline й не пише бізнес-дані. `mode:manual` — доступний контракт coordinator, а не доказ enrollment Reports.

Delta cursor, tombstone retention, persisted immutable snapshot, cache/capacity completion, VPS worker/scheduler/backup0.1 не входять у цю роботу. Business ledger locks, postings, money/stock/salary формули й roles unchanged.

Migration freeze/scalar FK follow-up: `/tmp/tsukenya-trading-versions-scalar-frozen-pg.log`, лише affected reverse/reinstall/absence та direct/bulk/rollback/old-new audience2 PASS. Generated SQL/source guard забороняє whole-related-row to_jsonb/SQLite SELECT*. Незмінені PG8 формули/приватність не повторювалися.

Freeze follow-up companion не імпортує runtime catalog/spec. SQLite direct/rollback + migration freeze guard2 PASS у `/tmp/tsukenya-trading-versions-sqlite-frozen-price.log` (окремий помилково названий price loader не був доказом); правильний price parity target1 PASS `/tmp/tsukenya-trading-versions-sqlite-frozen-price-only.log`. PG результати незмінені.

## Client / actual native evidence

- `node tests/trading-freshness.cjs` PASS: strict304, malformed200, current/obsolete401403, dirty/unknown hold, hidden/context/leave, changed-token/read barrier, GET-only retry. VM без DB/network.
- `npm exec --workspace frontend -- vitest run src/shared/api/tradingFreshness.test.ts --project unit`4 PASS `/tmp/tsukenya-trading-freshness-model-final.log`: committed query after503, retained newer raw, store→503 private rows/query cleared, real server cash-query member order.
- Scoped ESLint, TypeScript і matching frontend build PASS. Це не весь regression.
- `env -i PATH="$PATH" PYTHON_BIN=/tmp/tsukenya-review-venv/bin/python QA_TRADING_FRESHNESS_FROM=<stage> node tests/trading-freshness-ui.cjs`, disposable SQLite18286, **дві actual login sessions**, bundled Chromium headless. Stages allowlist: all/readers/readers-tail/dirty/unknown/privacy. No production/Sheet.
- Initial `all` до cash-query-order finding підтвердив Stock receipt5→12 та Purchases remote header; збережено `/tmp/tsukenya-trading-freshness-proof/all-partial.json`. Це **partial**, не all-PASS. Після виправлення лише `readers-tail` Sales close/Finance9.99/Staff remote employee terminalPASS `/tmp/tsukenya-trading-freshness-proof/readers-tail-report.json`.
- `dirty` terminalPASS `dirty-report.json`: invalid assortment raw byte-for-byte, remote qty held, explicit GETretry after Reset, zero business mutations; `dirty-1440.png`/`dirty-320.png` inspected, no horizontal cut, notice button≥44px. Harness read-only POST directory details не рахує бізнес-записом.
- `unknown` terminalPASS `unknown-report.json`: real CREATE commits, ACK aborted, newer invalid amount/note untouched, original UUID уP0 storage, remote balance notice, жодного auto retry/додаткового POST.
- `privacy` terminalPASS `privacy-report.json`: private native Finance expense dialog remote hold; fresh owner→scopedcashier hides heading/body, React rows іP0 raw storage; жодного business write. Paths вище абсолютні у `/tmp/tsukenya-trading-freshness-proof/`.

Successful inputs reused: Staff private QA ancestor `f578703` має ті самі touched source файли, що accepted Staff112 `9f2adf8`. Final delivery replay лише own commits на accepted9f2, matching build; не duplicate Staff ancestry. Старі full/Story/browser families не запускалися. Current query/controller/model proofs не є100k import/post throughput, cache retention чи multi-device conflict-resolution SLA.
