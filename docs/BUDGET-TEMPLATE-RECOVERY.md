# Версія кількості магазинів у бюджетному орієнтирі

Кількість для «Орієнтира за каталогом» незалежна від ERP-магазинів та ідентичності цінників. Формула орієнтира й legacy порядок визначення кількості не змінені: валідний budgetStores → stores integer → довжина stores/storeNames → 1.

## Контракт

GET `/api/v1/portal/budget-template` повертає `{resource:"budget-template",budgetStores,revision,source,canEdit:true}`. Кількість — integer 1..1000, revision — 64 hex, source — explicit або legacy. GET нічого не записує; відсутні/старі налаштування лише обчислюють значення. Доступ виключно чинному власнику без обмеження магазину; відсутній доступ — 403, а не підставлені права чи значення.

PATCH передає тільки `{budgetStores,revision}`. Після ledger lock сервер заново перевіряє active/profile/network scope, звіряє revision і змінює лише budgetStores. Відсутня версія — 428, стара — 409; неправильні поля/типи — 400. Audit містить лише count before/after, observed revision та стандартний request context. Повтор запису вже збереженого explicit count не робить додаткового audit/write.

Revision — відбиток effective count та ідентичності цього ресурсу. Legacy → explicit із тією самою кількістю описує те саме редаговане значення. Нова назва цінника чи ERP-магазину не змінює token кількості. Label Studio token не змінено, бюджетний count до нього не додано.

Legacy `/api/docs/settings/main` не є обходом: explicit budgetStores у PUT/PATCH та DELETE потребують `X-Budget-Template-Revision`. Scoped owner спочатку проходить чинний allowlist (йому count недоступний). Якщо legacy PUT/PATCH не передає count, збережене/виведене попереднє значення фіксується за чинним freeze правилом; заміна identity не скидає кількість.

Для штатного редагування count використовуйте окремий PATCH endpoint із його незалежною revision. Штатний runtime передає label token у `If-Match` для legacy налаштувань. Чинна legacy сумісність збережена: label revision перевіряється лише за наявності `If-Match`; API не вимагає цього заголовка. Для змішаного label+count legacy запису `X-Budget-Template-Revision` обов’язковий, а переданий незалежний `If-Match` додатково захищає макет від застарілого запису. Відсутній `If-Match` не блокує такий legacy запит, тому обов’язкової перевірки обох tokens цей шлях не гарантує.

## Робочий native інтерфейс

У вкладці «Орієнтир за каталогом» count лише показано, кнопка «Змінити кількість» відкриває окремий редактор. До успішного strict GET введення/Save недоступні. Initial baseline/revision не підміняються portal poll. Діалог живе окремо від portal redraw.

Save явний. 409/403/428 або невідомий результат запису залишають введення та блокують Save до readonly актуального читання й узгодження. GET503, неправильний DTO, скасований чи запізнілий GET не приймають revision. Порівняння використовує existing `NativeConflictComparison`/threeWay, без власного merge algorithm. Apply тільки змінює локальний draft і baseline; окремий Save повторно перевіряє revision. Під час review поле заблоковано. Cancel зберігає чернетку. Після підтвердженого Save наступний metadata GET503 дає штатний GET-only retry, не повтор PATCH.

Закриття/навігація з dirty draft потребує явного відкидання. Під час PATCH закриття блокується. Reload не відновлює відкриту чернетку — чинна B06 межа, persistence не додавалась. Місячні бюджети, їх категорії, legacy витрати, Google sync та облікові проведення не змінені.

## Цільові докази

- `tests/test_budget_template.py`: readonly inference/default; independent label token; preservation/audit/no-op; malformed/stale/second conflict; legacy bypass/PUT omission; поточні ролі/store та відкликання під час ledger wait; PostgreSQL два спостережені клієнти → один winner.
- Зачеплені старі BudgetTests та financial-scope/audit fixtures передають template token явно.
- `budgetTemplate.test.ts`: strict policy/resource DTO, явний вибір same field, whitelist.
- `BudgetTemplateConflict.stories.tsx`: keyboard tab/arrow/Apply.
- `tests/budget-template-ui.cjs`: actual delayed openingGET; 409→GET503→explicit Apply; second409; фактичний committed PATCH зі зіпсованим ACK→GET-only; cancel/late; 403/malformed/latest; comparison Cancel; confirmedSave→metadata503→GET-only. Синтетична SQLite, 1440/320 і viewport PNG.

Для вузького продовження harness підтримує `TEMPLATE_STAGE=recovery` (друга фаза) та `TEMPLATE_STAGE=layout` (перша фаза/PNG). Повний штатний entry без змінної проходить обидві. `TEMPLATE_PROOF_DIR` задає артефакти, `PYTHON_BIN` — isolated runtime. Harness видаляє DB_/PG*/production settings та створює одноразову локальну БД. PostgreSQL targets використовують окрему локальну QA базу; це не production/SLA доказ.
