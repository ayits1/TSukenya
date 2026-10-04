# Підтверджені зміни цін операції · пакет1

Код від accepted main `0e30c6be10d0e3a8afad36862d0d10252ea6ceb8`. Це серверна основа original issue1 §3.3, **не завершення** накладна→список→Studio. Actual CTA/selection handoff та явний receipt price review — наступні пакети2/3. Чинні invoice posting, COGS, PriceResolver, campaign/manual/rounding, references та ціни старих документів збережені; receipt не переписує каталог автоматично.

## Запит і контекст

Pricing preview/commit, atomic catalogue import preview/commit і create durable import run допускають additive:

```json
{"priceContext":{"storeId":12}}
```

`storeId` — додатний safe integer; explicit null означає **мережу**, не магазин поточного користувача. Explicit null для scoped actor відхиляється. Omission зберігає чинний default user.store або мережу. Вибір за фільтром (`selection.store`) і явний priceContext мають збігатись. StoreNames макета не застосовуються для ERP identity.

Контекст входить у reviewed snapshot, exact request hash та durable plan hash. Новий run фіксує store ID при створенні. Обидва actual readonly preview handlers перечитують active actor/profile всередині strict PostgreSQL REPEATABLE READ / READ ONLY snapshot: product/reference/config/campaign reads, before/after resolver та final HMAC бачать одну версію. Commit лишається в чинному LedgerLock transaction. Після LedgerLock current active actor/role/store перевіряються перед записом **і** поверненням старого ACK; worker перед кожним кроком перевіряє frozen context. Зміна scope не переносить run в інший магазин. Перейменування магазину не змінює історичну назву receipt; current print повинен прочитати актуальні реквізити.

## Дані операції

Preview entry additive `priceComparison` містить `before` (null лише для створення), `after`, `retailChanged`, `displayChanged`, `created`. Preview header має `priceContext` і `effectiveDay`. Ціни — Decimal strings; tuple містить productRevision, effectivePriceRevision, regularPrice, salePrice, effectivePromotion та `display:{promotion,oldPrice}`.

Новий pricing/atomic commit entry additive `priceResult` доповнює comparison полями ID, ordinal/line, outcome, `context:{storeId,storeName,effectiveDay}`, committedAt. ACK header містить priceContext. Durable row має nullable priceResult, записаний **разом** із товаром, outcome й audit у чинній bounded transaction. Atomic mirror переносить той самий exact result.

- `retailChanged`: тільки existing before.salePrice ≠ after.salePrice.
- `displayChanged`: видима ознака акції / перекреслена oldPrice змінилася. Зміна лише campaign name/ID/revision або дня не є зміною видимих сум.
- `created`: before=null. Не створюється вигадана нульова/історична old price.
- Зміна закупівлі/націнки, яку поглинає округлення, ручна або нижча чинна акція, не потрапляє до retail group.
- Зміна regular price під сталою акційною сумою потрапляє до display-only group. UI має пропонувати її окремо, особливо за enabled oldPrice element.

Existing summary.changedPrices pricing зберігає старе значення «зміни regular/sale pair»; він **не** retail delta count. Клієнт використовує server flags / filtered total.

Resolver день фіксується для пари before/after і всіх store resolvers final HMAC snapshot, а actual committedAt зберігається окремо. При retry старі tuple/day/time не перераховуються, навіть якщо товар або кампанія вже інші. Receipt — історичний результат, **не current price authority і не print proof**.

## Read-only результат

```text
GET /api/v1/catalog/price-results/{pricing|import}/{UUID}?group=all|retail|display|new&page=1
```

Creator-only; поточні ролі pricing owner, import owner/manager/warehouse; frozen context перевіряється за поточним scope. Auth і дані читаються в одному PostgreSQL REPEATABLE READ / READ ONLY snapshot. Чужий operation404; відкликані права/context403. GET не створює audit/observations/tasks/receipt.

Результат: `{operation:{kind,id},comparisonUnavailable,priceContext,status,group,total,page,pages,limit:100,items:PriceResult[]}`.

- retail — existing effective amount delta;
- display — displayChanged і !retailChanged;
- new — created;
- all — всі успішні price-result rows, у т.ч. skipped/unchanged (для пояснення).

Тільки durable statuses created/updated/skipped мають actual result; pending/planned/failed/conflicted/invalid не показуються як committed. Відповідь paged100, не весь файл100000. status run повертається актуальним: running/cancelled/completed_with_issues не перетворюються на whole-file success. Нові committed rows можуть збільшувати total під час worker; майбутній UI frozen batch має перевіряти власний selection/result snapshot.

Migration `0023_operation_price_results` після `0022_planning_create_receipts` додає nullable CatalogImportRun.price_context та CatalogImportRow.price_result. Для старих receipts/runs поля відсутні/null: `comparisonUnavailable:true`, priceContext=null, items=[], total0. Немає guessed backfill із current catalog/after-only preview/часового журналу. Старий ACK повертається без зміни формату. Уже ready/running legacy run може завершитися за чинними legacy правилами, але не отримує вигадану original context/price delta.

Readonly creator results — доступний шлях identity/result recovery після lost ACK. Existing native pricing/import completed UI у пакеті1 не змінений: його ambiguity→terminal4xx пояснення та actual Studio handoff виправлятимуться пакетом2. На підтверджений old result завжди накладається окремий current product/context reread й labels.prepare перед друком.

## Контракт і decoder

`contracts/catalog.openapi.json` / generated types мають additive request/response schemas. `shared/api/operationPrices.ts` строго перевіряє exact operation/context/group identity, enum types, safe IDs, revision64, календарну дату, decimal money, promotion/display consistency, delta flags, created/null before, successful outcome, ordered unique page rows і pagination cardinality. Відповідь сторінки прив’язана до requested page; допускається тільки серверне clamp=min(requested,pages). Спільну validation ефективної акції виділено з existing effectivePricing без зміни її правил. API client робить лише same-origin GET з AbortSignal. Немає TS cast замість перевірки network DTO.

## Цільові докази

- PostgreSQL61144, власна DB `tsukenya_price_results_review`: **13 PASS**, 10 нових сценаріїв + 3 зачеплені old pricing/import/jobs invariants; `/tmp/tsukenya-price-results-pg.log`, 10.095с. Rounded/manual/metadata/new, campaign regular-only, immutable exact afteredit, creator/current roles/context, read-only snapshot, legacy unavailable,100/103 partial cancel,101 paging, blocked worker scope, injected rollback після row result.
- Окрема DB `tsukenya_price_results_followup`: **3 PASS**, `/tmp/tsukenya-price-results-pg-followup.log`,0.626с. Explicit context snapshot substitution409/no write; historical day/identity remains original on retry; **actual PG ledger wait** з відкликанням role/store→403/no extra audit; parallel exact pricing commit→один receipt/delta/audit. Mock wait test лишився як швидкий regression, real lock test не підмінено ним.
- SQLite initial10: 8PASS/2FAIL через регістр нового error text (існуючий HTTP error adapter визначає403 за українським словом); змінено message на «Немає доступу…». Повтор лише2affectedPASS. `/tmp` SQLite ізольована; full suite не запускалася.
- Unit **38 PASS**: нові5operation cases + existing33client cases для винесеного promotion validator; original/partial/legacy/display/new + malformed identity/enum/date/deltas/page/JSON та readonly abort/fetch. Успішні незмінені кейси не повторювалися після дрібних additive metadata/argument guard правок.
- Preview follow-up: `/tmp/tsukenya-price-preview-pg.log` — 3 actual cases PASS (cached role/store revocation, real concurrent campaign edit між resolver reads у pricing/import, old atomic preview); четвертий target не зібрався через неправильну назву. Повтор **лише** правильного jobs mirror target PASS `/tmp/tsukenya-price-preview-fixture-pg.log`. Два affected fixture classes переведені на TransactionTestCase: writable nested TestCase transaction не може виконувати strict READ ONLY preview; production guard не послаблено.
- Midnight follow-up: 1 PG PASS `/tmp/tsukenya-price-day-pg.log`,0.143с; original та simulated crossed-midnight preview snapshot/tuple однакові в обох actual handlers. Початковий запуск знайшов невірне keyword argument day у PriceResolver; виправлено до чинної positional date сигнатури й повторено тільки цей case.
- Page-binding unit: 1 PASS,5 untouched cases omitted via `-t 'binds the requested page'`; requested9/clamped2 приймається, unrelated page1 для requested2 відхиляється.
- TSC, scoped ESLint/Prettier, `makemigrations --check --dry-run` та diff whitespace перевірені. Shared control/rendering не змінювалися: Storybook/native/PDF до цього backend пакета не запускалися.

Межі: немає claim про physical print, mobile RAM,100000-row SLA, production rollout, durable browser Studio draft reload чи завершення issue3.3. Перед пакетом2 узгодити priceContext з parallel schema/parser/export changes у catalog-import.js; пакетом3 користувач явно вибирає каталожну закупівлю при multi-lot invoice, без вигаданого average/last/landed policy.
