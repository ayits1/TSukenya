# Завершення аудиту UI/UX · 03.10.2026

## Обсяг і статус

Перевірено всі **16 маршрутів порталу, вхід і обліковий запис**, основні форми та елементи, знайдені під час послідовного аудиту. Підтверджені дефекти виправлені; фінальний пакет — залежні фільтри й пояснення журналу. Це завершення узгодженого аудиту поточної версії, не гарантія відсутності невідомих помилок у всіх комбінаціях браузерів/даних.

Окремий документ [BUSINESS-IMPROVEMENTS.md](BUSINESS-IMPROVEMENTS.md) містить **32 пропозиції B01–B32**: 2 P0, 13 P1, 16 P2, 1 P3. Для кожної наведено доказ із коду, конкретну зміну й критерії приймання. Виконані захисні частини позначені окремо; інші бізнес-пропозиції не видаються за реалізовану CRM-функцію. Їхня реалізація не була умовою завдання зібрати пропозиції.

## Матриця покриття

| Сторінка / поверхня | Перевірені сценарії та докази |
| --- | --- |
| `operations/overview` | Показники й quick links, права, startup roles, scope задач; `tests/ui-audit.cjs`, [TASK-SCOPE-QA.md](TASK-SCOPE-QA.md), [CATALOG-PRICING.md](CATALOG-PRICING.md) |
| `operations/products` | Пошук/сторінки/фільтри, довідники, гривні/копійки, дата, стара/акційна ціна, readonly, conflict409; [CATALOG-MIGRATION.md](CATALOG-MIGRATION.md), `tests/catalog-ui.cjs`, [FILTERS-AND-AUDIT-QA.md](FILTERS-AND-AUDIT-QA.md) |
| Імпорт каталогу | CSV preview, номера рядків, strict values, paging, атомарність, retry/conflict/неоднозначний запис; [CATALOG-IMPORT.md](CATALOG-IMPORT.md), [CSV-FORMAT.md](CSV-FORMAT.md) |
| Масові ціни | Точний preview було/стане, ручні ціни/акції, ролі, atomic commit, idempotency, 320px; [CATALOG-PRICING.md](CATALOG-PRICING.md) |
| `operations/tags` | 3 вкладки, 13 полів, інспектор/макет, вибраний товар, акція/стара ціна, snapshot conflict, copies/proof/print/CSV/PDF, cancel/unmount/retry/200%; [LABEL-STUDIO.md](LABEL-STUDIO.md), [CSV-FORMAT.md](CSV-FORMAT.md), [FILTERS-AND-AUDIT-QA.md](FILTERS-AND-AUDIT-QA.md) |
| `operations/work` | Native validation, duplicate/error recovery, роль/магазин/системні/мережеві задачі, прямі URL; [TASK-SCOPE-QA.md](TASK-SCOPE-QA.md), [RUNTIME-RECOVERY.md](RUNTIME-RECOVERY.md) |
| `operations/expenses` | Окремі назва/сума/видалення, довгі значення, decimal bounds, dirty/refresh recovery, external delete/orphan/discard, pending delete/route lock/roles; `tests/expenses-ui.cjs`, [UI-UX-AUDIT.md](UI-UX-AUDIT.md) |
| `development/devOverview` | План розвитку, переходи, роль власника, прямий URL; основний `ui-audit`, task-scope |
| `development/ideas` | Форма ідеї, validation/save error/duplicate recovery, keyboard/focus; основний `ui-audit`, runtime-recovery |
| `development/tasks` | Пов’язані задачі розвитку, права/dirty/validation/recovery; основний `ui-audit`, task-scope/runtime-recovery |
| `trade/purchases` | 3 форми, пошук/сторінки/довідники, чернетки, save/read/detail retry; `tests/ui-audit.cjs`, [UI-UX-NEXT-COVERAGE.md](UI-UX-NEXT-COVERAGE.md), [ERP-SETTINGS-RECOVERY-QA.md](ERP-SETTINGS-RECOVERY-QA.md) |
| `trade/stock` | 5 форм, фільтри/CSV/партії, рецептури fresh revision/dirty/conflict/real PG race/200%; основний `ui-audit`, [RECIPE-RECOVERY-QA.md](RECIPE-RECOVERY-QA.md) |
| `trade/sales` | Продаж/повернення/замовлення, магазин/працівник/рахунок/зміна/штрихкод/оплата/readonly; cashier cost redaction; `tests/crm-ui.cjs`, основний `ui-audit` і серверні негативні сценарії |
| `trade/finance` | Платіж/витрати/opening/debt/transfer, роль бухгалтера, payroll exclusion, paged debts/ledger, GET error/retry; `tests/finance-browse-ui.cjs`, [UI-UX-AUDIT.md](UI-UX-AUDIT.md) |
| Журнал змін | Paging/filter/date/stale/retry/403, українські резюме/technical disclosure/200%; `tests/finance-browse-ui.cjs`, [FILTERS-AND-AUDIT-QA.md](FILTERS-AND-AUDIT-QA.md) |
| `trade/staff` | Працівник/касова й робоча зміна/payroll/payment; незмінні історичні суми/ID, 130 касових/520 робочих змін, paged chooser, точний сценарій401.00; `tests/ui-audit.cjs`, `tests/test_shift_browsing.py` |
| `trade/customers` | Entity/history/search/paging; no-result проти empty, clear/focus; основний `ui-audit`, [UI-UX-NEXT-COVERAGE.md](UI-UX-NEXT-COVERAGE.md) |
| `trade/reports` | Store/date/filter, last report при503, поточні борги не історичний баланс, CSV; `tests/ui-audit.cjs`, `tests/finance-browse-ui.cjs`, [CSV-FORMAT.md](CSV-FORMAT.md) |
| `trade/setup` | Усі entity форми, users loading/stale/error/retry, справжні409/403/create/edit/revoked session, period400/close/reopen, fiscal required/optional; [ERP-SETTINGS-RECOVERY-QA.md](ERP-SETTINGS-RECOVERY-QA.md) |
| Вхід / обліковий запис | Pending locks, validation/retry/focus, пароль/logout failure, role-refresh; `tests/auth-ux.cjs` через `QA_AUTH_ONLY`/`QA_UX_ONLY` основного helper; [RUNTIME-RECOVERY.md](RUNTIME-RECOVERY.md), [TASK-SCOPE-QA.md](TASK-SCOPE-QA.md) |
| Спільні dialog / document table | Dirty navigation/Escape/pending, long errors320, failed detailGET/retry/stale, справжні200%, container-driven cards, native headers, 44px/focus; [UI-UX-NEXT-COVERAGE.md](UI-UX-NEXT-COVERAGE.md), [ERP-SETTINGS-RECOVERY-QA.md](ERP-SETTINGS-RECOVERY-QA.md) |
| Межі дат | Kyiv midnight при іншому browser timezone, period/work/payroll/expense/report, min/max і фактичні відповіді Django; `tests/erp-date-boundary-ui.cjs`, [FILTERS-AND-AUDIT-QA.md](FILTERS-AND-AUDIT-QA.md) |

## Звірка результатів

- Основний фінальний report: **`/tmp/tsukenya-ui-audit-after/report.json` — 100 станів / 50 поверхонь**, widths1440/390, без overflow/tiny targets/page errors/axe violations. Axe запускався на1440. Раніший `os.tmpdir()/tsukenya-ui-audit/report.json` із72 станами не є фінальним індексом.
- Наступні негативні/recovery/рольові/layout сценарії підтверджено відповідними документами таблиці; 320px/200% перевірялись цільово, а не у всіх100 станах.
- Для PDF основні збережені індекси **`os.tmpdir()/tsukenya-label-output-qa/results-all.json` і `results-tail.json`**. Поточний `results.json` міг бути перезаписаний вузьким zoom-проходом. Дві A4 сторінки,300dpi,0 differing pixel channels у контрольному порівнянні; PNG переглянуто. Фізичний принтер не підтверджується цим результатом.
- Залежні фільтри: `os.tmpdir()/tsukenya-facets-qa/results.json`,4case PASS. Журнал: `os.tmpdir()/tsukenya-audit-details-qa/results-content.json` / `results-layout.json`, PASS. Дати: stdout PASS відтворюваного helper.
- Результати незмінених частин повторно використано. `npm run test:full` не запускали; нові helpers додано в єдиний майбутній повний entrypoint. Документація та `--plan` не є повною регресією.

## Межі й подальші роботи

Поза цим доказом: ручний screen-reader аудит, всі негативні стани у Firefox/системному Safari, реальні принтери, actual XLSX upload/decode, відкриття/повторне збереження CSV у конкретних spreadsheet editors, native mobile peak memory і виробниче навантаження. Це окремі перевірки з обладнанням/оточенням, не підтверджені поточними screenshots/unit tests.

Бізнес-план починається з описаних у B03/B04 облікових інваріантів, B06 API/retry, B05/B07/B08 повернень/знижок/каси та B16/B17 плану/факту. Пріоритет і залежності залишені в [BUSINESS-IMPROVEMENTS.md](BUSINESS-IMPROVEMENTS.md); зміни бонусів чи інших грошових правил не вводяться під виглядом UI-правки.

Публікація та backup/rollback фіксуються окремо в [SERVER-DEPLOYMENT.md](SERVER-DEPLOYMENT.md). Ізольовані mutation proofs не запускаються на робочій базі або Google Sheet.

## Підтвердження публікації

Фінальний UI-пакет опубліковано з backup `tsukenya-crm-20261003T024358Z.dump`. Live exact hashes, pending фасети1440/320, журнал320 та бюджет1440/768/390/320 — PASS; бізнес-записів немає, digest незмінний, web/PG healthy. Документ [SERVER-DEPLOYMENT.md](SERVER-DEPLOYMENT.md) містить точні архіви, відкат і live artifacts. Окрема read-only звірка підтвердила16routes/100states/50surfaces/32пропозиції та не знайшла інших конкретних відкритих UI-дефектів у перевіреному обсязі.
