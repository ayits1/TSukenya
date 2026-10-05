# B24: актуальність клієнтів і всіх режимів звітів

Цей пакет додає actual subscriptions до Customers, оборотів періоду, залишків на дату, ABC і незалежних поточних боргів. Раніше ці читачі мали лише явне оновлення. Django/PostgreSQL лишаються джерелом обліку: жодних змін money/posting/FEFO/payroll rules або автоматичних бізнес-записів.

## Namespace та залежності

Additive enum у `trading-versions-v1`, чинний `/api/v1/trading/versions`. Fresh actor, чинний PortalSession, роль/магазин і READ ONLY REPEATABLE READ перевіряються до 304. HMAC opaque/user/session/role/scope/day; токен не включає приватний глобальний audit sequence. Незмінний запит читає тільки counters, не каталог/ваучери/рухи. Максимум8 ресурсів за запит збережено. Перевірений cap — ≤5 SELECT включно з middleware, тобто ≤4 доменних SELECT; BEGIN/SET/COMMIT є додатковими командами, це не SLA.

Міграція `0029_customer_report_versions` залежить від прийнятої `0028_catalog_scalar_invalidation`. Окремі frozen `customer_report_0029_{spec,sql}`; 0024 не редагується. SQL виконує selected-column projection і scalar FK/reverse store lookup, без whole Voucher.payload/related-row JSON. SQLite реєструє власну UDF через runtime wrapper; triggers співіснують із 0024/0028. PostgreSQL direct/bulk INSERT/UPDATE/DELETE і counters — одна транзакція, rollback не залишає invalidation. Install/reverse/reinstall перевірено; наступні зміни проєкції потребують нової міграції.

| Ресурс | Аудиторія | Видимі залежності |
| --- | --- | --- |
| customers_contacts | owner/manager/cashier/accountant | shared customer contact: kind/name/phone/email/notes/active |
| customers_metrics | ті самі | posted sale/return date/status/total/party/reference, old/new store |
| customers_debts | owner/manager/accountant | source obligation + settlements/allocations/due/direction/root type; без payroll |
| reports_period | owner/manager/accountant | period contributions/lines, cash movements, closed cashier shifts/current captions; salary лише aggregate total/chronology |
| reports_balances | ті самі | as-of stock/cash, source/storno chronology, debt/advance allocation, current lot/account/warehouse/product/party captions |
| reports_salary | owner/accountant | personal payroll balances і late-return bonus dependencies; manager не може обрати ресурс |
| reports_abc | owner/manager/accountant | historical posted sale/return lines amount/cost/quantity/name/unit, chronology і current product.hidden; не поточні campaign prices |

Network expense contribution змінює лише `:all`; scoped period витрати її не включають. Реальний CashEntry того документа все одно змінює видимий account-authoritative cash aggregate за магазином рахунку. Target store transfer cash/stock також отримує invalidation при зміні source reversal/date, навіть коли Voucher.store інший. CashAccount.store changes охоплюють old/new period cash-net routing.

Словник контактів/назви контрагентів/товарів спільні за чинною політикою. Їх дозволені captions мають global keys; фінансові source events — store keys. Employee captions мають reverse routes через фактичні closed CashShift і payroll Voucher/WorkShift. Чинний entity_save забороняє перенесення існуючого Employee, але historical/direct/bulk store change не руйнує зв'язок current captions із давнім магазином. Manager не отримує salary-only employee note/rate/payload/FK activity. Лічильники resource/role/store, не user/query/document IDs. Авторизована зміна того самого магазину може invalidates незмінний старий date/q slice; це не exact-membership cursor/cache.

## Actual consumers і бар'єри

- Customers зберігає page/selectedID і чинний debounce250ms для пошуку; remote refetch лише активних strict queries. Bootstrap перевірено до і після private read. `QueryClient.isFetching` дає синхронний completion barrier: rendered stale fetch flag не створює list/profile GET на кожному304.
- ReportsModel використовує committed mode/date/store/section/q/page. `null` означає підтверджені всі доступні магазини й не підміняється новішим raw store. Primary query і child CurrentDebts/ABC не remount-яться.
- CurrentDebts має незалежні committed query/page; ABC — committed date/store/threshold/class/q/page. Raw draft не застосовується polling. External child completion flushes rendered busy before coordinator ACK; скасування знімає власний busy, але не приймає late result.
- Dirty/unknown native editor, focused active control, pending input/read/action відкладають body refresh. Notice + «Перечитати» виконують лише GET; frozen UUID/body/newer invalid raw зберігаються. Реальні CREATE/PUT/Post/Apply/grants/recovery endpoints лишаються незалежними.
- Current401/403 приховує root/private dialog/P0 state перед redirect/revalidation. Issued aborted/obsolete401 відкидається до global denial. Customers guards і Reports guards перевіряють generation/signal перед adoption/denial. Leave unregister/abort/clear; немає force Trade.mount.

Setup/orders/document details лишаються explicit reads; CSV — explicit server export з чинними grants. Немає обіцянки immutable snapshot між polls/page/CSV; кожне читання має власний поточний RR.

## Цільові докази

- `tests/test_customer_report_versions.py`: PG початкові3 PASS; окремі нові dependency/transaction/migration, small posting, cross-store source/account та historical Employee tests PASS. SQLite dependency/reinstall2 та employee reverse route1 PASS. Accounting/RR/CSV формули та старі receipt proof не запускали повторно.
- Після rebase на accepted `a13c997` збережено runtime SQLite `PricingProjection` з PR126 і додано окрему registration0029. Повторено лише affected selected-dependency SQLite test PASS; matching frontend build/types, schema dry-run, diff/syntax і browser-policy280 PASS. QA copied0028 файли не включено у own commit.
- Нові Reports model tests3: primary committed/null-store/dirty+debt child, ABC committed child і abort late401. Початково null-store test FAIL, після explicit presence check PASS; інші2 PASS повторно не запускали. Чинний coordinator pure VM PASS. Types/scoped lint/build PASS.
- `tests/customer-report-freshness-ui.cjs`, тільки bundled Chromium headless і synthetic isolated SQLite. `all` partial — Customers page2/selectedID/contact/credit metrics і period+CurrentDebts draft→explicit GET PASS; зупинено на некоректному QA повторному cash_opening. `tail` — balances PASS, зупинено на QA obsolete ABC table locator. `abc` — ABC raw threshold/remote/explicit GET і 1440/320 PASS; зупинено на interception, встановленому після capture transport. Виправлено тільки fixture/locator/init hook і виконано непокритий `abort` tail до terminal PASS: old Reports401→new Customers, native unknown payment frozen UUID/raw/no autoPOST і real session401 private DOM clear before redirect. **Це не terminal all-family run.**
- Artifacts: `/tmp/tsukenya-customer-report-freshness-proof/{all,tail,abc}-partial.json`, `abort-report.json`, `quiet-report.json`, `quiet-reports-report.json`, `reports-1440.png`, `reports-320.png`. PNG переглянуто; body overflow відсутній. Failed diagnostic artifacts не є позитивним доказом.
- Quiet targeted check виявив справжній completion bug: repeated304 Customers body reads10 vs6; після QueryClient barrier — `quiet-report.json` PASS + actual Customers401 beforeunload privateclear, writes0. Аналогічний period/debt rendered busy gap виявлено quiet-reports test; після external child flush barrier — `quiet-reports-report.json` terminal PASS для period+CurrentDebts, balances і ABC; кожний settled304 не читає report/debt body.
- Small isolated PG measurement (5/10 receipt lines): 39 selected report counter keys у кожному випадку;66/126 revision increments;0.0841/0.0768s на цьому QA запуску. Це лише аудит write amplification/cardinality, не capacity/SLA; query/user dimensions не створюють нових counter keys.

### Команди

```sh
# Використовувати лише ізольовані DB/secret. PG proof: localhost61144, власна tsukenya_customer_report_freshness.
/tmp/tsukenya-review-venv/bin/python manage.py test tests.test_customer_report_versions.CustomerReportVersionsTests.test_employee_historical_caption_reverse_routes_after_transfer --noinput
npm run test --workspace frontend -- src/features/reports/reports.test.ts -t 'keeps primary page/filters'
node tests/trading-freshness.cjs
PYTHON_BIN=/tmp/tsukenya-review-venv/bin/python node tests/customer-report-freshness-ui.cjs
QA_CUSTOMER_REPORT_FROM=quiet PYTHON_BIN=/tmp/tsukenya-review-venv/bin/python node tests/customer-report-freshness-ui.cjs
QA_CUSTOMER_REPORT_FROM=quiet-reports PYTHON_BIN=/tmp/tsukenya-review-venv/bin/python node tests/customer-report-freshness-ui.cjs
```

Harness accepts all/tail/abc/abort/privacy/quiet/quiet-reports до створення temp data, прибирає inherited DB/PG/owner/settings, waits signal-aware server teardown. Root full registry має scrub `QA_CUSTOMER_REPORT_FROM`/port і зареєструвати all + quiet + quiet-reports; цієї задачі full не виконувано.

## Відкриті межі

B24 CPU/cache/cursors/tombstone/100k fanout не закрито. Нові trigger reverse route lookup можуть масштабуватися з кількістю actual historical stores; O(1) або 100k SLA не заявлено. Selected JSON dependency terms і PostgreSQL trigger work не є загальним memory cap для довільного malformed historical input. Немає production scheduler, нового session cache або durable report result. Повний B06/B24/план лишається відкритим;0.1 виключено.
