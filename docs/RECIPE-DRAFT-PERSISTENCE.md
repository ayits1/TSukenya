# B06 P1: чернетки двох редакторів рецептур · 05.10.2026

## Реальна інтеграція

Підключено `recipe-editor.js:open(mode=legacy)` (чинний `erp.js:recipeForm`) і
`erp-production.js:recipeForm` (`mode=version`) через спільний P0 codec
`NativeRecipePersistence` та `TradeRecipePersistence`. Виробничий voucher editor
`erp-production.js:attach`, його frozen terms, собівартість, posting і allocations
не змінювалися.

Whitelist зберігає лише вибраний product ID, до100 впорядкованих компонентів зі
стабільними row UUID, сирі кількості/вихід/строк/причину, original unit/catalog
revision/latest-version/projection, початкові method/path/key/body та підтвердження.
Незавершені рядки `1e-`, `-`, `1.` і порожні required поля не проходять Save-validator,
але зберігаються після reload. Кількості використовують text+decimal inputmode,
щоб браузер не втратив незавершене введення. Назви компонентів перечитуються через
наявний довідник; повний каталог, credentials, policy grants і production results
не серіалізуються. Спільні P0 byte/node/record limits діють без truncate/eviction.

Capture синхронний на input/change та programmatic add/remove/select/Apply.
Quota блокує send, зберігаючи попередній durable record. Restore — явна кнопка
«Локальні чернетки», після fresh session/resource policy; з іншого розділу чекає
реального stock mount. Cancel/route/late responses не вставляють приватну форму.
Warm focus виконує authorization-only read, не повторний Restore. 503 залишає
нейтральний public gate; role/session loss приховує body/footer/heading.

## Різні контракти запису

- **Legacy UPDATE:** frozen original revision/body зберігається перед POST.
  Unknown/reload ніколи не повторює UPDATE автоматично чи кнопкою exact retry.
  Current GET → явне порівняння/Apply → окремий Save з новою revision.
- **Approved CREATE:** перший UUID/body незмінний, newer raw зберігається окремо.
  Exact retry — type=button, не валідовує нове введення. Identity reader звіряє
  автора та точний request fingerprint з immutable RecipeVersion.
- ACK записує durable confirmation до наступного читання. Поточний GET503/reload
  залишає read barrier: нового POST немає. UUID identity не стає поточною baseline.
  Коли введення вже підтверджене поточним читанням, record прибирається; новіші поля
  потребують Apply/Save. Наступне затвердження отримує новий UUID лише після Apply.
- Нова approved version не переприв’язує стару локальну baseline під час Restore.
  Явний Apply current version змінює тільки локальний редактор.
- Перший live version400/revision409 може звільнити intent тільки за bound server
  `write_rejected` proof після rollback. Після unknown/reload будь-який later4xx,
  навіть з таким proof, залишає первісний намір. `confirmed:false` не є доказом
  для очищення intent; idempotency/permission/commit/serialization failures proof
  не отримують. Legacy має current GET/Apply шлях замість такого proof.

## Серверна межа

`GET /api/erp/recipes/recovery-context?mode=legacy|version&product=ID` повертає
mode/product/role/storeId/networkOwner/canWrite/exists у READ ONLY REPEATABLE READ
після current_actor. Порожній product дозволяє пусту форму. Відсутній/прихований
product не підміняється; false canWrite не стирає локальне введення. Role policy
legacy: owner/manager/warehouse; version: owner/manager. Global рецептура не
отримує вигаданого store/period обмеження. Читаються тільки pk+hidden projection.

`POST /api/erp/recipes/versions/identity` — read-only `{request: frozenBody}`,
повертає `{confirmed,key,product,original?}`. Creator+exact existing fingerprint
перевіряються незалежно від current product/latest version; немає adoption tokens,
нових моделей чи міграцій. Domain writes та accounting calculations незмінні.

## Цільові докази

- Backend PG: 5 context/identity/privacy/RR/no-write PASS; affected scalar context
  follow-up1 PASS; rejection proof3 + existing concurrent approval1 PASS.
  `/tmp/tsukenya-recipe-drafts-pg.log`, `...-context-pg.log`,
  `/tmp/tsukenya-recipe-rejection-pg.log`. Власні test DB видалені runner.
- Codec: initial6 PASS + новий bound rejection test1 PASS; попередні6 після
  незалежного additive rejected branch не повторювали. TypeScript, цільовий lint,
  matching Vite build, JS syntax та diff check PASS.
- Actual native harness: `tests/recipe-draft-reload-ui.cjs`, окремі terminal scopes
  raw, legacy, version, privacy, cold, validation, confirmed, frozen, guards PASS.
  Власний localhost18279/SQLite, bundled Chromium `headless:true`, без системного
  Chrome. Кожен запуск прибирає сервер/браузер/тимчасову базу у finally.
- raw: обидва реальні редактори, invalid strings/порядок/stable UUID після reload,
  Enter Restore, Save заблокований до review, 1440/320 без overflow, no POST.
- legacy: committed/lostACK + remote edit → reload → currentGET/explicit mine
  Apply → окремий Save; confirmedACK/current503/reload → GET-only cleanup.
- version: committed/lostACK/reload + newer invalid → exact later400 → samebody
  exact success → confirmed503/reload; одна версія, потім явний Apply/newUUID.
- validation: actual firstrevision409 proof → currentGET/Apply/newSave; після
  ambiguity/reload пізніший boundproof не звільняє intent.
- frozen: паралельна новіша approved version не підміняє original UUID/введення;
  тільки explicit Apply приймає latest ID, без POST.
- privacy/guards: quota/no send; warm503 hide+public retry; actual role loss та
  canApprove=false після дозволеного preflight приховують/очищають private draft;
  ordinary delayed opening після route change відхиляється.
- cold: overview→stock actual mount, cancel→late bootstrap не відкриває форму.

Артефакти: `/tmp/tsukenya-recipe-reload-proof/*-report.json`, raw PNG1440/320
обох редакторів. Approved320 і legacy1440 переглянуто. Перші спроби legacy/version
зупинилися на очікуванні harness до React Apply mount / проміжного privacy hide;
виправлено лише очікування й повторено відповідний scope. Privacy fixture тепер
приймає повне закриття редактора після role loss як допустиме приховування.

```sh
PYTHON_BIN=/tmp/tsukenya-review-venv/bin/python \
QA_RECIPE_DRAFT_FROM=version node tests/recipe-draft-reload-ui.cjs
```

Результат обмежений тією самою вкладкою/чинним сеансом. Screen readers, WebKit,
закриття вкладки, cross-device і capacity не перевірені. Повний прогін, production,
Google Sheet, push/PR/deploy та backup0.1 цей пакет не виконував. Інші B06 P1/P2/P3
сім’ї не оголошуються завершеними.
