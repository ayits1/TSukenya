# B24 · актуальні права й snapshot у списках змін

База пакета: accepted `a13c99753042f7975129940fa8612699449bd6bd`.

## Виявлена межа

Чинні native controls досі читають `GET /api/erp/shifts` та
`GET /api/erp/work-shifts`: вибір конкретної каси для табеля, вибір
WorkShift IDs для payroll і підказка про відсотки інших працівників.
React Staff/Sales мають власні versioned readers, але це не замінює
зазначених викликів у реальних редакторах.

До зміни `shift_browsing.cash_shifts/work_shifts` використовували user/profile,
отримані middleware раніше, і виконували count та page SELECT без єдиного
snapshot. Якщо права змінилися між middleware й reader, cached owner міг
отримати вже недоступний табель або касові дані. Паралельна зміна набору
рядків могла також розвести total/pages та фактичну сторінку.

## Реалізація

Обидві public read functions відкривають shared strict `read_snapshot()`:
на PostgreSQL це READ ONLY REPEATABLE READ. Першим читанням всередині є
`current_actor`; роль, активність, наявність profile і поточний магазин
перевіряються перед зарплатними/касовими запитами. Count, clamp сторінки,
вибірка30 та повне формування legacy DTO відбуваються у тому самому snapshot.

Збережені API routes, фільтри, selected ID lookup, day interval для каси
через північ, порядок рядків, повні counts, DTO, HMAC revision, salary roles
owner/accountant і чинний cashier cash DTO. Публічні serializers
`cash_shift_json/work_shift_json`, POST, payroll/bonus формули, receipts,
історичні записи та міграції не змінюються. Це пакет read boundary, а не
нова реалізація вже прийнятого B04 multi-shift.

Запит бачить права й дані станом на початок свого snapshot; зміна ролі після
цього моменту застосовується наступним запитом. Немає блокувань ledger чи
`SELECT FOR UPDATE`, DML або послаблення strict snapshot для вкладених
read-write транзакцій.

## Цільові докази · 05.10.2026

Новий `tests/test_shift_read_freshness.py`:

1. Cached middleware actor → cashier/manager для табеля, warehouse для кас;
   деактивація або видалення profile. Actual HTTP handler повертає403 до
   запиту приватних таблиць; no-DML/no-lock.
2. Current accountant store scope для exact IDs, selected payroll IDs,
   percent hint і foreign cash; unchanged salary DTO. Cashier cash DTO
   дозволений і не читає salary SQL/поля.
3. PostgreSQL: окремий writer додає31-й рядок та відкликає права між count
   і page SELECT. Для **обох** readers поточний результат лишається
   count30/page1/30rows, без нового рядка; наступний запит403. Після явного
   повернення прав новий snapshot бачить31. Перевірено actual isolation,
   read-only setting, його порядок до actor SELECT і no-DML/no-lock.
4. PostgreSQL: виклик з mutable/read-committed transaction відхиляється;
   strict boundary не обходиться.

До production fix два нові SQLite тести дали10 subtest failures:
старі права повертали200 замість403, foreign salary рядок потрапляв у
selected IDs. Лог: `/tmp/tsukenya-shift-fresh-red.log`.

Після fix виконано тільки нові4 та такі5 чинних affected cases:

- `ShiftBrowsingTests.test_work_paging_old_exact_and_selected_ids_preserves_dto`;
- `ShiftBrowsingTests.test_local_kyiv_dates_and_midnight_day_containment`;
- `MultipleDailyWorkShiftTests.test_two_same_day_tills_keep_independent_units_rates_percent_and_payroll`;
- `DirectoryAndTimesheetRevisionTests.test_stale_timesheet_form_gets_409`;
- `PayrollRuleTests.test_timesheet_hint_lists_other_employees_percent_rows_for_owner_and_accountant_only`.

SQLite: **7 PASS +2 PostgreSQL-only skips**,0.276s;
`/tmp/tsukenya-shift-fresh-sqlite.log`.
PostgreSQL18: **9 PASS, жодного skip**,2.597s;
`/tmp/tsukenya-shift-fresh-pg.log`.

Для strict GET транзакцій чотири existing fixture classes переведені з
TestCase на TransactionTestCase/чинний TransactionApiFixture. Всі їхні
бізнесові assertions збережені; обхід production isolation не додавався.
Payroll fixture використовує чинне очищення derived-index tombstones після
flush, аналогічне іншим transaction fixtures.

PG перевірка використовувала лише підтверджений локальний
`tsukenya-review-pg18-local`,127.0.0.1:61144. Власні `shift_fresh_qa_a13c`,
`test_shift_fresh_qa_a13c` і QA роль видалені після terminal success.
Успадковані змінні production підключення відсутні; контейнер не змінювався.

## Межі

Не запускалися повні payroll/shift suites, повна регресія, браузери,
Storybook, frontend build, production або release. UI/DTO не змінено.
Цей пакет не заявляє full B24 capacity, bounded scalar lengths у старих
DTO, міграцію native controls на React чи current versioned workspace SLA.
Незмінні B04/B05 бізнесові й browser докази залишаються попередніми;
перелічені5 affected сценаріїв перевірені заново.
