# Відновлення чернетки плану місяця · B06

План місяця використовує чинні серверні формули, сумові обмеження, UUID рядків, історичні назви статей і scope магазину. Факт, класифікація, payroll, архівні назви й довідники не є полями merge. Серверні receipt/API/0022 і окремий редактор статей належать пакету `PLANNING-CATEGORY-RECOVERY.md`; цей пакет змінює лише плановий native інтерфейс та його строгий адаптер.

## Порівняння й записи

Початковий бюджет/версія заморожені окремо від введення та readonly звіту. ID, місяць і магазин збереженого бюджету незмінні. Поточний GET повертає strict `resource:'monthly_budget'`, exact ID/month/store, revision та `permissions.canEdit`. Відсутні поля, інший ресурс, неправильна сума, scope або дозвіл не підставляються типовими значеннями.

Виторг — незалежне поле. Якщо ordered membership UUID збігається у base/mine/server, кожен рядок порівнюється одним atomic scalar: category/mode/amount/rate/base. Зміна складу або порядку використовує один descriptor «Склад і порядок усіх рядків»: користувач явно обирає весь список у конфлікті. Автоматичного union, нового merge engine або змішування частин одного рядка немає. Existing NativeConflictComparison/threeWay є єдиним алгоритмом і компонентом.

GET не записує й не приймає revision як основу. Apply перевіряє resolved draft, max200/unique UUID та активні/історичні binding статей, застосовує лише локальне введення і fresh baseline. Save — окрема дія з fresh revision; другий409 знову потребує порівняння. Current403/malformed/cancel/late response не підміняють основу або поля. Під час поточного читання/порівняння поля заблоковані, доступне скасування. Dirty draft лишається у cached month/store до закриття сторінки.

## CREATE та невідомий результат

POST використовує frozen method/path/body і один стабільний ключ на початкове створення. Type-button exact retry не залежить від validity нового введення. Після першої ambiguity наступний4xx не стирає first intent. Readonly identity підтверджує original key/author/fingerprint на сервері; returned revision не є editor baseline. Локальні frozen початкові terms лишаються comparison base; ID можна використати лише для наступного readonly current read. Deleted receipt блокує новий POST/відновлення, legacy_unknown не стверджує відсутності запису.

ACK звіряє resource/request_key для POST, ID для PUT, revision і кожен ordered writable row та суму з immutable запитом. Confirmed original ACK із новими invalid полями підтверджує ID, зберігає нові поля і блокує Save до явного узгодження. Known UPDATE unknown ACK не повторює PUT: лише GET/compare. Initial definitive4xx до ambiguity лишається штатною відмовою. Окремий `budget_exists` до будь-якої ambiguity означає, що місяць уже має план: explicit comparison читає period-scoped view → strict current ID/policy, показує наявний ID та не заявляє авторство. Його ID/revision приймаються лише на Apply.

Confirmed Save + збій оновлення факту — тільки GET retry. «Оновити факт і довідник» зберігає plan draft/baseline/identity, а не робить destructive reload. Паралельне збереження статті через окремий dialog оновлює choices, не стираючи план.

Reload survival не додано: ключі й чернетки живуть у відкритій сторінці, beforeunload попереджає про незбережені зміни. Це чинна B06 межа. Фізичний DELETE бюджету чи нові фінансові правила не додавались.

## Цільові докази

- `monthlyBudget.test.ts`: 6 PASS — independent revenue/rows, atomic same-row choice, removal/order/additions wholelist, exact bounded decimal/resource/policy/ACK/identity, historical archived binding.
- `MonthlyBudget.stories.tsx`: 2 PASS — keyboard whole-list choice/Apply та Cancel; спільний компонент.
- TypeScript, build, цільовий ESLint/Prettier та JS syntax PASS.
- `tests/monthly-budget-conflict-ui.cjs`: isolated actual Django/SQLite/Chrome. `MONTHLY_PLAN_STAGE=independent|tail|create|policy` дозволяє продовжити лише потрібний етап; без прапорця проходить весь цей один сценарій. `MONTHLY_PLAN_PROOF_DIR` задає артефакти.
- `/tmp/tsukenya-monthly-plan-proof/report-independent.json`: independent revenue/different rows, current503, Apply no write, separate Save.
- `report-tail.json`: same-row keyboard/second409, explicit whole-list removal, category save preserves dirty plan; `plan-1440.png`/`plan-320.png` переглянуті, без overflow, touch44px.
- `report-create.json`: actual committed lost ACK→exact403 при порожньому newer field; original identity без revision adoption; current503/403/malformed; canceled GET; explicit Apply/Save; confirmed update + facts503 лише GET retry.
- `report-policy.json`: definite initial budget_exists → explicit existing plan comparison; current403 blocks Save; navigation fence і cached draft після late GET.
- `tests/monthly-budget-decimal.cjs`: exact large aggregate .98/.99 display/normalization, scientific spelling/negative facts/rate3 PASS. Fixture перевіряє legacy normalization helper; strict new ACK окремо перевіряє серверне обмеження суми й receipt.
- Зачеплений старий `monthly-budget-recovery-ui.cjs` має `--budget-only` для budget ACK/readonly validation, `--scope-only` для scoped owner320/network/foreign403; новий category dialog block доставлено відповідальним агентом. Budget-only та scope-only — PASS на ізольованій SQLite; успішні category/scope stages не повторюються без зміни їхніх inputs.

Серверні creator/currentactor/ledger/RR/concurrency перевірки PostgreSQL та формули/history використані з matching backend пакета; UI не змінює backend. Жодних production/VPS/Google Sheet/full regression дій цей пакет не виконує.


## Root інтеграція

Actual plan/category consumer інтегровано разом на accepted main68+legacy69 без QA
dependency commits. Shared source і formulas не змінено; combined build/types/targetlint/
Prettier PASS. Авторські unit6/Story2/4native stages і oldbudget/scope proofs повторно
використані. Root actual policy stage PASS: initial definite budget_exists читає exact
period/current identity без creatorclaim/revision adoption, Save тільки після Apply;
current403/lateGET/navigation зберігають cached draft. Артефакт
`/tmp/tsukenya-root-monthly-plan/report-policy.json`. Exact decimal VM PASS.

Виявлено QA coverage gap: колишній default all не виконував policy branch. Default
entry тепер один wrapper чотирьох focused stages independent/tail/create/policy;
невідомий stage відхиляється. Explicit full registry очищає MONTHLY_PLAN_STAGE/PROOF_DIR
і викликає wrapper один раз. Harness прибирає inherited POSTGRES_URL/owner password,
помічає ранній exit, очікує teardown й залишає report поза disposable data.
Syntax/dryrun PASS; весь full локально не запускався.
