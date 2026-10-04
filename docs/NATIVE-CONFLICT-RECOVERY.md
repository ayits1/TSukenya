# Відновлення native CRM чернеток · B06

## Спільний компонент

`frontend/src/native-conflict-entry.tsx` відкриває `window.NativeConflictComparison.mount(host, props)`.
`props` містить `base`, `mine`, `server`, `fields`, `onApply`, `onCancel` і необов’язковий `title`.
Повернений handle має `unmount()`: consumer викликає його перед заміною DOM, закриттям або іншим порівнянням.

Snapshots — перевірені application-owned об’єкти зі скалярними значеннями. Descriptors — код застосунку,
не дані сервера: `id`, український `label`, `keys`, необов’язкові `decimals` назви ключів групи `labels` та `valueLabels` для читабельного відображення ID.
Остання карта змінює лише підпис: порівняння та Save використовують числовий ID.
Декодування HTTP та перевірка точного ID належать consumer. Міст не виконує HTTP, не зберігає дані й не приймає нову revision самостійно.

`shared/native/fields.ts` лише перетворює descriptors на `MergeField`. Рішення належить наявним
`shared/merge/threeWay.ts` та `shared/ui/ConflictComparison.tsx`. Десяткові значення порівнюються через
`decimalKey` без float/округлення. Якщо будь-який ключ atomic групи змінений у різні способи,
користувач вибирає всю групу. Незалежні зміни сервера лишаються в результаті; нез’ясований конфлікт
не дозволяє Apply. Native form заблокована до Apply/Cancel: snapshots відповідають саме переглянутій чернетці.

## Перший consumer: план і результат проєкту розвитку

- На відкритті форми зберігаються первісний DTO та revision. Poll/перегляд не замінює baseline.
- 409 лишає поля у формі, припиняє write intent і блокує Save до явного узгодження.
- «Порівняти з поточною версією» читає лише GET. Форма і Save блокуються на час читання та порівняння.
  Окрема кнопка скасовує читання; AbortSignal і generation guard відкидають запізнілу відповідь.
- 503, некоректний DTO, інший ID або 403 зберігають поля, baseline та revision. Повторюється лише читання.
- Показник, одиниця й ціль — одна atomic група. Інші поля плану незалежні; store/джерело ідеї не редагуються.
- Apply переносить узгоджені поля до форми та приймає fresh baseline/revision. Це **не POST**.
  Save — окреме натискання; нова зміна іншого редактора після GET знову дає 409.
- Виправлення результату зберігає локальну причину. Read-only фактичні витрати, пов’язані документи,
  tasks і статус не стають редагованими через merge.
- Якщо KPI змінився під час введення результату, старий факт залишається у формі. Новий KPI показано окремо;
  потрібне повторне введення факту або явне підтвердження результату без KPI. Result endpoint не переписує KPI.
- Завершений/скасований стан не дозволяє узгодити редагування плану; complete лише для active,
  result_edit лише для completed. POST лишає чинні authoritative owner/store/state/source guards.
- Невизначений результат POST лишається immutable exact-retry intent. Не змішуємо його з read review.
  Чернетка живе у відкритій формі; переживання reload цим пакетом не обіцяється.

Create, старт/скасування, task/source attach/detach мають окремий чинний guard flow. Їх не переносимо на generic
редагування полів: потрібна перевірка дії, актуального стану та task/voucher revision.

## Карта наступних споживачів

| Черговість | Consumer | Поточний захист / межа перенесення |
| --- | --- | --- |
| 1 | `app/initiatives.js` plan/result | Цей пакет: shared comparison, local Apply, Save окремо |
| 2 | `app/erp.js` entityForm | Revision відкриття, 409 зберігає форму. Після directory API delivery: прості поля, immutable store/kind; умови оплати групою |
| 3 | `app/erp.js` workShiftForm | Stable create UUID, frozen intent, GET-only retry, payroll lock. Зберегти підтверджений ID/receipt; замінити custom initial/server/form таблицю без автоматичного overwrite |
| 4 | voucherForm / `app/erp-payments.js` | Draft revision та окремий post. Потрібні keyed B11 line/source/lot/суми й atomic allocations; posted лише readonly, не merge проведення |
| 5 | recipeForm / `app/erp-production.js` | Immutable approved version, component/expiry policy, source revision. Рецептурна група atomic; зберегти B12/B10/B11 guards |
| 6 | `app/portal.js` tasks/ideas/expenses | Цей пакет: record If-Match + exact read DTO, shared local Apply / separate Save; create/managed/monthly окремо |

Managed alerts мають окремий revision/action receipt та lifecycle. Поточні roles, money, stock, actualCOGS
й audit authoritative на Django; зміна способу порівняння їх не змінює.

## Цільові перевірки

```sh
npm exec --workspace frontend -- vitest run --project unit src/shared/native/fields.test.ts
npm exec --workspace frontend -- vitest run --project storybook src/shared/native/NativeConflict.stories.tsx
npm run build:frontend
PYTHON_BIN=/path/to/python node tests/initiative-conflict-ui.cjs
```

Native сценарій потребує зібраного entry/manifest та інтегрованого PortalApi helper із metadata пакета:
`api(path, body, signal)` передає signal у session/ERP fetch. Він створює окрему SQLite й синтетичний проєкт,
не використовує VPS, PostgreSQL production чи Google Sheet. PNG/report за `QA_OUTPUT_DIR` або
тимчасовий каталог ОС `tsukenya-initiative-conflict-proof`. Набір перевіряє actual 409, незалежні/однакові поля,
no POST before Save, GET cancellation/503/malformed/ID, поточні права/стан і новий KPI, keyboard 1440/320.


## Інтеграційна перевірка

Metadata `PortalApi.session(signal)` збережено в initiatives API helper; cancellation не повертається до full-state GET. Новий native conflict сценарій зареєстровано в явній повній команді. Shared unavailable-module сценарій уже виконується через `portal-ui.cjs`, тому його окремий повтор `QA_PORTAL_FROM=module` у full entrypoint вилучено; вузька команда залишається для розробки. Повний прогін не запускався.

Root integration після compact metadata: `QA_CONFLICT_LAYOUT_ONLY=1` actual native scenario PASS; звіт `/tmp/tsukenya-root-initiative-integration/layout-status-report.json` підтверджує завершений GET, unresolved choices block Apply, відсутність business POST порівняння та320/1440 geometry. Обидва actual PNG переглянуті. TypeScript/Vite build PASS. Первинна ширша native матриця з незмінними inputs повторно не запускалася.

## Наявні записи торговельних довідників (B06)

Редактори магазинів, складів, рахунків, контрагентів і працівників використовують той самий
`NativeConflictComparison` та three-way helper. Початкове відкриття і повторне читання виконують
read-only POST `/api/v1/trading/directories/details` із `purpose: manage` та точним ID. Це читання
не створює бізнесових записів або аудиту. Сервер повторно перевіряє чинну роль і магазин.

Окремий ресурсний decoder вимагає версію, усі редаговані поля та незмінну ідентичність;
зокрема відсутні зарплатні умови працівника не замінюються нулями. Збережений неактивний запис
читається за його ID, без підміни першим активним варіантом. Порівнюються:

- магазини: назва та стан;
- склади й рахунки: назва;
- контрагенти: назва, телефон, email, примітка та стан;
- працівники: ім’я, стан і атомарна група ставки, відсотка та бази відсотка.

Магазин, тип рахунку/контрагента, ID, фінансові підсумки й версія не є редагованими полями
порівняння. Зміна незмінної ідентичності між читаннями блокує узгодження.

Після 409, невизначеного результату або відмови в доступі форма зберігає введення і блокує
повторний Save до підтвердженого порівняння. Apply змінює лише локальну чернетку та її базову
серверну версію; окремий Save виконує запис. Новий 409 після Apply знову потребує читання.
Cancel, помилка/неповний DTO, закриття форми й пізня відповідь не підхоплюють нову версію.
Під час читання й порівняння поля заблоковані; повернення до чернетки відновлює введення.
Після підтвердженого Save збій оновлення списку пропонує лише повторне читання.

Межа цього пакета — **редагування наявних** записів. Створення довідника ще не має стабільного
receipt для lost-ACK повтору; його не слід називати захищеним від дублювання. Табель має окремий
B04 recovery-контракт і переноситься самостійним пакетом. Чернетка живе у відкритій формі;
відновлення після перезавантаження сторінки тут не заявляється.

Цільові перевірки:

```sh
npm exec --workspace frontend -- vitest run --project unit src/shared/native/entity.test.ts
npm exec --workspace frontend -- vitest run --project storybook src/shared/native/NativeConflict.stories.tsx -t 'Employee Pay Terms'
PYTHON_BIN=/path/to/python node tests/entity-conflict-ui.cjs
# Тільки початкове відкриття з неповними приватними полями:
QA_ENTITY_OPEN_ONLY=1 PYTHON_BIN=/path/to/python node tests/entity-conflict-ui.cjs
python manage.py test tests.test_entity_recovery --noinput
```

Native test створює власну SQLite та синтетичні записи, використовує локальний Chrome.
`report.json`, `workflow-report.json` і viewport PNG 1440/320 записуються в `QA_OUTPUT_DIR` або
тимчасовий каталог ОС `tsukenya-entity-conflict-proof`. Два нові API-тести також пройдено
на окремій PostgreSQL базі: stale save→read без аудиту→окреме збереження; неактивний працівник
із повними умовами та актуальна відмова ролі. Повний набір не запускався.

Root integration: TypeScript/Vite build PASS; `QA_ENTITY_OPEN_ONLY=1 QA_OUTPUT_DIR=/tmp/tsukenya-root-entity-open` native PASS підтверджує завантажений adapter, видиму відмову відкрити owner employee з неповними умовами без жодного POST. Авторський ширший workflow окремо підтвердив late read після закриття/навігації. Обидва author actual comparison PNG1440/320 переглянуті root. Ширші native докази повторно використовуються для незмінених inputs. Entity сценарій зареєстрований один раз у full entrypoint; partial flags entity/initiative/directories та їхні output paths очищаються перед явним full pass. Виконано лише `test:full -- --plan` для перевірки реєстру, без повної регресії.


## Наявні задачі, ідеї та планові статті витрат

`app/legacy-record-editor.js` використовує `NativeLegacyEditor` для строгих snapshot/DTO/whitelist
і наявний `NativeConflictComparison` для порівняння. Другого merge-алгоритму немає.

`GET /api/v1/portal/records/{tasks|ideas|expenses}/{id}` — read-only RR snapshot із точними
`collection`, `id`, `revision`, `data`, `permissions`, `managed`, `initiative`. Він повторно перевіряє
поточну роль/store/source. Дані іншого ID, відсутня revision/permissions, malformed money або джерело
не приймаються. GET не створює audit чи нові записи.

Для **наявного** legacy PUT/PATCH/DELETE `/api/docs/{collection}/{id}` потрібен If-Match,
отриманий на відкритті або після явного Apply. Server під ledger lock спочатку оновлює active/profile,
перевіряє original resource scope/source, потім token: 428 відсутній, 409 застарілий/видалений запис.
PATCH/DELETE та PUT із observed revision не відновлюють видалений запис. Exact POST create receipts
не змінені; нове створення без observed revision лишається окремим контрактом.

Editable whitelist:

| Запис | Поля | Межа |
| --- | --- | --- |
| manual task | title, status, dueDate; stage лише development | scope/store/source immutable; managed alerts не generic edit |
| idea | title, text, reaction | project/source guard збережений; linked idea delete лишається забороненим |
| legacy expense | name; atomic amount/group/category | лише network owner; окремо від MonthlyBudget і проведених витрат |

Legacy необов’язкові поля можуть бути відсутні/null у read projection; незмінені відсутні поля не
додаються PATCH-ом. Невідомі старі metadata залишаються на сервері й не реконструюються клієнтом.
Existing PUT приймає той самий whitelist і зливає його з prior data, не стираючи metadata.
Для expenses read amount — decimal string. Редактор нормалізує введення з комою в dot decimal string;
сервер валідовує Decimal із точністю до копійок і записує в чинну legacy JSON numeric convention.
Цей пакет не мігрує старе float storage і не змінює authoritative MonthlyBudget/ledger money.

409 або невідомий write ACK зберігає форму і блокує Save до явного GET/порівняння. Apply приймає
лише fresh baseline/revision + merged local draft; окремий Save робить PATCH. Latest 403/503,
malformed/інший ID, source identity drift, cancel/close/navigation/late response не приймають revision
і не гублять введення. Delete після конфлікту читає current record, Apply не видаляє, потрібне нове
підтвердження видалення. Створення і lifecycle actions не переходять на generic editing.

Inline expense amount має frozen baseline першої зміни. Категорія не змінюється оптимістично;
під час запису блокується лише відповідний рядок. Незбережені інші inline drafts лишаються після
state refresh. Поля діалогу живуть поза main rerender; reload survival не обіцяється.

Цільові команди (окрема локальна БД, жодної production/Sheet):

```sh
npm exec --workspace frontend -- vitest run --project unit src/shared/native/legacy.test.ts
npm exec --workspace frontend -- vitest run --project storybook src/shared/native/NativeConflict.stories.tsx -t 'Legacy Expense Terms'
python manage.py test tests.test_legacy_records --noinput
PYTHON_BIN=/path/to/python node tests/legacy-records-ui.cjs
QA_LEGACY_INLINE_ONLY=1 PYTHON_BIN=/path/to/python node tests/legacy-records-ui.cjs
QA_LEGACY_INPUT_ONLY=1 PYTHON_BIN=/path/to/python node tests/legacy-records-ui.cjs
QA_LEGACY_ACK_ONLY=1 PYTHON_BIN=/path/to/python node tests/legacy-records-ui.cjs
```

Native script будує лише synthetic records у власній temporary SQLite, використовує compiled shared
entry і Chrome. `QA_OUTPUT_DIR` або temporary `tsukenya-legacy-conflict-proof` містить main, inline, input та ACK reports і actual comparison 1440/320 PNG. Main proof: actual409, unrelated server changes,
atomic financial choice, no PATCH before Save, lostACK, read503/malformed/current scope, cancel/late,
fresh delete review. PG concurrency перевіряє два PATCH із одним token: рівно один200, інший409,
один audit; connection teardown явний для thread workers. Повний прогін у розробці не виконувався.


### Докази власного B06 legacy пакета

На own source: unit3 PASS, affected Storybook1 PASS, tsc/Vite build PASS; нові PG5 API сценарії
пройдені із вузькими повтореннями лише виправлених cases; PG simultaneous-token1 PASS.
Чинні task/financial/create compatibility31 cases PASS (26 незмінних успіхів + повтор5 виправлених),
runtime recovery VM PASS. Native main/inline/input/ACK targets PASS; ACK JSON null та revision array
не приймаються як success. Окреме видалення expense має одне initial confirmation. Actual PNG1440/320
переглянуті. Повтору всіх успішних перевірок після локальних boundary виправлень не було.

### Незалежне legacy інтеграційне рев’ю

Пакет первісно інтегровано поверх прийнятого #61 b49212a та перебазовано на #62 b0b92b4; entry/stories/doc sections злиті аддитивно,
Entity і WorkShift exports збережено. Root unit3/combined TypeScript/Vite build/affected lint-format PASS.
Isolated root PostgreSQL2 (0.385 s): required/stale revision/whitelist і preservation unknown metadata
в усіх трьох ресурсах; чинний scope перед token та no-audit/read-only відмова.
Root ACK-only actual native PASS: JSON null/revision array не є success і не викликають автоматичний повтор;
expense delete має одне початкове підтвердження. Доказ `/tmp/tsukenya-root-legacy-ack/ack-report.json`.
Author actual comparison1440/320 PNG переглянуто; знайдені та виправлені відступи й redundant read CTA
під час порівняння. Root changed layout/invalidApply target PASS: visible refusal до baseline/mutation,
потім valid Apply/окремий Save; 1440/320 geometry і44px. `/tmp/tsukenya-root-legacy-layout/layout-report.json`
та `layout-review-{1440,320}.png` переглянуті. Pristine close не просить підтвердження відкидання; dirty draft guard лишається.

Default `legacy-records-ui.cjs` оркеструє п’ять окремих disposable stages: main/inline/input/ACK/layout.
Для старого одного main сценарію — `QA_LEGACY_MAIN_ONLY=1`; для narrow changed state — `QA_LEGACY_LAYOUT_ONLY=1`.
Full registry має один default entry та очищає всі partial flags; у цій задачі його не запускали.
Harness прибирає inherited DB/PG/URL/require змінні, фіксує test Django settings/secret і безпечно завершує
вже закритий server process. `test:full -- --plan` тільки dry-run. Business create receipts/managed lifecycle
та MonthlyBudget залишають свої наявні контракти, private production/Sheet/VPS не використовуються.

Після перебазування на #62 повторено лише affected layout/invalidApply integration target: PASS,
`/tmp/tsukenya-root-legacy-integrated/layout-report.json` (2 writes; refusal до mutation, окремий Save,
1440/320 geometry). Злитий static loader зберігає report module й підключає legacy editor.
Незмінні API/ACK/story proofs повторно не запускалися.

Перший exact-head CI PR63 виявив чотири старі compatibility fixtures без If-Match (budget2,
managed-alert1, price-task1), що отримали428 перед своєю бізнес-перевіркою. Fixtures передають fresh
revision без послаблення server guard; status/source/owner/maximum-cent assertions збережені.
Expense numeric adapter збережено; додано valid decimal-string12.10, invalid string12.091 лишається400.
Повторено лише ці чотири affected scenarios на isolated PostgreSQL: PASS0.432 s.

Наступний exact-head CI: PostgreSQL662/0 skips та frontend PASS; server після Django виявив старий
`portal-metadata-contract.cjs` без captured revision. Фікстура тепер використовує snapshot revision32,
явно перевіряє відмову без неї та точний If-Match; попередні304/cache/GET-only/confirmed-write-barrier
assertions збережено. Повторено лише цей VM scenario: PASS; runtime/server guard не змінені.

## Поточна рецептура та нові затверджені версії (B06)

Обидва native редактори використовують один `TradeRecipeEditor` і чинний shared React
`NativeConflictComparison`. `NativeRecipeEditor` перевіряє фактичний DTO до початкової бази:
точний товар, UUID версії, номер сторінки, порядок/унікальність версій, зв’язок latest із першою
сторінкою, 64-символьну revision каталогу, право редагування, кількості, інгредієнти та
технологічну політику. Неповний або семантично неправильний запис не стає базою форми.
GET виконується у read-only snapshot із повторним читанням чинного користувача; бізнесових
записів і аудиту читання не створює.

Інгредієнти, нормативний вихід, політика придатності та її календарні дні порівнюються однією
атомарною групою. Канонічний JSON інгредієнтів є лише локальним скалярним адаптером існуючого
three-way helper; у порівнянні відображаються українські назви та кількості. Причина **нового**
затвердження незалежна; причина старої незмінної версії не підставляється як нова. Якщо
затверджених версій немає, форма зберігає попередні технічні початкові значення: вихід 1 і
невизначена технологією придатність. Це не встановлює бізнесовий норматив або строк товару.

- Поточна legacy рецептура — UPDATE `/api/erp/recipes`, із revision та підтвердженням точного
  товару в ACK. Після 409 або невизначеного результату можливе лише читання й порівняння;
  автоматичного повтору POST або нового receipt немає. Порожню поточну рецептуру можна
  зберегти лише з явним підтвердженням. Затверджені версії це не змінює.
- Затвердження `/api/erp/recipes/versions` створює незмінну версію зі стабільним UUID і frozen
  payload. Після lost ACK окрема кнопка точно повторює початкові умови, навіть якщо нові
  обов’язкові поля вже порожні. ACK має підтвердити також початкові інгредієнти, вихід,
  політику, дні та причину; одного валідного UUID недостатньо. Якщо точний повтор після
  lost ACK відхилено 4xx, це не спростовує початкове створення: frozen UUID/body збережено
  для явного читання ідентичності. Повтор POST автоматично не виконується.
- Після підтвердження початкового створення нове введення зберігається. GET за його точним UUID
  перевіряє первісну ідентичність/умови, потім GET списку читає поточні умови та `canApprove`.
  Відмова ролі, 503, malformed DTO або інший товар блокують Save без підхоплення нової revision.
  Навіть з невалідним новим введенням читання виконується; для Apply треба явно виправити поля.

Apply змінює лише локальну чернетку та її підтверджену базу; наступний Save є окремою дією.
Однакове поле потребує явного вибору. Другий 409 знову вимагає читання, а Cancel, закриття й
пізня відповідь не підхоплюють базу та не запускають наступне читання. Під час читання й
порівняння native поля заблоковані, shared choices доступні. Інший готовий товар обирається
лише з явним відкиданням незбережених умов; unresolved create не змінює ідентичність товару.

Збережені виробничі документи продовжують використовувати свої заморожені версії. Формули
собівартості, рухи запасів, політики придатності та серверні семантичні перевірки не змінено.
Життя чернетки — відкрита форма; відновлення після перезавантаження сторінки не заявляється.

Цільові команди:

```sh
npm exec --workspace frontend -- vitest run --project unit src/shared/native/recipe.test.ts
npm exec --workspace frontend -- vitest run --project storybook src/shared/native/NativeConflict.stories.tsx -t 'Recipe Terms'
python manage.py test tests.test_recipe_recovery --noinput
QA_RECIPES_FROM=conflict PYTHON_BIN=/path/to/python node tests/recipes-ui.cjs
QA_RECIPES_FROM=read PYTHON_BIN=/path/to/python node tests/recipes-ui.cjs
QA_RECIPES_FROM=validation PYTHON_BIN=/path/to/python node tests/recipes-ui.cjs
QA_RECIPES_FROM=ack PYTHON_BIN=/path/to/python node tests/recipes-ui.cjs
QA_RECIPES_FROM=role PYTHON_BIN=/path/to/python node tests/recipes-ui.cjs
QA_RECIPES_FROM=compat PYTHON_BIN=/path/to/python node tests/recipes-ui.cjs
QA_RECIPES_FROM=paging PYTHON_BIN=/path/to/python node tests/recipes-ui.cjs
# Лише missing-ID → explicit repair (не повторює решту compatibility):
QA_RECIPE_COMPAT_ONLY=1 QA_RECIPE_COMPAT_FROM=missing PYTHON_BIN=/path/to/python node tests/recipe-conflict-ui.cjs
QA_PRODUCTION_FROM=read PYTHON_BIN=/path/to/python node tests/production-ui.cjs
```

`recipes-ui.cjs` лишається єдиним recipe entrypoint повної явної перевірки; його `all` послідовно
виконує сім актуальних recovery scopes. Старі destructive reload/submit-retry та приховані
select selectors замінено фактичними контрактами й видимими ComboBox. Zoom спільних controls
перевіряється їхніми окремими UI сценаріями; цей пакет має actual keyboard/1440/320 докази.
Native сценарії створюють власну SQLite та синтетичні дані, використовують локальний Chrome.
Звіти `report.json`, `read-report.json`, `validation-report.json`, `ack-report.json`, `role-ack-report.json`, `compat-report.json`, `compat-missing-report.json` і comparison
PNG пишуться до `QA_OUTPUT_DIR` або тимчасового `tsukenya-recipe-conflict-proof`.

Авторські докази: unit 5, affected Storybook 1, нові API 3, чинні legacy GET/stale-update 2 та concurrent winner 1
пройдено на isolated PostgreSQL; native main/read/validation/ACK/role-ACK і production delayed-read
і recipe scope чинного ERP recovery harness пройдено. Вдалі результати незмінених scopes повторно використано; повного прогону не було.
1440/320 PNG переглянуто: горизонтального overflow немає, довгий діалог прокручується вертикально.

Recipe compatibility follow-up відновлює окремі фактичні native assertions попереднього
entrypoint: видалений після відкриття інгредієнт → real POST400 → збережені кількість/Save →
явний вибір іншого інгредієнта → POST200; недоступний збережений ID і його caption не
підмінюються, POST400 не змінює рецепт/аудит, після явного виправлення POST200; відхилене
очищення не робить POST і не закриває форму; confirmed POST200 із bootstrap503 пропонує
GET-only keyboard retry. Остання перевірка intercept-ить чинний `/api/v1/trading/bootstrap`,
а не застарілий `/api/erp/state`. Server/API бізнеслогіку follow-up не змінює.

## Незалежне рев’ю рецептур на accepted main #64 · 04.10.2026

Recipe source і compatibility follow-up інтегровано поверх `4e13204` зі збереженням
entity/workshift/legacy shared adapters, Storybook states, static loaders і reports UI.
Root review відтворило суперечливу пагінацію (`total=17`, `pages=999`, один item):
тепер decoder перевіряє requested page/limit, число сторінок та точну кількість елементів.
Actual native `paging` відмовляє початковій базі без POST; явне коректне GET читання
дозволяє окреме затвердження рівно однієї версії.

Root targeted unit PASS: шість постійних cases плюс тимчасовий reproduction, який після
внесення постійного equivalent case видалено. Combined TypeScript/Vite build, affected
lint/format та isolated PostgreSQL два current-actor/legacy ACK-stale сценарії PASS.
Авторські незмінені докази API/concurrency/story/native перевикористано; compatibility
reports звірено з assertions видалення/repair, missing-ID, clear refusal і GET-only refresh.

Actual root layout scope PASS, PNG 1440/320 переглянуто: на телефоні інгредієнт займає
весь рядок, кількість і кнопка видалення розміщені нижче; overflow немає. Готове comparison
не показує дубльованого read/cancel CTA, pending read можна скасувати. Harness очищає
успадковані DB/PG налаштування, задає isolated settings/secret, ловить ранній вихід сервера
та очікує teardown. Один full entrypoint зберігається, partial recipe flags очищаються.
Виконано лише `test:full -- --plan`, не повну регресію, не production/Sheet тести або deployment.
## Бюджетний орієнтир: окрема кількість магазинів

Count має незалежну від Label Studio revision, strict readonly policy DTO та actual native shared comparison. Legacy settings writes не обходять token; Apply лише локально, Save окремий. Деталі API/меж і targeted proofs — [BUDGET-TEMPLATE-RECOVERY.md](BUDGET-TEMPLATE-RECOVERY.md). Місячні плани й статті залишаються наступним окремим пакетом.
