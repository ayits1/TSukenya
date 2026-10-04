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
| 6 | `app/portal.js` tasks/ideas/expenses | Create вже має exact immutable receipt. Для legacy edit немає record If-Match contract: спочатку серверна версія/read DTO, потім shared review |

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
