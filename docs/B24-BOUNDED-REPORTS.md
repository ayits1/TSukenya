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

Спільні B17 `period_sign`, `effective_entries`, `active_at`, `voucher_contributions`, `totals`; report-only потокові адаптери B15 obligation/advance з паритетом незмінених `context`, `advance_balances`, `obligation`; чинні `is_late_return/return_order`. Проводки/блокади/зарплатні правила не змінені. Cashiers залишається оперативною статистикою current posted closed shifts, не історичною реконструкцією.

Проміжні агрегати/сортування в приватному тимчасовому SQLite spool: directory0700, file0600, JSON Decimal strings, жодного SQLite REAL. Decimal collation сортує точні значення; Python Decimal підсумовує. Spool не є обліковою базою, журналом або persisted snapshot. `finally` контексту/закриття stream прибирає файл і каталог. Cancel не пише в Django/PostgreSQL.

ORM читає пакети200 вузьких заголовків; рядки документів, рухи та settlement children мають окремі iterator200 без prefetch/result cache. Settlement accumulators обмежені поточними200 source/payment IDs. JSON differences/payments розгортає база, до Python надходять лише вибрані scalar поля курсором200, без завантаження цілого payload. Stock captions читаються окремо від product.data/recipe. WorkShift terms для late bonus зберігаються на приватному spool, а не в необмеженому списку працівників зміни. Spool cursor видає100 рядків, page JSON≤30. Бонус пізніх повернень зберігає повну хронологію на диску та залишок фактично нарахованої бази, включаючи повернення до початку вибраного періоду. UTC ключ не плутає повторну годину переходу часу в Києві.

Це O(N) source scans і тимчасовий диск для агрегатів/повернень/worker terms; late bonus обходить відповідних працівників для кожного повернення, його час може бути O(returns×workers). Немає O(1), гарантії часу або capacity VPS. Довільний child fanout одного документа більше не створює повного Python списку чи декодованого payload у новому report path. Межа стосується числа матеріалізованих records, а не байтів одного довільного scalar/caption. SQL engine може detoast/parse цілий збережений JSON і сортувати проміжні рядки на сервері; DB memory/work_mem/temp budget тут не доведено. `stores_for` зберігає список доступних магазинів. Кожна сторінка зараз заново обчислює звіт; durable cache/довгі RR transaction/timeout/temp-disk budget — наступні питання, не прихована обіцянка SLA. Нова модель retention/scheduler відсутня.

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

## Follow-up B24: історичний child fanout

`server/erp/report_children.py` використовується тільки новими summary/rows/export через `bounded_reports`; mutation services, legacy/default settlement adapters і старий `/api/erp/report` не змінено. `include_lines=True` старого pure oracle залишився для сумісності; native UI нових звітів його не викликає. Немає міграції, cache або нового cash/payroll правила.

- Line stream зберігає кожен рядок, у тому числі старі duplicate product lines: inventory correction додається на кожен відповідний рядок, як раніше. Nonzero period та Kyiv cutoff/reversal збережено.
- Obligation: source total − money(returns) − money(active allocated+unmapped legacy payments) − embedded payments + refund payments. Advance: money(payment total − active allocations − legacy direct fallback − refunds), без нового clamp. Для advance старий mapped suppression лишається unconditional, для obligation — active; це навмисно різні oracle правила.
- JSON paths/fields whitelist; scoped ORM subquery і SQL значення параметризовано. PostgreSQL JSONB scalar tokens та SQLite JSON1 `->` (SQLite≥3.38) відновлюють оригінальний Python JSON scalar, з float digits/bool/null і великими integer; немає json_quote→float втрати точності. Payments не читають стороннє поле product. Некоректні потрібні arrays/items/selected nested scalars повертають контрольовану BusinessError з ID, без цілого JSON у Python. Відсутні ключі відрізняються від явного null.
- Voucher.defer/only(payload) не використовується як прихована обіцянка: потрібний малий payload явно підставляється з header scalar annotations; tests забороняють refresh_from_db(fields=['payload']). Stock не довантажує product.data.
- READ ONLY RR, current role/store, manager payroll privacy, streamed CSV/formula guard і spool cleanup залишилися в одному чинному контексті. Бонус бере ту саму chronology та remaining frozen basis; календарні/фінансові формули не переписано.

### Цільові докази

Ізольовані SQLite та PostgreSQL18 `test_tsukenya_report_children`, база production не відкривалась. `tests.test_report_children.ReportChildrenTests` містить7 сценаріїв; усі пройшли відповідними вузькими хвилями на обох engines, успішні незмінені хвилі reuse. Це не full/capacity benchmark.

| Вхід | Реальна матеріалізація / паритет |
| --- | --- |
| Один історичний sale501 lines | Старий prefetch тримає501 живий VoucherLine; новий rows+повний CSV peak2 models, fetch≤200, whole child payload decode0 (PG+SQLite). Qty501.000 / cogs5.01 / revenue1002.00 і CSV formula guard збережено. |
| Inventory501 differences,2 однакові product lines | Реальні501 JSON scalar rows, fetch≤200; adjustment5.01, product correction10.02 як pure oracle. Whole JSON decode0 (PG+SQLite). |
| Source501 embedded +205 returns / allocations / refunds | Obligation/advance паритет з незміненими B15 helpers; advance590.00. PG instrumentation2232 scalar rows (helper + report), fetch≤200, whole payload decode0. |
| One cashshift205 workers,202 returns включно попереднього дня | Frozen bonus/chronology exact old oracle; PG peak2 WorkShift, manager0 і відсутній late_return_bonus. Перехід через200 returns не губить tail. SQLite також PASS. |
| Product recipe501 entries | Report captions/value/CSV без whole product JSON; missing/null caption parity, nested selected caption explicit refusal. PG+SQLite. |
| Numeric scalar / malformed JSON | Float1.0050000000000001, bool, string Decimal та integer понад int64; old oracle exact. Null/object/nested/missing selected child відхиляються без whole decode; SQL array name whitelist відхиляє сторонні імена. PG+SQLite. |
| Cutoff / mapped suppression | Kyiv next-midnight boundary і −1µs, mapped allocation activity, negative advance/debt без clamp; embedded payment із великим стороннім product object не читається. PG+SQLite. |

Додаткові matching PostgreSQL сценарії: чинні network expense/allocation/refund/reversal parity; previous-return/frozen-basis bonus owner/manager/accountant; HTTP role/scope/invalid/no-write; реальна READ ONLY RR concurrent product rename. Кількість SQL не підміняє доказ живих моделей/decoded arrays.

Source commit `103b036b8a98baca7ed3af4fd2cde1c0ae0c212c`; підсумок counters/source hashes — `/tmp/tsukenya-report-children-proof/report.json`.

Instrumentation: weakref живих VoucherLine/WorkShift, JSONField decode observer, заборона deferred payload fetch, wrapper actual chunked_cursor.fetchmany (кількість отриманих tuples і JSON rows). Optional `REPORT_CHILDREN_PROOF_DIR` пише лише synthetic test counters у `{sqlite,postgresql}.jsonl`; artifact цієї задачі `/tmp/tsukenya-report-children-proof/`. Старий prefetch counter має `legacy_prefetch:true` і є навмисним reproduction, не новим PASS bound.

Новий UI/контракт не змінено, тому попередні native/decoder/layout/CSV докази reuse. Не перевірено production capacity, total DB-process memory, довільний розмір scalar value, timeout/disk budget або persistent cache; не запускались full suite чи deployment. Старий compatibility report/default mutation read fanout поза цим пакетом.


### Root інтеграція child fanout

Root переніс тільки own103b036/5c4b7fb поверх accepted main71. Report runtime
source SHA256 збігається з delivery; його base94→main71 reporting/settlement
inputs не змінені. Незмінені author7 PG/SQLite та4matching PG докази використані
повторно. Source review підтвердило паритет rounding/legacy suppression,
Kyiv reversal/nonzero-period, inventory duplicate multiplicity та payroll
privacy; SQL fragments whitelist, request/ORM values параметризовані.

Root додав2 окремі boundary кейси: zero-period cancellation не читає malformed
inventory children; historical direct-reference payment + allocation іншому
source зберігає різні obligation/per-source та advance/any-map suppression,
у т.ч. після скасування другого source. Ізольована PostgreSQL2 PASS0.392s:
DB tsukenya_root_report_children; materialization counters у
`/tmp/tsukenya-root-report-children/postgresql.jsonl`. Business adapters не
змінювалися. Повного локального прогону та deployment не було.
