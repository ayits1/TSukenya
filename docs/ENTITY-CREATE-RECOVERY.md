# B06 · підтвердження створення довідників

## Межа

Фактичний `entityForm` в `app/erp.js`: магазини, склади, рахунки, працівники, контрагенти. Існуюче редагування продовжує вимагати revision. Умови оплати працівника узгоджуються одним блоком; магазин і тип підтвердженого запису незмінні. Історичні табелі, нарахування, проведення й формули не змінюються.

Перший CREATE фіксує UUID і нормалізовані поля. Окрема кнопка типу `button` повторює саме їх, навіть коли новіші поля невалідні. Після невідомого результату 400/403/409 не доводять, що початковий запис відсутній: intent зберігається, звичайне збереження заблоковане. Початкова однозначна помилка валідації дозволяє виправити форму й сформувати новий запит.

## Сервер і контракт

- `EntityCreateReceipt`, міграція `0020_entity_create_receipts` після `0019_service_heartbeats`: UUID, автор, ресурс, початковий ID/магазин, fingerprint нормалізованих полів, незмінний початковий DTO. Це не FK до редагованого запису: receipt переживає його видалення.
- `POST /api/erp/entities/{type}` з `idempotency_key`: ledger lock → актуальний активний actor/роль/магазин → нормалізація → receipt → звичайна атомарна бізнес-операція. Повтор після редагування або видалення повертає початкове підтвердження без нового запису чи аудиту. Інший автор, ресурс або зміст дають 409 `idempotency_conflict`; CREATE UUID разом з UPDATE ID також відхиляється.
- Нові магазини як і раніше створює лише власник мережі. Контрагенти лишаються спільними. Загальних нових заборон для неактивних довідників немає. API без ключа зберігає попередню сумісність.
- `POST /api/v1/trading/entities/{type}/identity` з `{request: frozenBody}` — CSRF-захищене читання в реальному READ ONLY REPEATABLE READ. Перевіряє поточну роль/магазин/активність, автора, ресурс і fingerprint. Відсутність receipt не звільняє intent. Видалений початковий запис підтверджується з `exists:false`, без відновлення.
- Авторизоване читання поточного запису використовує actual directory `details` з `purpose:manage`; actor перечитується всередині того самого snapshot. Відкликана роль не отримує навіть початкові приватні ставки працівника.
- Адитивний OpenAPI — `contracts/trading.openapi.json`, типи — `trading.generated.ts`. Строгі runtime-декодери перевіряють UUID/ресурс/ID та всі нормалізовані початкові поля, типи, ставку/відсоток, immutable identity й стан відповіді. Каталоговий контракт не змінюється.

## Відновлення в UI

Підтверджений ID фіксується перед читанням поточного запису. Після підтвердження CREATE більше не повторюється; збій поточного читання має окрему кнопку читання. Новіші невалідні поля не блокують identity або поточне читання. Ці читання зберігають поля й не приймають актуальну revision як baseline.

Порівняння використовує чинні `NativeConflictComparison`/three-way helper: початковий receipt, моя новіша чернетка, актуальний сервер. Лише явне «Застосувати узгоджені зміни» приймає прочитаний baseline у локальній чернетці. POST не виконується; «Зберегти» — окрема дія. Наступний 409 знову вимагає порівняння. Abort/generation/dialog fences відхиляють запізніле читання після скасування, закриття або навігації.

## Перевірки · 04.10.2026

- Ізольована PostgreSQL 18: **7 цільових сценаріїв** у `tests/test_entity_create_receipts.py`, з повтором лише виправленого endpoint case та посиленого UUID+ID collision case. Нормалізований retry після edit/delete, author/resource/body collision без записів/аудиту, cached role/store/is_active, усі ресурси + no-key compatibility, CSRF/readonly/nested-RR guard, три конкурентні exact retries й зміна ролі під час ledger wait, cached private-policy у selected manage read. Успіхи з незмінними inputs повторно не запускались.
- Unit: `entity.test.ts` **6 PASS**; нова Storybook `Entity Create Original Receipt` **1 PASS** (решта 5 stories не запускались); build/types, змінені ESLint/Prettier, Node syntax, `makemigrations --check`, `git diff --check` PASS.
- Actual isolated Django + native Chrome: `tests/entity-create-recovery-ui.cjs`, три окремі групи **primary/tail/layout PASS**. Артефакти `/tmp/tsukenya-entity-create-proof/report.json`, `tail-report.json`, `layout-report.json`.
  - primary: усі п’ять CREATE форм; actual committed/lostACK → frozen retry після current-role403 → identity403/503/read-only retry; invalid newer draft; confirmed ID + manage503/current403; atomic payroll comparison/Apply без POST/separate UPDATE/second409; wrong-terms ACK; видалений початковий запис.
  - tail: успішний exact retry з порожньою новішою required назвою; confirmed ID після manage503; GET-only retry; cancel metadata read; closed/navigated late identity.
  - layout: фокусований actual payroll choice на 320/1440, label щонайменше 44 px у видимих межах dialog/viewport, відсутність горизонтального overflow, Space/Enter та повернення фокуса до Save. Переглянуто `employee-choice-320.png` і `employee-choice-1440.png`. Попередні `employee-original-comparison-*` були знімками верхньої частини довгого порівняння, тому доказом видимих radio є саме `employee-choice-*`.

Відтворення native: `PYTHON_BIN=/path/to/isolated/python node tests/entity-create-recovery-ui.cjs`. Без `ENTITY_CREATE_STAGE` послідовно запускаються всі три групи; для вузького повтору задається `primary`, `tail` або `layout`. Скрипт очищує успадковані DB/PG variables, створює власну SQLite базу й видаляє її після групи. PostgreSQL сценарії запускаються окремо в ізольованій тестовій базі.

## Межі доказу

Intent зберігається в пам’яті відкритої форми; перезавантаження браузера не має durable local draft/UUID persistence. Серверний receipt незмінний і зберігається. Немає full regression, VPS, production/Sheet mutation, load-capacity чи screen-reader claims. Старі UPDATE recovery fixtures не переписані під новий CREATE контракт; доданий цільовий script охоплює CREATE й наступний explicit UPDATE у фактичній формі. Реєстрація script у загальному explicit full entrypoint належить інтеграції root.

## Root integration · 04.10.2026

Source1ad4c318 зведено поверх accepted main66 зі збереженням voucher/recipe/legacy/workshift exports, story states та static loaders. Незалежне read-only source review receipt/current-policy/UUID+ID/native intent blockers не знайшло. Неблокуюча UX межа: exact replay вже видаленого original підтвердить ID, а поточне manage читання відмовить; явне «видалено» доступне через readonly identity. No resurrection/Save bypass.

Root combined TypeScript/Vite build, affected stories lint/format, node syntax/diff PASS. Два інтегровані PostgreSQL18 targets identity RR/READONLY/CSRF та current private-policy у manage snapshot — PASS (0.345s). Actual layout stage після integration — PASS: frozen employee create retry, shared payroll choice1440/320, label44/visible bounds, Space/Enter localApply безPOST та focusSave. Proof `/tmp/tsukenya-root-entity-create/layout-report.json`; `employee-choice-320.png` переглянуто. Решту matching author7PG/6unit/Story1/native primary/tail доказів reused; не заявляється новий all run.

Harness pins isolated Django settings/secret, видаляє DB_/PG*/DATABASE_URL, ловить ранній server exit і очікує teardown. Один full entrypoint запускає штатні primary/tail/layout, очищає ENTITY_CREATE_STAGE та common QA output/port flags. `test:full -- --plan` тільки dry-run, full local regression/VPS не виконані.

Перед PR пакет перенесено на accepted main67 `301cdd0`. Rebase зберіг entity source/DTO/controllers; конфлікти були лише audit append і independent full flags. Combined build із budget-template+entity+recipe+voucher exports PASS; registry syntax/dry-run PASS. Успішні unchanged entity API/native proofs повторно не запускали.
