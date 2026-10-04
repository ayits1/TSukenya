# B24: обмежене читання боргу клієнта · 05.10.2026

## Межа пакета

`customers.profile` більше не викликає `with_settlements`: порція з 200 рахунків не обмежувала кількість дочірніх повернень і розподілів одного рахунку. Новий read-only адаптер `settlements.current_source_obligations` використовує вузькі заголовки та чинний `report_children.obligations`:

- до 200 source IDs і чотири Decimal-накопичувачі на джерело;
- events/allocations читаються курсором по 200, без prefetch списків або PaymentAllocation model objects;
- embedded/refund payments розгортаються базою; Python отримує scalar amount, не весь payload;
- `cutoff=None`: поточний борг включає всі posted children, у тому числі історичні майбутні за датою. Лише вихідні документи профілю мають `date <= today`;
- Decimal-порядок, округлення, legacy payment suppression, активність трьох учасників allocation та від’ємні суми відповідають незміненому `services.obligation`.

Профіль читає `due_date` скалярно. Невалідні непорожні значення збільшують `unknownDueDocuments`, а відсутні/порожні/null/false/0/[]/{} пропускаються за попереднім контрактом. Структурована дата порівнюється з порожнім JSON на сервері, без декодування вкладеного масиву чи об’єкта у Python.

`list_customers` і `profile` повторно завантажують активного користувача та його роль/магазин **всередині** чинного `read_snapshot()` перед доступом і DTO. Касир отримує `debt=None`, а фінансовий адаптер взагалі не викликається. Список контактів лишається спільним; purchase facts та debt лишаються в дозволеному магазині.

`services.obligation`, `settlements.context`, `prefetched_sources`, posting, allocations, моделі й міграції не змінені. Інші legacy споживачі `with_settlements` (journal/references/reconcile) не оголошуються обмеженими цим пакетом.

## Цільові докази

Ізольована PostgreSQL18 `127.0.0.1:61144`, окрема `test_tsukenya_crm_settlements`, видалена Django runner після кожного запуску. Production/Google Sheet не використовувалися.

Шість нових методів `tests.test_customer_settlement_reads.CustomerSettlementReadTests` і вісім чинних `tests.test_customers.CustomerFactsTests` пройшли цільовими хвилями:

1. Один source з 501 embedded payments, 205 returns з 3 refunds кожне і 205 advance allocations: результат **9586.14** точно збігається з posting oracle. Пік materialized Voucher — **3**, PaymentAllocation — **0**, цілі payload payments — **0**, cursor chunk — **200**, scalar JSON children — **1116**.
2. Legacy/mapped/cross-source payment, reversed funding/settlement, обидва типи повернень, future posted child, від’ємний залишок: **-5.00 / 0.50 / 5.00** паритетні oracle. Недопустима точність суми відхиляється обома шляхами.
3. Невалідні scalar/structured due dates і falsy значення: **15.00** боргу, **1.00** прострочено, **6** невідомих дат. Код projection не повертає структуровану дату в Python; memory counter вимірює саме payload payments.
4. Кількість SQL для одного джерела без дітей і з 205 поверненнями однакова: **11 SELECT/DECLARE**. Для 203 джерел batches **[200, 3]**, пік materialized Voucher **203**. Чинний query budget тепер рахує також PostgreSQL DECLARE і має межу 12 для однієї порції.
5. Кешований owner після зміни role/store стає cashier/manager у новому запиті; касир не читає debt, чужий магазин та disabled actor відхиляються.
6. Реальний паралельний posted payment під час читання: поточний RR результат **100.00**, наступний запит **50.00**. Читання використовує READ ONLY REPEATABLE READ і не пише проводки.

Перший прогін 14 методів: 12 PASS, два нові oracle fixtures потребували Decimal замість in-memory строкового total та допустимого 2dp payment. Після виправлення fixtures повторено тільки ці два методи — PASS. Persisted бізнес-входи інших успішних сценаріїв незмінні. Повторено також лише SQLite due projection і SQL-budget — **2 PASS**, оскільки backend JSON operators і відображення cursor queries відрізняються.

Артефакти сесії: `/tmp/tsukenya-crm-settlement-proof/{targeted-postgres.log,targeted-postgres-retry.log,targeted-sqlite-projection.log,postgresql.jsonl,sqlite.jsonl}`. Syntax/`git diff --check` — PASS. Незалежне read-only рев’ю production diff блокерів не знайшло.

Цільові команди (лише з ізольованими DB-змінними, не з environment VPS):

```sh
python manage.py test tests.test_customer_settlement_reads.CustomerSettlementReadTests tests.test_customers.CustomerFactsTests --noinput
python manage.py test tests.test_customer_settlement_reads.CustomerSettlementReadTests.test_due_truthiness_and_malformed_nested_values_preserve_unknown_count tests.test_customers.CustomerFactsTests.test_queries_are_batched_and_reads_do_not_mutate --noinput
```

## Межі доказів

Це O(N) scans і обмеження кількості Python records, не O(1), SLA або вимірювання ємності VPS. Розмір одного scalar значення, DB detoast/parse/sort/work_mem і час довгого RR не обмежуються цими перевірками. PostgreSQL драйвер/сервер можуть мати власні буфери. Пакет не додає caching/polling, політику backup0.1 або scheduler. UI не змінювався; browser, full regression, push/PR/deployment у цій задачі не виконувалися.
