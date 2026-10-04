# B24: scoped conditional polling

Baseline: main `9c04dad2b48ac59b1b544ec44e4857e273147de6`. Вузький наступний етап після voucher-list batch fix; бухгалтерські формули й LedgerLock не змінено.

## Контракт

`GET /api/state` лишає `data`, `csrf`, `role`, `networkOwner`, `labelRevision`. Standalone 200 додає `ETag: "tsukenya-state-v1-<HMAC>"` і `stateVersions` з opaque hashes доменів `products`, `references`, `tasks`, `ideas`, `expenses`, `settings/main`, `project/state`.

Клієнт надсилає точний `If-None-Match`; незмінний стан повертає порожній 304 з тим самим ETag. `Vary: Cookie` та чинний `Cache-Control: no-store` зберігаються: кеш snapshot веде адаптер, HTTP shared cache не використовується. Авторизація/активність/строк сеансу перевіряються до validator. HMAC включає user ID, роль, scope магазину, CSRF і Київську дату; чужий validator не дозволяє використати старі права/магазин. Немає публічного глобального audit sequence.

200 і validator отримуються в одній `REPEATABLE READ, READ ONLY` транзакції PostgreSQL. Cheap 304 — окреме авторизоване читання register, без сканування товарів. Якщо endpoint викликано всередині наявної caller transaction без RR/RO, лишається legacy 200 **без ETag/stateVersions**, щоб не обіцяти консистентність такого caller; це явний загальний fallback, а не визначення test runtime. Caller з RR/RO може використовувати validator. GET ніколи не створює register rows.

Стабільні path/PK ordering і sorted JSON keys зберігають strong validator при фізичних no-op UPDATE. Trigger порівнює canonical JSON spelling, а не тільки jsonb numeric equality: `1`→`1.0` може змінити DTO/revision і має інвалідувати кеш.

## SQL invalidation / selection map

Міграція `0015_state_versions` → `0014_managed_alerts`. `StateVersion(key, revision)` змінюють транзакційні row triggers. Вони охоплюють create/edit/delete, QuerySet update, bulk_create/bulk_update, прямі SQL writes і bootstrap. Тригери враховують стару й нову видимість; UPSERT створює відсутню row без lost increment, rollback відкочує й counter. Внутрішні ключі/значення не повертаються клієнту. Для SQLite QA та нових worker connections зареєстровано equivalent key callback; writes виконує SQL trigger.

| Джерело | Внутрішні ключі | Хто обирає їх у register SELECT |
| --- | --- | --- |
| Document `products/*` | catalog | Усі ролі: serializer/revision/effective prices каталогу |
| Document `catalog_refs/*` | references | Усі ролі; повідомлення React довідникам |
| settings tag/chainName/storeNames/staleDays | labels | Усі; точна чинна PUBLIC_SETTINGS проєкція |
| settings defaultMarkup/rounding | pricing | Усі для effective prices; у settings domain — лише ролі, які бачать ці поля |
| settings gsId/gsTitle/gsUrl/gsSheetName | owner_sync | Власники, включно зі scoped owner, відповідно до чинного allowlist |
| Інші settings поля; expenses/* | private_settings; expenses | Лише network owner |
| project/state | project_state | Власники: чинний owner DTO, без зміни політики |
| Manual/other non-due tasks | owner_tasks; ops_tasks[:store] | Усі власники бачать чинні manual/development tasks; non-owner лише operations network/свій store; unscoped non-owner — видимі stores |
| Financial `due:*` tasks | owner_due:store/network/invalid; finance_due:store/network | Scoped owner/manager/accountant лише свій store; network owner усе за чинною політикою; unscoped manager/accountant видимі operations; cashier/warehouse жодного due ключа |
| ideas/* | owner_ideas; ops_ideas | Owner усе; інші лише operations, відповідно до чинної policy без нового store filter |
| Store PK/name/active | stores_all; store:ID | Unscoped контекст stores_all; scoped лише own ID |
| PromotionCampaign/Price/current M2M | promotion_network; promotion:ID | Лише чинна active/non-archived кампанія. Network видима всім; scoped own ID; unscoped лише active store IDs через Subquery у тому самому SELECT |
| IdeaProject id/idea/store; ProjectTask document/project | idea_links/task_links, scoped variants | Owner network або own-store initiative. Insert/delete/change task document також інвалідує owner-task permission для видимого manual task, навіть якщо initiative іншого store прихована |

Не впливають на кеш: Voucher/CashEntry/StockEntry/payroll/audit/місячні бюджети, PriceObservation/PriceChange, project planned_budget/private details/expense links, технічні import/pricing run documents, приватні settings для cashier/scoped owner, невидимі чужі due/operational tasks та чужі чинні campaigns scoped користувача. Фінансова подія може змінити **видиму** generated task — тоді інвалідується тільки її audience.

Важлива чинна межа: scoped owner бачить manual/development tasks інших stores за старою owner policy. Вони правильно інвалідують owner token; цей performance PR не звужує права. Невідомий/malformed task store не прирівнюється до operations network; фінансові malformed due tasks видимі лише там, де чинний serializer їх допускає.

PromotionCampaign використовує `starts_on`/`ends_on` DateField, без timestamp меж усередині доби. День за Києвом у validator та єдиний effective_day всіх PriceResolver забезпечують start/end перехід без writes. Перед майбутнім timestamp контрактом треба додати найближчу часову межу до validator.

## Runtime та React

304 зберігає кеш/permissions/редактор, не dispatch data-changed і завершує refresh-succeeded. Некоректний validator або domain map не замінює кеш. Після підтвердженого write чинний fresh-read barrier лишається: older in-flight poll не може виконати обов'язкове читання після Save; GET failure не повторює POST.

200 сповіщає лише змінені onSnapshot paths. `tsukenya:data-changed` — сумісний CustomEvent з `detail.domains`; null/відсутній detail — legacy invalidate fallback. Catalog слухає products/references/settings/main; Studio — products/settings/main. Task-only refresh не запускає повторні React catalogue queries. Customers має власні refresh/query keys: remote customer polling цим контрактом не заявлено.

## Перевірки та вимірювання

- PostgreSQL: 11 окремих targeted scenarios PASS: 500SKU cheap304/noGETwrites; rollback/absent row/delete; auth/role/CSRF/privacy; campaigns/M2M/bulk/Kyiv day; labels/references/settings/store/bootstrap paths; initiative permissions/private activity; concurrent edit під RR; simultaneous absent-counter UPSERT; inherited caller fallback; migration forward/backward/reinstall; strong validator numeric spelling/no-op; scope reassignment/expired session. Початкові успіхи використано повторно; після виправлення numeric spelling повторено лише зачеплені branches і нові cases.
- SQLite: нові triggers/migration/strong validator cases і 22 чинні task/financial-scope compatibility checks PASS (25 combined + 2 нові boundary checks; початкові 4 cases перевірено окремо).
- `node tests/runtime-conditional.cjs` та `node tests/runtime-recovery.cjs` PASS: 304, selective notifications, malformed response, cached permissions, GET retry, confirmed-write barrier; справжні write errors лишаються errors.
- `PYTHON_BIN=/tmp/tsukenya-review-venv/bin/python node tests/runtime-conditional-ui.cjs` PASS у Chrome: native304, POST після stale pending304 → fresh200, один write; реальний React unsaved draft пережив304/task-only200. Після виправлення locator scope caption повторено тільки цей сценарій.
- Frontend types/build + lint двох змінених listeners PASS; `makemigrations --check --dry-run` і diff whitespace PASS. Shared controls не змінено; Storybook/весь visual matrix не запускали.

Опційний `scripts/benchmark-state-conditional.py` відмовляється працювати поза явно заданим localhost61144/tsukenya_polling; створює/видаляє власну test DB. [Сирий результат](b24-conditional.json): 500SKU, 10 cashiers, 50 незмінних GET, **2 SQL, 304, 0 raw body bytes**; median 5.779ms, P95 23.471ms у threads одного Django Client процесу. Це лише handler probe, не wire traffic, Caddy/Gunicorn capacity чи production SLA. [Попередній baseline](API-GROWTH-BASELINE.md) залишено історичним.

Обмеження: changed/initial 200 поки містить весь чинний legacy catalogue; delta/tombstone cursor і cached server snapshots не реалізовано. Counters додають row writes тільки до відповідних мутацій; benchmark їх пропускної здатності не заявлено. Через залишений legacy контракт owner scopes описані вище. Повної регресії, VPS, backup, production/Sheet writes, push або deploy не було.
