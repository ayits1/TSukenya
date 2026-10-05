# React: команда й зарплата

## Фактична межа

`#trade/staff` монтує `frontend/src/staff-entry.tsx` і спільні React Aria controls.
Три вкладки охоплюють чинну сторінку:

| Вкладка | Читання й фільтри | Чинні дії |
| --- | --- | --- |
| Працівники | Пошук, магазин, сторінки30, активний/неактивний стан, поточна ставка/відсоток/база, точний залишок зарплати | Owner Add/Edit через native entity editor; accountant лише перегляд |
| Табель | Магазин, працівник, включні дати, сторінки30, ID табеля/касової зміни, історичні units/rate/percent/basis/accrued | Відмітити/редагувати зміну через native B06 editor; відкрити пов'язане нарахування; нарахований або закритий табель не редагується |
| Документи | Магазин, стан, сторінки30, нарахування та виплата/аванс | Відкрити native detail з чинними Edit/Post/Delete/Reverse; створити payroll або payroll_payment |

Оновлення та launcher локальних чернеток залишаються доступними. Native
редактори, cash-choice, багатосторінковий payroll selector, B06 frozen UUID/
original intent, порівняння/окремий Save та unknown ACK не переписані. Mounted
подія після готового renderer збережена для холодного відновлення.

## Контракт і бухгалтерський зміст

Окремий `contracts/trading-staff.openapi.json` генерує `staff.generated.ts`.
Три versioned GET: `/api/v1/trading/staff/employees`, `/work-shifts`, `/documents`.
Усередині одного READ ONLY REPEATABLE READ: fresh `current_actor`, owner/accountant,
поточна store scope та closed-through policy, count і сторінка30. Невідомі,
повторні, некоректні параметри відхиляються; client перевіряє точну структуру,
query echo, pages/count/unique IDs, policy/scope, HMAC/числові версії та decimals.

Employee debt використовує чинну SQL SUM posted payroll minus payroll_payment;
негативний залишок означає вже виплачену суму понад нарахування і не затискається
до нуля. Ставка конкретної зміни та її відсоток читаються з WorkShift, а не з
поточної Employee. Units множить лише ставку. Відсоток кожного працівника
від усього виторгу відповідної касової зміни, cross-midnight guard і snapshots
належать чинним Django services. Аванс зарплати — payroll_payment; не розподіл
авансу контрагента. Нарахування та виплата залишаються окремими рухами.

Journal читання повертає тільки scalar headers, без Voucher payload/calculation,
рядків чи моделей allocations. WorkShift projection обмежена30; примітка для
чинного HMAC перевіряється SQL LENGTH/CASE і відхиляється понад2000 символів,
не обрізається і не матеріалізується повністю. Нативний detail відкривається
окремо і зберігає свій чинний контракт. SQL count/SUM може проходити всю
відфільтровану історію; це не capacity benchmark/не constant-time обіцянка.

Гроші UI відображає зі строки без Number, включно великими `.98/.99`.
Historical signed basis/accrued та legacy personal/profit без cash-shift
залишаються читабельними. Нові posting rules, money limits і snapshots не змінені.

## Асинхронність і приватність

Новий GET очищує старі rows;503/protocol дають окремий GET-only retry без POST.
Paging failure фокусує Retry. Native actions блокуються до підтвердженого
читання; подвійний запуск блокується, opener захоплюється до async preflight
і повертається після Escape, включно дуже раннім закриттям.

Кожний read/action має generation/leave fence до401/403 handling. Поточний
policy mismatch/401/403 прибирає приватні rows, captions, filters та actions.
Native payroll detail auth error доходить до model deny; nonauth detail errors
зберігають native readonly retry. Employee/workshift opening403 після preflight
також передається current Staff action, а не залишає приватну таблицю.

`refreshCommitted()` для майбутнього optional freshness coordinator перечитує
останній підтверджений query/page та залишає новіший, ще не submitted search text.
Coordinator у цьому пакеті не підключений; hard dependency/force mount немає.

## Цільові докази (isolated, own matching build)

- `tests/test_staff_reads.py`: PG5 cases PASS через initial2 + affected fixture-tail3
  (terminal tail session66422, 1.023s); SQLite4 PASS + PostgreSQL-only1 skip через
  initial1 + affected3. Перші3 fixture failures були opening_cash default і
  in-memory int vs DB Decimal HMAC; виправлено лише fixtures. SQLite tail log:
  `/tmp/tsukenya-staff-sqlite-tail.log`. Успішні server source inputs не змінювались.
  Actual post payroll two tills100/300: captured100+10% і units2×200+5% =>525.00;
  Employee777.99/77.777 не змінює історію. Separate payout600.98 =>debt-75.98.
  PG14-digit `.99`, scalar no-Voucher-model/payload,35-row pages, note250000 SQL
  refusal, cached actor scope/inactive/closed period, strict no-DML params та
  concurrent count/items RR included. PostgreSQL використав тільки QA61144/
  tsukenya_staff; production не читалася.
- Staff strict API/state unit8 PASS: `/tmp/tsukenya-staff-unit-final.log`;
  malformed terms/counts/private policy, exact huge cents,503 query retention,
  late read/callback401, current403, captured opener/dedup, committed-query refresh.
- Story4 PASS: `/tmp/tsukenya-staff-stories.log`; після явного disabled action
  при error повторено лише affected ReadFailure/PagingRetry:2 PASS/2 skip,
  `/tmp/tsukenya-staff-stories-error-tail.log`.
- Own TypeScript/Vite build, scoped ESLint, formatter, JS syntax/diff PASS:
  `/tmp/tsukenya-staff-build.log`, `/tmp/tsukenya-staff-lint.log`.
  New staff schema regeneration + same formatter byte comparison PASS; full runner
  тільки `--plan` (жодної перевірки/контейнера/браузера цей command не запускає).
- Actual native primary **partial PASS3 groups**, потім test-only точні
  заголовок `Новий документ: …` і reverse-voucher locator скориговано:
  `/tmp/tsukenya-staff-proof/all-partial.json`. 3tabs, employees30/fullcount,
  inactive search, captured terms, work30,1440/320 row/action geometry.
  PNGs `Працівники-1440.png`, `Табель-320.png`, `Документи-320.png` там само;
  desktop і mobile PNG візуально переглянуті.
- Affected native callbacks terminal PASS:
  `/tmp/tsukenya-staff-callbacks-ready/callbacks-report.json`.
  Employee Add/Edit/workshift/payroll/payout actual IDs та Enter/Escape focus.
- Native tail **partial PASS5 groups**, потім late transport fixture треба було
  встановити перед module captured fetch (не production failure):
  `/tmp/tsukenya-staff-tail/tail-partial.json`. Paging503 GET retry; B06 cold
  restore від overview через migrated mount з invalid rate `-`/raw note;
  owner→scoped accountant, manager403 та payroll native detail403 privacy.
- Лише affected error-source tail terminal PASS:
  `/tmp/tsukenya-staff-errors-final/errors-report.json` —503 focus/exact page,
  no writes, Add/Create явно disabled до successful read.
- Лише late ignored-abort tail terminal PASS:
  `/tmp/tsukenya-staff-late/late-report.json` —obsolete401 після routeleave не
  інвалідує новий сеанс/renderer. Усі browser checks bundled Chromium headless,
  isolated SQLite, env scrub, readiness/exit guard та awaited SIGTERM/SIGKILL cleanup.

Повного нового `all` terminal PASS не заявляємо: primary/tail successes і affected
retries перелічені окремо. Full suite/Finance families/production/deployment не
запускалися. Screen reader/enlarged text/capacity не перевірялись. Native posting
історія/B04/B06 broader proofs reused за незмінних implementations, не названі
новим повним browser pass. Staff не означає завершення React усієї CRM.

## Старі тестові consumers

Full registry додає новий `react-staff-ui.cjs`, очищує QA_STAFF_FROM/PORT/
STAFF_PROOF_DIR. Успадковані tests, що натискали вилучені Staff data-trade
кнопки або history(work) native wrapper, потребують test-only public navigation
адаптації перед наступним explicit full run: bounded-directories, date-boundary,
entity-draft-reload salary case, shift-browse, ui-audit, work-shift-conflict/
multiple-work-shifts, workshift-draft-reload, trade-dialog-ux, directory-toolbar
Staff branch. Native form/detail fields та cash/payroll selectors залишилися;
не додавайте production alias/duplicate handlers. Цей файл описує actual migration
та власні цільові proofs; readiness старої full matrix окремо не підтверджена.


## Незалежне рев’ю `2d6ccc1`

Review checkout `/tmp/tsukenya-staff-review` не змінював frozen author source.
Fresh `current_actor` усередині READ ONLY RR, scope/role, scalar salary/document
projections, bounded note/HMAC і точні збережені salary terms переглянуті без
змін backend/posting. Author PG/SQLite та geometry докази повторно не запускалися.

Виправлено дві frontend межі, обидві спочатку відтворені окремими unit tests
(`/tmp/tsukenya-staff-review-before.log`, 2 очікувані FAIL):

1. Proxy довідників мав лише workspace generation guard. Late401/403 від
   скасованого пошуку ComboBox міг приховати актуальний workspace. Guard тепер
   перевіряє також AbortSignal саме цього виклику; чинний нескасований403 далі
   прибирає приватні дані. Helper винесено в feature `guard.ts` для прямого тесту.
2. Committed-query cache зберігав попередній магазин після зміни контексту й503.
   Його очищують при зміні магазину/role scope. Без успішного читання в новому
   контексті optional `refreshCommitted()` нічого не читає: не повертає старий
   магазин і не надсилає ще не підтверджений пошук. Явний Find/Retry не змінено.
   `activate()` сам встановлює options після порівняння попереднього контексту.

Нові targeted unit **2 PASS**: canceled401/current403 і failed-store scope /
новіше не submitted введення (`/tmp/tsukenya-staff-review-unit.log`). Matching
TypeScript/Vite build, scoped ESLint, Prettier, JS syntax/diff перевірені:
`/tmp/tsukenya-staff-review-build-final.log`, `/tmp/tsukenya-staff-review-static.log`.

Actual native `QA_STAFF_FROM=review-directory` **PASS**:
`/tmp/tsukenya-staff-review-directory-final/review-directory-report.json`.
Справжній ComboBox abort старого пошуку, transport навмисно повертає late401;
актуальні таблиця/3 tabs/actions збережені. Native Add через Enter та Escape
повертає opener, бізнес-записів0. Початковий browser assertion перевіряв tabs,
поки RAC popover тимчасово приховував решту accessibility tree; виправлено тільки
fixture (Escape перед accessibility assertion), failure збережено в
`/tmp/tsukenya-staff-review-directory/`. Native scope входить також у `all`, тому
додаткова ручна реєстрація full runner не потрібна. Full suite не запускався.

Останнє видалення передчасного `model.options = next` не змінює перевірений
canceled-directory шлях; matching build оновлено, новий broad/browser run не
запускався. Optional coordinator лишається непідключеним. Старі native Staff
consumers усе ще потребують описаної вище test-only адаптації; review не оголошує
їх перевіреними або весь migration/full matrix завершеним. Push/VPS відсутні.

## Інтеграція з прийнятими Finance/Sales

Адитивна інтеграція зберігає обидва React-маршрути, їхні module leave hooks,
modal opener contexts, генератори контрактів і loader entries. Matching frontend
build PASS; ізольований actual `review-directory` в інтегрованій збірці PASS:
late401 скасованого пошуку не приховує salary table/tabs/actions, Enter/Escape
повертає фокус на connected opener, бізнес-записів немає.
Артефакт `/tmp/tsukenya-staff-root-reviewed-directory/review-directory-report.json`.
JS syntax/diff/browser policy і full runner лише `--plan` PASS.
Full readiness потребує окремої адаптації старих Staff consumers, яка виконується
без пропуску бізнес-перевірок.
