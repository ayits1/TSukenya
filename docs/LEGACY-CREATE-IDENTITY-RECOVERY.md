# B06: початкове створення задач, ідей і статей витрат

## Контракт і межа

Django `LegacyCreateReceipt` зберігає UUID, автора, колекцію, fingerprint запиту та створеного документа. Міграція `0021_legacy_create_original_snapshot` залежить від `0020_entity_create_receipts` і додає nullable `original`: лише дозволені редаговані поля й серверні metadata. Історичні квитанції не доповнюються вигаданими полями. Паролі, session, CSRF, gsBase і довільні вкладені payload не повертаються.

`GET /api/v1/portal/create-identity?collection=tasks|ideas|expenses&createKey=…` читає receipt та поточний документ в одному PostgreSQL REPEATABLE READ READ ONLY snapshot. Поточний active actor, роль, автор, resource й початковий/поточний task store scope перевіряються перед відповіддю. Витрати доступні лише чинному network owner. Читання не записує audit, receipt чи документ. Nested транзакція з несумісним snapshot відхиляється.

Відповідь має `confirmed:false` або `id`, `state:unchanged|changed|deleted`, nullable `original` і `current`. Видалена первинна identity залишається видаленою навіть після повторного використання document ID. В історичній квитанції без snapshot bound manager, а також будь-який manager для видаленого запису, отримує відмову: початковий scope неможливо довести. Автор owner може прочитати дозволену identity, але `original:null` не дає baseline для порівняння.

Звичайний та replay CREATE ACK містять `collection/createKey/id/original`. Runtime перевіряє ресурс, UUID, ID, semantic DTO й усі передані початкові поля (включно нормалізованою назвою/Decimal витрати). Lookup так само звіряє початковий snapshot із frozen request до підтвердження identity. Contract описано окремо в `contracts/portal.openapi.json`.

## Фактичний UI

Поточні задачі, задачі розвитку, ідеї, статті витрат та «ідея → задача» використовують immutable first intent. Після невідомого ACK звичайне створення заблоковане. Окремий `type=button` «Повторити початковий запит» передає перший body/UUID незалежно від нової порожньої назви. Пізніша відмова 4xx не доводить, що початковий запис не відбувся, тому intent залишається.

«Перевірити початкове створення» виконує лише GET. Підтверджений ID зберігається незалежно від подальших GET503/403; підтверджений CREATE повторно не виконується. Новіші поля залишаються. Busy/cancel/AbortController/generation/hash fence не дають пізньому читанню відкрити чужу форму. Повторне читання скидає дозвіл на старе порівняння до нової перевіреної відповіді; current403 не залишає доступною стару comparison CTA.

«Узгодити новіші зміни» відкриває чинний `LegacyEditors` зі snapshot початкового створення та новішою чернеткою. GET поточного record, спільний `NativeConflictComparison`/three-way, явний Apply до локальної baseline і окремий PATCH Save з поточною revision залишаються тим самим механізмом. Financial terms витрати — atomic група сума/група/категорія. ID з receipt не стає Save revision. Managed/linked/deleted/current readonly records не пропонують цей editor.

«Завершити відновлення» потребує явного підтвердження після identity lookup й залишає новіші поля для окремої дії. Звичайний підтверджений create без новішого введення зберігає звичне очищення форми. Existing unavailable retry повторює той самий body/key; Artifact runtime гілка зберігає попередній контракт.

## Цільові докази

- PostgreSQL: `tests.test_legacy_create_identity` — шість сценаріїв: snapshot states/tombstone reused ID; cached actor/original scope/historical unknown; author/resource/current private expense/is_active; whitelist/cache/query; real RR/READONLY/nested guard; два concurrent exact retries → один receipt/document/audit. Перший прогін: чотири PASS, два fixture-only виправлення (повторний login session та middleware Cache-Control); повторено лише ті два. Доданий unscoped manager/deleted historical guard перевірено повтором лише відповідного case.
- VM: `runtime-create-key.cjs`, `runtime-recovery.cjs`, `legacy-create-identity.cjs`, `portal-metadata-contract.cjs` — PASS. Fixtures ACK адаптовано до реального нового контракту; незмінені PATCH/DELETE/refresh сценарії збережено.
- Actual isolated Django + installed native Chrome: `legacy-create-identity-ui.cjs` primary/tail/layout/boundary — PASS. Default entry `runtime-create-key-ui.cjs` викликає ці чотири стадії, замінюючи старе «натиснути Add ще раз» після lost ACK.
- Primary: чотири фактичні inline форми, invalid newer title, exact body/key, GET-only identity, lost ACK→403, idea-task deleted409/no resurrection. Після fixture-only відсутнього If-Match idea-task tail відновлено окремо; final resource whitelist/intent binding має повний matching primary report без partial flags.
- Tail: GET503/cancel lateGET, original/mine/server comparison, server independent due date, Apply без PATCH, separate Save; current scoped-owner private-expense403.
- Boundary: automatic unavailable exact retry compatibility; wrong original terms refusal до ID/baseline; hash-navigation lateGET; confirmed identity→new current403 ховає старий comparison permission, зберігає ID/чернетку, не повторює CREATE.
- Layout: actual receipt controls/shared comparison 1440/320, 44px labels/buttons, keyboard choice/Apply/cancel, без horizontal overflow. PNG переглянуті. Перша layout помилка — locator на прихованому radio parent замість clickable label; виправлено лише fixture. Receipt screenshot оновлено після зникнення transient toast, окремий controls screenshot показує нижню частину scrollable modal.
- Frontend build/schema drift/node syntax/diff check — PASS. React/shared control source у цьому пакеті незмінний; чинні `LegacyExpenseTerms`/three-way stories й попередній unit proof перевикористано, фактичне нове composition перевірено native keyboard/layout.

Артефакти локально: `/tmp/tsukenya-legacy-create-proof/{primary,tail,layout,boundary}-report.json`, `receipt-1440.png`, `receipt-320.png`, `comparison-1440.png`, `comparison-320.png`, `comparison-controls-320.png`. Ранні failure artifacts збережені окремо; final reports не є full regression.

Для майбутнього явного full entrypoint очистити `LEGACY_CREATE_STAGE` і `LEGACY_CREATE_FROM`. Власна dependency QA ancestry містить entity0020 та accepted recipe65; доставляються лише власні legacy commits, а не dependency merge.

## Межі перевірки

Intent зберігається лише в пам’яті вкладки; persistence після reload залишається окремою відкладеною роботою. Це не нова фінансова формула, lifecycle проєктів або зміна accounting. Full suite, screen reader, production/Google Sheet, VPS, backup і deployment не запускалися.


## Root інтеграція

Доставлено лише три власні commits поверх прийнятого main #68; dependency merge не перенесено.
Конфлікт portal.openapi.json розв’язано як додавання нових paths/schema: чинний budget-template
GET/PATCH і його схеми збережені. Усі локальні $ref перевірені. Backend snapshot/tests та
runtime/ACK/shared legacy adapter збігаються з перевіреним delivery; portal.js має лише
прийняті незалежні template зміни. Root PostgreSQL 2 PASS (0.438s): початковий магазин,
історична unknown identity/current actor і справжній READ ONLY snapshot/nested guard.
Root VM runtime-create-key/runtime-recovery/legacy-create-identity/portal-metadata-contract PASS.

Майбутній explicit full entrypoint містить один wrapper чотирьох native stages і standalone
identity unit; очищає LEGACY_CREATE_STAGE/FROM. Перевірено лише --plan, не full.
Harness задає ізольований Django settings до password helper, прибирає DB/PG/URL й
успадковані owner credentials, перевіряє ранній exit; teardown очікує власний процес.
Actual native layout root на зведеному коді PASS:1440/320, клавіатура/44px/no overflow, Apply без PATCH.
Артефакт `/tmp/tsukenya-root-legacy-create/layout-report.json`; receipt320 PNG переглянуто.
