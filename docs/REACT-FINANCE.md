# React: фінансовий workspace

## Фактична межа

`#trade/finance` використовує інтегрований React/TypeScript workspace з п’ятьма
вкладками: **Рахунки, Борги, Аванси, Рух коштів, Документи**. Це перенесення
всього чинного фінансового екрана; решта native редакторів і торговельних
маршрутів не оголошуються перенесеними.

| Вкладка | Збережені можливості |
| --- | --- |
| Рахунки | Пошук, магазин, 30 записів на сторінці, точний залишок; native створення/редагування лише власнику |
| Борги | Пошук, магазин, контрагент, дата документа, строк оплати, прострочення, reset; повні суми «нам/ми винні»; native оплата обраного актуального боргу |
| Аванси | Пошук, магазин, контрагент, сторінки, повні customer/supplier суми; native використання/повернення авансу й обмежена управлінська звірка |
| Рух коштів | Пошук номера/примітки/рахунку/контрагента, рахунок, магазин, дати, сторінки; signed money, Kyiv дата сторно; native відкриття документа |
| Документи | Магазин, стан, сторінки; усі вісім фінансових видів, сім дозволених create дій; detail/edit/post/reverse/delete у чинному редакторі. Касове розходження — лише читання |

Toolbar зберігає «Оновити» й launcher локальних чернеток. Filters мають явну
дію «Знайти»; вибір магазину/контрагента/рахунку одразу виконує нове читання.
Чернетки фільтрів кожної вкладки й номер сторінки зберігаються при native
збереженні/повторному draw того самого контексту. Зміна магазину скидає залежні
фільтри. Читання іншого контексту очищує попередні результати до відповіді;
503/protocol не залишає старі суми під новими фільтрами.

`TradeFinance` зберігається для **native звітів боргів, drilldown і setup audit**.
`TradePayments.form`, `voucherForm`, `entityForm`, posting/payroll/записи та їхні
B06 raw/receipt/unknown-ACK правила лишаються чинними native consumers.

## Сервер і контракт

`contracts/trading-finance.openapi.json` та generated `finance.generated.ts`:
п’ять GET `/api/v1/trading/finance/{accounts,debts,advances,ledger,documents}`.
Параметри whitelist, повторені/невідомі поля, дати, діапазони та enum перевіряє
Django. Кожна відповідь має query echo, policy, items/total/page/pages/limit=30;
debts/advances — повні filtered totals.

Fresh `current_actor` читається **в READ ONLY REPEATABLE READ**. Кожен запит
застосовує чинні owner/manager/accountant та store-scope правила. Manager не
отримує payroll ledger, network-expense journal та account write revision.
Owner-only управління рахунками зберігає HMAC **revision:string|null**.
Історичний expense без expense_scope відповідає pure default `store`; scalar
Coalesce не відсікає його через SQL NULL. Нової політики витрат немає.

Accounts використовують чинний bounded directory reader. Борги й аванси
викликають `settlement_reads` з тими самими чистими money oracle, JSON-child
cursors і disk spool. Фінансові формули не перенесені в презентаційний код.
Ledger/document journal читають SQL count + лише 30 scalar headers; не
створюють Voucher/PaymentAllocation models і не вибирають whole payload.
Примітка ledger має явну межу **4000 символів**; довша історія відхиляється,
не обрізається. Дата сторно обчислюється за Europe/Kyiv.

Runtime decoder перевіряє exact shape, page/count/unique IDs, query echo,
role/store, доступні види, resource-required поля, precise decimal strings,
revision та канонічні дати. Невалідний 200 — protocol refusal. React суми
форматує як **рядки**, без Number/суми/округлення; `.98/.99` великих сум
зберігаються. Date-only і DirectoryComboBox використовують чинні shared React
Aria controls; нової реалізації picker немає.

## Privacy й native дії

Abort + generation/lifetime fences перевіряються **до** обробки старого
401/403. Поточна відмова або fresh policy mismatch прибирає таблиці, суми,
selected captions, фільтри та write actions. Read retry виконує лише GET.
Native document detail має optional response-live guard до401/decode/після
hydrate; прострочений callback не відкриває modal і не завершує новий сеанс.
Поточний detail403 доходить до Finance deny, nonauth detail failure залишає
чинний GET-only feedback. Add/Edit account перечитує bootstrap та manage detail
перед відкриттям. Debt pay повторно читає актуальну eligible reference; advance
дія перечитує поточний posted payment/unallocated. Звірка має guarded GET,
і при поточному401/403 закриває modal та очищує React приватний DOM.

Блокування busy/dirty native modal та окремий Save/POST не змінені. React
workspace сам не створює фінансових записів та не проводить документів.

## Цільові докази

Власна source base `8fcf7b3`; settlement dependency — лише окремі delivery
`8e527db` + `e7d0b8b` (на момент own proof інтеграція PR108 ще pending). Matching own Vite build використаний actual harness.
Жодного запиту до production DB/Sheet/VPS, push/deploy чи full regression.

| Перевірка | Результат / межа |
| --- | --- |
| `tests.test_finance_reads` | PG5 PASS; SQLite4 PASS +1 PG-only skip: старі obligation/advance oracle, whole totals/65, scalar ledger/page30/Kyiv, дуже великі копійки на PG, roles/scope/currentactor, READ ONLY RR interleaving count/items |
| `finance.test.ts` | Unit6 PASS: exact decimals, malformed DTO/query/count/privacy, late401/read+callback, current403, 503 empty/refetch, codes/protocol |
| `Finance.stories.tsx` | Whole Workspace keyboard/page focus/all5tabs/axe + Read Failure + Paging Retry PASS; stable TabPanel identity, без invalid aria-controls; після paging503 focus на явний GET Retry |
| Actual primary | `/tmp/tsukenya-finance-proof-final/all-partial.json`: 30/full count/search, усі5tabs, full totals, касове розходження безcreate,1440/320. Це збережений partial успіх до наступного callback fixture failure |
| Native callbacks | `/tmp/tsukenya-finance-proof-callbacks/callbacks-partial.json`: account Add/Edit, debt payment, advance Allocate/Refund, bounded statement. Partial успіх до помилкової synthetic expense без обов’язкового account |
| Native expense tail | `/tmp/tsukenya-finance-proof-document/document-report.json` PASS: actual Save + journal503 + GET-only retry, одна write, вкладка/запит збережені |
| Role privacy | `/tmp/tsukenya-finance-proof-privacy/privacy-report.json` PASS: policy transition owner→scopedmanager, pinned store/owner actions removed, current cashier403 private purge |
| Native detail privacy | `/tmp/tsukenya-finance-proof-detail/detail-report.json` PASS: revoked owner Add-account preflight, actual current detail403 приватний DOM прибраний |
| Late callback | `/tmp/tsukenya-finance-proof-late/late-report.json` PASS: transport ігнорує abort, старий detail401 після route leave не завершує новий сеанс/не відкриває modal |
| Реальні рядки/дії | `/tmp/tsukenya-finance-layout-final/layout-report.json` PASS: усі5tabs1440/320, bounds кожної action і mobile table/tr/td усередині region; PNG переглянуті |
| Ledger note bound | Affected PG1 + SQLite1 PASS: історична примітка250000 символів отримує SQL CASE→NULL/refusal до передачі тексту до Python, без whole Voucher payload |

Перші failed attempts збережені: Storybook external symlink setup/однакові
fixture суми, dynamic TabPanel aria identity; native harness old payment form
locator, synthetic expense account/total; вони не є успіхом. Виправлення
перевіряли лише affected stage. Перший row screenshot виявив inherited global
`table{min-width:640px}`: document.scrollWidth сам цього не доводив.
Own CSS reset + actual region/action bounds перевірено final layout stage;
попередні `/tmp/tsukenya-finance-proof-rows` та `finance-layout-probe` не є
доказом відсутності clipping. Типи/build/scoped lint/syntax проходять;
`full-check` лише реєструє новий harness та прибирає його stage/port/output env.
Старі native finance harness consumers потребують окремої matching tab адаптації;
reports/audit consumer не вилучено.

## Чесні залишкові межі

Сторінка JSON/RAM обмежена30; ledger notes — максимум30×4000 символів.
Надмірні ledger notes відхиляються scalar SQL CASE без передачі їхнього
повного тексту. Totals і SQL counts потребують O(N) часу. Settlement disk spool/header/child
межі та O(N) disk/time збережені з B24, persistent cache не додано. Список
caption stores обмежений ID поточної сторінки. Aggregate precision SQLite не
доводить PostgreSQL extreme Decimal; великі копійки підтверджені PG та runtime
string display unit/story. Це не capacity benchmark, не screen-reader або
cross-browser доказ. Фізичний CSV/друк не заявляється: фінансовий екран не мав
CSV дії. Native editors, staff/reports/setup та повна CRM React міграція
залишаються окремими пакетами.
