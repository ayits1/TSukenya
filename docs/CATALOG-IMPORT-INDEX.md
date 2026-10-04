# B21: свіжий індекс і збереження прогресу

## Відтворена проблема та межа виправлення

Початковий e3c8402 обмежував пам’ять, але `duplicate_name` для нового рядка потоково читав увесь products. Для M рядків і N товарів це O(M×N). Legacy recipe fallback у unit guard теж читав каталог при зміні одиниці. `bounded_references` повторно читав/перебудовував усі5000 explicit довідників для кожного рядка. Це не було обмеженим обсягом роботи на рядок. Lease120сек міг відкотити довгий завершений пакет і зробити повтор непродуктивним.

## Реалізація

- `CatalogNameIndex`: product PK, нормалізована назва **точно Python `clean(...).casefold()`**, hash із B-tree. Lookup за hash, остаточне порівняння повного ключа. Не SQL lower/collation approximation. Existing duplicates із незмінною назвою залишаються editable як раніше.
- `CatalogRecipeIndex`: product→legacy component string. Відтворює `str(row.get('product'))` для dict rows; значення довше151 не може дорівнювати максимальному Document identifier. Всі StockLot/VoucherLine/RecipeVersion/ProductionInput guards залишилися авторитетними; optional callback замінює лише legacy full scan у worker.
- `CatalogIndexDirty`: path без FK, щоб пережити source deletion; revision зростає у SQL trigger. Insert/update/delete та ORM bulk operations позначають джерело атомарно з Document write; trigger rollback теж відкотиться. Paths не інтерполюються в SQL.
- Worker під LedgerLock читає до200 dirty paths, блокує чинний Document row, індексує по одному, видаляє лише ту dirty generation, яку спостерігав. Новіша зміна лишається в черзі. Якщо backlog ще є, step зберігає indexedPaths і завершується без validation/apply рядків. Freshness для штатних catalogue mutations спирається на той самий LedgerLock; прямий конкурентний адміністративний SQL не замінює бізнес-права/lock.
- Міграція0017 створює trigger, початково enqueue існуючі paths потоком200; нормалізація виконується в bounded worker warm-up, не Python-списком всіх документів у migration. Reverse прибирає trigger/function до таблиць; повторний forward відновлює їх.
- Фінальна нормалізована назва мусить мати той самий ключ, що й whole-file duplicate check. Імпорт не змінює explicit довідники, recipes/hidden не є його editable fields. Власні створення в одному chunk не обходять whole-file uniqueness.
- `ReferenceCache`: до5000 explicit записів/2МіБ читаються й обробляються shared reference_records **один раз на locked step**. Індекс canonical/alias identities і локальні≤10 old/new legacy choices дають lookup без сканування5000 записів на кожен field. Merge-follow, active priority, pinned/orphan IDs та архів зберігають чинні правила. Cache діє лише поточну транзакцію, не між запусками.
- Lease перевіряється на вході після run row lock. Активна транзакція тримає його до commit; інший claim використовує skip_locked, тому expired active step не можна перехопити. Token fencing не знято. Adaptive приблизно5сек між рядками, minimum1/max100, зберігає cursor/plan-chain/products/outcomes/audit. Окремий повільний validator/price observation може тривати довше; SLA5сек не заявляємо.
- Каталожний JSON>1МіБ або legacy recipe>100 рядків: failed/catalog_index_limit із конкретним path, без truncate/auto-retry loop. Після виправлення джерела resume. Довідники понад resource limit: failed/reference_limit.

## Конкретні докази

PostgreSQL affected29:28 PASS; migration fixture потребувала явної transaction.atomic для select_for_update. Виправлена лише fixture, affected migration retry1 PASS(0.748с); успішні28 не повторювались. Це зберігає попередній1001-row proof і реальні parallel worker/approval/actor-after-lock checks.

Нові окремі докази:

- Unicode `Straße/STRASSE`, NBSP/таб/подвійні пробіли, `İ/i\u0307`, `ς/Σ`, numeric string: indexed lookup дорівнює legacy scan;
- після plan — зовнішній bulk create та rename →2conflicted/1created; зовнішня recipe після ready блокує зміну одиниці;
- bulk update/delete, rollback source+queue+index, newer dirty generation не видаляється;450 source paths drain200/200/... до будь-якого планування;
-1500 SKU,30 name і30 recipe lookups: рівно60SQL, **нуль запитів до erp_document** у per-row lookup;
-1000 explicit refs×10 рядків: **1 reference read та1 shared materialization на validation step**, так само1/1 на apply; паритет alias/category-parent/merge/archive/orphan binding зі shared normalizer;
- same-chunk Unicode collision блокує обидва рядки; збережені нормалізовані назви мають whole-file key;
- adaptive one-row cursor/outcome прогрес після elapsed lease та restart;
- реальний PostgreSQL active rowlock: expired lease, паралельний claim повертаєNone, старий активний worker commit рівно1 product/audit. PASS1.396с; після cache signature adaptation affected retry PASS.

SQLite initial index8 PASS; PG final follow-up cache/parity/resource/adaptive5:4 PASS, query assertion потребувала розекранування LIKE underscore у capturedSQL. Виправлений лише count assertion, affected1 retry PASS0.302с. Два додаткові same-chunk/recipe PG PASS0.329с. Scope unchanged; no full suite/production/VPS/Sheet/deployment.

Це SQL/materialization proof усунення внутрішнього O(M×catalog) та O(M×explicitRefs) scan, не вимір VPS capacity. Cold warm-up O(N) один раз для dirty sources, per-row audit/observations та store count лишаються реальними витратами. No100000 SKU SLA. UI/OpenAPI і fresh-native proof додаються окремою інтеграцією.
