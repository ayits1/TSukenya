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

Ізольована PostgreSQL18 localhost61144, окрема test_tsukenya_bounded_reports. Тринадцять нових методів `tests.test_bounded_reports.BoundedReportsTests` пройшли цільовими хвилями, без full suite:

-65+ рядків кожної з9 секцій: всі сторінки/clamp, суми/рядки паритетні чинному report; CSV охоплює весь результат, formula guard.
- Точне сортування .98/.99 при1e14, від’ємні значення й literal wildcard search; tempfile0600.
- Cutoff, future payment, Kyiv reversal, target-store cash/stock transfer; мережеві нерозподілені витрати; явний allocation/refund/reversal.
- Пізній бонус і попередні повернення/остаточна база, owner/manager/accountant parity.
- HTTP role/store/invalid filters/no writes; fresh actor при початку stream, cancel cleanup.
-65 рухів коштів period: кількість SQL однакова для1/65; account читається select_related.65 джерел/партій без per-row SQL (менше35 SQL); реальний RR concurrent rename + READ ONLY відхилення запису.

Перший discovery також підхопив імпортовані payroll/history TestCase класи; після переходу на module imports наступні хвилі запускали лише потрібні методи. Успішні попередні сценарії не повторювалися.

Native consumer/strict decoder та screenshots наведено нижче; старий endpoint залишається сумісним.

## Чинний native consumer

`app/erp-reports.js` замінив повне завантаження звіту у `app/erp.js`: спільні підсумки, одна секція/сторінка, пошук усієї секції, окремий streamed CSV усієї секції/залишків. Каталог/довідники не завантажуються для captions; магазин — чинний bounded DirectoryComboBox, рядок витрати має scoped `store_name`. Поточні борги й джерела показників використовують уже наявні paged читання. Збережено пояснення собівартості/кредитних продажів/управлінського результату, кількість змін із розходженням, компоненти товарного й магазинного результату, зарплатні межі.

Strict runtime decoder перевіряє contract/context/dates/counts/точну кількість items/scale/рядкові поля, забороняє full arrays і зарплатні поля для manager. Відображення великих сум — BigInt + точні копійки. Окреме читання не видається за той самий знімок, що попередня сторінка.

При503/мережевому збої можна зберегти попередній **підтверджений** звіт лише того самого mode/store з його власними датами й явним попередженням; failed draft filters лишаються. CSV/джерела вимкнені, GET retry застосовує новий підтверджений контекст.403 або malformed DTO очищає приватні результати. Busy fieldset блокує тільки фільтри дати/магазину; вкладки можуть скасувати читання. Arrow focus змінюється негайно, DOM listener AbortController прибирається при cancel/remount. Чужий q із панелі боргів не перезаписує пошук секції.

### Native та adapter докази

- `node tests/bounded-reports-contract.cjs`: strict metadata/pages/decimal/manager salary privacy, точні .99 при1e14 — PASS.
- `PYTHON_BIN=/tmp/tsukenya-review-venv/bin/python node tests/cashier-csv.cjs`: actual Django CSV writer із synthetic spool без DB; salary-hidden/visible,20.07, NULL hourly rate й formula guard — PASS.
- `PYTHON_BIN=… node tests/bounded-reports-ui.cjs`: actual native сторінки30/30/5 із65, повний CSV65 та combined balances CSV; malformed200→GET retry; keyboard mode/section;320/1440; no legacy full reads — PASS. Окремі незмінені хвилі reuse; тест початкового harness помилково рахував read-only directory/details POST як запис, виправлено whitelist.
- `QA_REPORT_FROM=tail|scope|layout|recovery|sources` — **лише цільові повтори після конкретного дефекту**, не команди full acceptance. Pending rapidArrow/samehost один handler/cancel inert — PASS; scoped manager+owner — PASS;503/date draft/busy/GET retry/403 — PASS; actual source drilldown30/heading focus/Escape — PASS. Без цього env штатний сценарій містить усі ці перевірки.
- `tests/reports-date-ui.cjs`: historical debt/date retention/CSV/keyboard store breakdown на1440/390/320 пройшли до останнього network assertion; assertion випереджав async load, замінено очікуванням confirmed summary. `QA_REPORT_DATE_TAIL=1` failed-tail PASS; попередні докази reuse.
- Адаптовано старі report consumers у payments/crm/finance/date/busy/business-audit/CSV fixtures. Їхні бізнес-сценарії залишені; весь незмінений набір повторно не запускався. Explicit period застосовує чинне B17 end≤Kyivtoday; old default `/api/erp/report` з future-range compatibility не змінено.4-place CSV unit cost залишився в template roundtrip; financial totals мають authoritative2-place контракт.

Остаточні settled screenshots (синтетичні дані):

- `/var/folders/9_/xkms65w90g57nhx8n9bhp6300000gn/T/tsukenya-bounded-reports-ui-RviHEh/period-viewport-320.png`
- `/var/folders/9_/xkms65w90g57nhx8n9bhp6300000gn/T/tsukenya-bounded-reports-ui-RviHEh/period-viewport-1440.png`
- `/var/folders/9_/xkms65w90g57nhx8n9bhp6300000gn/T/tsukenya-bounded-reports-ui-RviHEh/period-rows-320.png`
- `/var/folders/9_/xkms65w90g57nhx8n9bhp6300000gn/T/tsukenya-bounded-reports-ui-RviHEh/period-rows-1440.png`

Широкий сценарій **нового** `tests/bounded-reports-ui.cjs` до вузького busy follow-up пройшов командою `QA_REPORT_FROM=layout PYTHON_BIN=/tmp/tsukenya-review-venv/bin/python node tests/bounded-reports-ui.cjs` (session67978). На тій ревізії `layout` ще не мав окремої гілки, тому команда виконала звичайний сценарій нового тесту: сторінки65/CSV/malformed recovery/mode keyboard/320+1440/no legacy reads. Це не full suite і не повний повтор дев’яти старих сімейств. Його знімки: `/var/folders/9_/xkms65w90g57nhx8n9bhp6300000gn/T/tsukenya-bounded-reports-ui-bah55L/{balances,period}-{320,1440}.png`. Нині `QA_REPORT_FROM=layout` означає лише цільову перевірку верстки. Тимчасова тека browser містить synthetic SQLite/server.log для діагностики; бізнесових даних немає. Deployment/physical accessibility screen reader/capacity stress не перевірялися.

### Follow-up: завершення сеансу

`request()` позначає401 як завершення сеансу; `load()` після перевірки live/token очищає confirmed/report/debt controls і переходить на `/`, як чинний ERP adapter.401 не використовує503 fallback. Скасований або вже замінений запит не викликає redirect.

`QA_REPORT_FROM=expiry PYTHON_BIN=/tmp/tsukenya-review-venv/bin/python node tests/bounded-reports-ui.cjs` — PASS, session19876, лише affected expiry сценарії:

- Transport навмисно ігнорує AbortSignal; після cancel і переходу до overview запізніла401 не перенаправляє сторінку.
- У disposable SQLite реальний PortalSession.expires змінено на минуле; Django summary справді повертає401. Synchronous beforeunload capture підтверджує порожні summary/debts і відсутні export/source actions **до** навігації; після неї показано реальний login.
- Незалежний metadata poll на час другого сценарію відповідає раніше отриманим synthetic DTO, щоб довести саме report adapter redirect. Це не підміна401 report endpoint.

Штатний new native сценарій містить expiry proof наприкінці; `QA_REPORT_FROM=expiry` — цільовий повтор. Попередні broad native/backend перевірки не повторювалися; під час налаштування harness виправлено двозначний overview `.stats` locator і замінено читання з уже знищеного навігацією DOM на beforeunload capture.

## Незалежне інтеграційне рев’ю

Пакет інтегровано поверх прийнятого #61 (`b49212a`), із збереженням entity/workshift editors і route loaders.
Root isolated PostgreSQL3 PASS (2.438 s) для HTTP/scope/no-write, N+1 cash1vs65 та actual READ ONLY/RR concurrent rename; незмінені backend inputs після caption/native patch повторно не запускалися.
Root `node tests/bounded-reports-contract.cjs` і `PYTHON_BIN=/tmp/tsukenya-review-venv/bin/python node tests/cashier-csv.cjs`: PASS.
Root actual native `QA_REPORT_FROM=recovery` PASS (503 підтверджений старий контекст/новий draft/busy/GET retry/403).
Нове рев’ю виявило401 retention замість завершення сеансу; після виправлення окремий root `QA_REPORT_FROM=expiry` PASS:
actual expired PostgreSQL-independent SQLite PortalSession очищає приватні summary/debts/export/source перед login, late401 після cancel/navigation не перенаправляє.
Обидві команди використовують той самий native harness та Python runtime на synthetic disposable даних.
Final settled1440/320 PNG переглянуті. Це не повтор дев’яти старих browser families; їхні дати/суми/privacy/keyboard assertions адаптовано зі збереженням змісту.
Unrelated entity400 validation gate збережено; тимчасовий503 замість400 у fixture прибрано.

CI реєструє dependency-free report decoder та synthetic authoritative cashier CSV; full runner — один default bounded reports harness і ці дві pure перевірки,
зі scrub partial flags QA_REPORT_FROM/QA_REPORT_DATE_TAIL/output. `test:full -- --plan` тільки dry-run. Full regression/deployment не запускалися.
Optional native directory filters поки втрачають видимий підпис empty option; окремий shared-control follow-up розпочато,
без приписування порожнього значення вибраному record ID або тексту пошуку.
