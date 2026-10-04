# B02: магазин власника та старі мережеві фінанси

## Підтверджене відтворення

На baseline `origin/main` `3ff7855` ізольований користувач `role=owner`, `profile.store_id=A` отримував:

- `GET /api/state`: усі `expenses/*` (синтетична мережна оренда 15 000 грн), `settings/main.budgetStores`, `stores` і невідомий приватний `privateFuture.plan`; також системну задачу `due:*` магазину B із сумою боргу.
- `PATCH /api/docs/expenses/network-rent` та `PATCH /api/docs/settings/main` з `budgetStores`: 200 і зміну мережевих даних.
- `GET /api/erp/audit`: 200, включно з фінансовими `before/after`. Саме приховування старого бюджету залишало цей обхід читання.
- `GET /api/erp/budget-fact`: 200, хоча старий план є мережевим і не має ідентичності ERP-магазину.

Відтворення виконано до виправлення лише на синтетичній базі. Джерела: `views.legacy_state` / `legacy_mutation`, `legacy_settings.settings_for_role`, `financial_browsing.audit_events`, `budget.budget_fact`, ранній owner bypass у `task_scope.task_visible`.

## Серверна межа

`financial_scope.network_owner` означає власника без `profile.store_id`. Legacy `expenses/*` є старим мережевим планом: довільне поле `store` у JSON не перетворює його на бюджет конкретного магазину.

| Дані / дія | Власник мережі | Власник магазину | Керівник |
| --- | --- | --- | --- |
| Legacy expenses: читання, POST / PUT / PATCH / DELETE | Чинний доступ | Порожній список / 403 для запису | Порожній список / 403 |
| Legacy budget-fact | Чинний доступ | 403 | 403 |
| Глобальний журнал аудиту | Чинний доступ | 403 | 403 |
| Settings: бюджетні й невідомі приватні ключі | Чинний доступ | Не повертаються; зміна 403 | Не повертаються; зміна 403 |
| Спільні цінники, ідентичність, каталог та керування цінами | Чинний доступ | Чинний доступ | Чинні рольові правила |
| Збережений місячний бюджет B16 власного ERP-магазину | Чинний доступ | Чинний доступ власного магазину | Чинна заборона бюджету |

Глобальний legacy audit не має надійного структурного scope для кожної старої події. Тому для власника магазину він заборонений цілком, а не фільтрується за текстом subject або автора.

Для scoped owner `settings/main` повертає тільки `tag`, `chainName`, `storeNames`, `staleDays`, `defaultMarkup`, `rounding`, `gsId`, `gsTitle`, `gsUrl`, `gsSheetName`. Це спільний каталог і налаштування друку, а не мережеві фінанси. DTO для інших ролей зберігає попередні allowlists; network owner отримує повний документ.

Ключі PUT/PATCH перевіряються **до** merge з прихованими налаштуваннями. PUT scoped owner зберігає приховані ключі, а не видаляє їх через редагування скороченого DTO; DELETE settings заборонений. Зміна назв для цінників зберігає стару кількість бюджетних магазинів через чинний `freeze_budget` — без зміни семантичного бюджету. Правила версії макета та окремого preview/commit масової зміни цін залишаються чинними; direct legacy PATCH націнки, який уже вимагав цінового preview, не дозволяється заново.

Expense create/replay перевіряє поточний мережевий scope до читання `LegacyCreateReceipt`: точний повтор після обмеження користувача магазином теж отримує 403. Заборонений запит не створює документ, receipt або audit.

`task_scope.financial_task_in_scope` перевіряє `due:*` за магазином до owner bypass і застосовується також до редагування та permissions. Scoped owner бачить і змінює статус лише свого боргового alert; чужі та мережеві боргові alert приховано. Manual/development task policy й системне формування/закриття alert не змінюються. Нові фінансові типи alert повинні явно розширити цей helper.

## Сумісність UI

Форма `/api/state` зберігає старі `data`, `csrf`, `role`, `labelRevision`; додано `networkOwner:boolean`. `/api/erp/state` додає `canViewAudit:boolean`. ERP показує кнопку журналу тільки при явному `true`, невідоме або відсутнє значення не дозволяє дію. Серверні guards діють незалежно від браузерних прапорців. B16 окремо визначає магазин через валідований promotions context і приховує каталогну бюджетну вкладку для scoped owner.

GET не змінює Documents, settings або audit. Загальний каталог, поточна ціна магазину, labels workspace та HMAC версії макета залишаються сумісними. Перевірено створення місячного бюджету власного магазину, заборону foreign/network читання, label save і масовий price preview/commit зі збереженням прихованих бюджетних ключів.

Цей патч не переглядає всі глобальні адміністративні можливості власника (користувачі, фіскальна політика, закриття періоду, мережеві довідники) і не змінює ручні development-задачі. Для них потрібна окрема визначена політика; вони не використовуються як доказ повного аудиту доступу всього порталу.

## Цільові перевірки

- Початкове синтетичне відтворення: 1 SQLite тест PASS до патча.
- Нові checks: 10 сценаріїв `tests/test_legacy_financial_scope.py` (роль/магазин, read DTO без записів, усі legacy write methods, replay після scope revoke, приховані поля PUT, HMAC conflict, fallback кількості, due-task scope, network/manager контракт, B16 та спільні labels/pricing).
- PostgreSQL: 14 сценаріїв PASS у спільному цільовому запуску; один місячний HTTP snapshot сценарій потребував `TransactionTestCase` замість `TestCase`, його окремий повтор PASS. Код snapshot не послаблювався для тестів.
- `node tests/financial-scope-ui.cjs`: реальний production renderer приховує журнал при false/missing/null, показує при true і зберігає керування цінами власника; PASS.
- `node --check app/erp.js`, `git diff --check`: PASS.

Повну регресію, production, VPS, резервні копії й спільну Google-таблицю не використовували.

Root після інтеграції B10/B12/B16/B18 перевірив4 цільові PG сценарії: мережевий scope після ledger wait, приватні settings write/delete, скорочений PUT з HMAC, власний monthly budget і shared labels/pricing — PASS. Renderer proof повторно перевірено на інтегрованому app/erp.js, PASS. Mutation повторно читає активність і profile після ledger lock; зміна scope під час очікування не використовує застарілий owner bypass. Pure renderer зареєстровано у quick CI та явній test:full, без запуску повного набору.
