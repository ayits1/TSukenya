# B24: обмежені рядки звітів

## Серверний контракт

Окремий `contracts/trading-reports.openapi.json`; старий `/api/erp/report` збережено для сумісності.

- `GET /api/v1/trading/reports/summary`: повні підсумки вибраного періоду/дати й counts секцій; жодних масивів результатів.
- `GET /api/v1/trading/reports/rows`: `section`, `page`, необов’язковий `q`, максимум30 items, `total/page/pages/limit`, повний summary цього самого читання. Недійсна сторінка400; сторінка за межами результату повертає останню. Пошук casefold, `%`, `_`, `\` буквальні.
- `GET /api/v1/trading/reports/export.csv`: повна секція (`q` застосовується до всіх її рядків) або summary; `section=all` у balances зберігає єдиний CSV усіх дозволених секцій. Без обмеження відкритою сторінкою.
- Спільні параметри: `mode=period|balances`, `store`, `from/to` або `as_of`. На дату включно, за Києвом; майбутні дати відхиляються.
- period секції: `products/by_store/expenses_by_category/cashiers`; balances: `stock/cash/debts/advances/payroll_debts`.
- Доступ owner/manager/accountant у чинному scope. Cashier403. Manager не одержує payroll_debts/count або late_return_bonus у JSON/CSV. Запит забороненої зарплатної секції403.
- Гроші — точні десяткові рядки; кількість3 знаки; маржа/години1 знак. Ідентифікатори/кількість рядків — integer.

Кожне читання самостійне READ ONLY REPEATABLE READ на PostgreSQL, а не збережений immutable snapshot. Summary/page/export можуть відрізнятися після нового проведення. Відповідь містить `generated_at`, `snapshot=current` та явне `snapshot_notice`; client не приписує двом читанням один знімок. Назви показані в чинному написанні.

## Обчислення та ресурси

Спільні B17 `period_sign`, `effective_entries`, `active_at`, `voucher_contributions`, `totals`; B15 `context`, `advance_balances`, `obligation`; чинні `is_late_return/return_order`. Проводки/блокади/зарплатні правила не змінені. Cashiers залишається оперативною статистикою current posted closed shifts, не історичною реконструкцією.

Проміжні агрегати/сортування в приватному тимчасовому SQLite spool: directory0700, file0600, JSON Decimal strings, жодного SQLite REAL. Decimal collation сортує точні значення; Python Decimal підсумовує. Spool не є обліковою базою, журналом або persisted snapshot. `finally` контексту/закриття stream прибирає файл і каталог. Cancel не пише в Django/PostgreSQL.

ORM читає пакети200 документів із їхніми рядками, рухи iterator200; settlement inputs пакетами200 джерел/платежів. Spool cursor видає100 рядків, page JSON≤30. Бонус пізніх повернень зберігає повну хронологію на диску та залишок фактично нарахованої бази, включаючи повернення до початку вибраного періоду. UTC ключ не плутає повторну годину переходу часу в Києві.

Це O(N) server scan і O(кількості агрегатів/повернень) тимчасового диска. Немає O(1), гарантії часу або capacity VPS. Пакет200 не обмежує кількість дочірніх рядків/settlements одного документа: fanout лишається явною межею пам’яті. `stores_for` зберігає список доступних магазинів. Кожна сторінка зараз заново обчислює звіт; durable cache/довгі RR transaction/timeout/temp-disk budget — наступні питання, не прихована обіцянка SLA. Нова модель retention/scheduler відсутня.

## Цільові докази backend

Ізольована PostgreSQL18 localhost61144, окрема test_tsukenya_bounded_reports. Дванадцять нових методів `tests.test_bounded_reports.BoundedReportsTests` пройшли цільовими хвилями, без full suite:

-65+ рядків кожної з9 секцій: всі сторінки/clamp, суми/рядки паритетні чинному report; CSV охоплює весь результат, formula guard.
- Точне сортування .98/.99 при1e14, від’ємні значення й literal wildcard search; tempfile0600.
- Cutoff, future payment, Kyiv reversal, target-store cash/stock transfer; мережеві нерозподілені витрати; явний allocation/refund/reversal.
- Пізній бонус і попередні повернення/остаточна база, owner/manager/accountant parity.
- HTTP role/store/invalid filters/no writes; fresh actor при початку stream, cancel cleanup.
-65 рухів коштів period: кількість SQL однакова для1/65; account читається select_related.65 джерел/партій без per-row SQL (менше35 SQL); реальний RR concurrent rename + READ ONLY відхилення запису.

Перший discovery також підхопив імпортовані payroll/history TestCase класи; після переходу на module imports наступні хвилі запускали лише потрібні методи. Успішні попередні сценарії не повторювалися.

Native consumer/strict decoder delivery та screenshots320/1440 будуть окремим наступним етапом; backend сам не закриває весь пакет.
