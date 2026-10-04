# Узгодження табеля · B06

## Чинний контракт

`workShiftForm` використовує спільні `NativeConflictComparison`, `nativeFields` та `threeWay`.
Нової merge-логіки немає. Початкові DTO, умови й revision існуючого табеля фіксуються при відкритті.
Читання поточної версії не приймає нову revision й не переписує введені поля.

- Примітка незалежна. Касова зміна, units, ставка, відсоток та база відсотка — одна консервативна атомарна група.
- ID, працівник, магазин і дата незмінні. Нараховано, база нарахування та payroll ID лише для читання й не входять у merge.
- GET має повний strict DTO, точний ID/кількість відповіді, чинний salary/store scope та перевірені captions.
  Неправильний resource/ID/identity, неповна відповідь, некоректні units/precision/percent/cash terms, 403/503 не змінюють baseline.
  DTO й Apply payload проходять captured draft validator до прийняття baseline; signed readonly basis_amount лишається читабельним.
- Підписи atomic групи використовують `NativeField.keyValueLabels`: назва касової зміни ID1 не підміняє units/rate зі значенням1.
  Старий `valueLabels` лишається сумісним.
- Історично вибраний неактивний працівник читабельний; ставка працівника сьогодні не замінює умови старого табеля.
  Нові employee choices лишають чинний active guard. Для вибраного працівника нового табеля потрібні повні private rate/percent/basis;
  malformed metadata не підміняється нулями. Порожня форма без працівників лишається доступною для наступного вибору.
- На час GET та порівняння редактор заблокований. Скасування читання доступне окремо; AbortController,
  generation/source guards й unmount відкидають пізню відповідь після Cancel/Close/navigation.
- Apply узгоджує лише поля відкритої чернетки та приймає переглянутий baseline/revision. POST виконується окремою кнопкою Save.
  Наступна зовнішня зміна знову дає 409; новіші введення залишаються, потрібне нове порівняння.
- Поточний payroll-зв’язок блокує Apply й Save. Django й далі визначає права, періоди, виторг, зарплату та незмінність історичних умов.

## Початкове створення й втрачена відповідь · B04

Повтор створення зберігає весь початковий intent і UUID. Він не читає новіший FormData, навіть якщо ставка порожня
або вибрана інша касова зміна. Підтверджений ID зберігається перед наступним GET; невдалий GET повторюється лише як читання.
Confirmed POST більше не повторюється. Початковий intent є baseline саме початкового запиту;
чинна revision сервера з’являється в чернетці лише після явного Apply. Новіші поля не стираються.
Невалідні новіші поля не блокують GET, але actionable merge потребує коректного captured draft.

## Цільові докази

Вихідна база `82bc3ed2091b45787a2309f855744b0c861ed2a6`. Власний isolated clone `/tmp/tsukenya-work-shift-conflicts-next`.
Перевірки без production/Google Sheet; disposable SQLite native fixtures та окрема `test_tsukenya_work_shift_conflicts` PostgreSQL18.

- `workShift.test.ts` + existing `fields.test.ts`: 8 unit PASS; strict DTO/identity, whitelist, точне decimal порівняння,
  незалежна примітка, атомарні умови, caption ID/amount collision. Після посилення whitelist assertion повторено лише 4 workshift unit PASS.
- NativeConflict + WorkShiftConflict stories: 4 PASS (2.20 s): existing bridge keyboard/cancel/captions та нові атомарні payroll terms.
- PostgreSQL matching3 PASS (0.405 s): stale revision не переписує новіші умови, дві касові зміни й незмінні payroll snapshots,
  salary/store lookup guards. Business mutations і формули не змінені; ширші незмінені concurrency тести повторно не запускалися.
- Actual native Chrome primary PASS: immutable create retry після committed/lostACK, invalid newer draft + інша касова зміна,
  GET503/GET-only retry, дві послідовні 409, no POST before separate Save, клавіатура й 320 px; фактична зарплата600.00
  для двох касових змін (185 +415).
- Actual native existing-only5 groups PASS: незалежні note/terms; атомарний вибір серверних умов; historical inactive employee без adoption
  поточної ставки999; wrong resource/ID/store/date та GET503/403 без втрати draft; Cancel/late GET; реальний зовнішній posted payroll
  блокує Apply/Save. Переглянуто comparison PNG1440/320, recovery й результат зарплати.
- Build/TypeScript, affected ESLint, Node syntax і `git diff --check` PASS.

Artifacts `/tmp/tsukenya-work-shift-conflict-proof/`: `report.json` primary; `existing-report.json` existing;
`existing-comparison-1440.png`, `existing-comparison-320.png`, `recovery-comparison-320.png`, `recovery-apply-320.png`,
`payroll-result-320.png`. Fixture setup читає legacy state лише для synthetic seed; це не capacity/network-size benchmark.

```sh
# Без прапорця harness виконує три окремі disposable етапи primary/existing/semantic; перевірені етапи тут виконано окремими командами.
PYTHON_BIN=/path/to/python node tests/work-shift-conflict-ui.cjs
WORK_CONFLICT_FROM=primary PYTHON_BIN=/path/to/python node tests/work-shift-conflict-ui.cjs
WORK_CONFLICT_FROM=existing PYTHON_BIN=/path/to/python node tests/work-shift-conflict-ui.cjs
WORK_CONFLICT_FROM=semantic PYTHON_BIN=/path/to/python node tests/work-shift-conflict-ui.cjs
```

Follow-up source review: 6 workshift unit PASS (0.088 s), включно з serverunits0/>10, недопустимою precision,
percent100.001/positive без cash та missing employee private terms. Окремий `WORK_CONFLICT_FROM=semantic`
actual native PASS: malformed serverunits0 й invalid Apply не змінюють draft/revision й не роблять POST;
наступний valid GET/Apply та окремий Save працюють. Missing private employee terms блокують нове відкриття без inventedzero.
`semantic-report.json` — окремий proof; первинний B04600, existing5 та stories не повторювалися. Build/lint/Node/diff PASS.

`tests/multiple-work-shifts-ui.cjs` зберігає стару B04 команду як primary wrapper цього самого harness.
Повну регресію, publish, deployment, VPS чи backup0.1 не виконували. Збереження чернетки через reload не входить до цього пакета.

## Незалежне інтеграційне рев’ю

Пакет інтегровано поверх прийнятого #60 (`6d4a8fe`); спільний React entry зберігає Entity і WorkShift exports.
Root до виправлення відтворив прийняття units0/>10, percent100.001, rate1.0001 та positive bonus без cash.
Після follow-up тимчасовий незалежний reproduction і постійні workShift unit: 7 PASS (107 ms).
Тимчасовий дубль прибрано; постійний regression має всі ці cases і private employee terms.
Combined TypeScript/Vite build PASS; actual comparison PNG1440/320 переглянуті.

Root `WORK_CONFLICT_FROM=semantic WORK_SHIFTS_PROOF_DIR=/tmp/tsukenya-root-work-shift-semantic
PYTHON_BIN=/tmp/tsukenya-review-venv/bin/python node tests/work-shift-conflict-ui.cjs`: PASS,
окремий `semantic-report.json`. Перша sandbox спроба не відкрила localhost порт (Operation not permitted);
після дозволеного isolated запуску повторено лише цей етап. Це не функціональний збій застосунку.
Повний registry виконує один workshift harness із primary/existing/semantic, старий primary wrapper
залишається доступним; full runner прибирає частковий прапорець і зовнішній output path.
`test:full -- --plan` — тільки dry-run, повна регресія й VPS не запускалися.
