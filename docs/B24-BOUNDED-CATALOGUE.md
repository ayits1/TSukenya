# B24: bounded вибір каталогу, фільтри та preview цін

База: `0fd0434d1ac4cdceee45f3b26e83517308d3b45e`, окремий clone
`/tmp/tsukenya-bounded-catalogue-next`, `codex/bounded-catalogue`.
Без міграції, зміни accounting формул/ролей, deployment або повної регресії.

## Реальна межа

- Catalog і Label Studio читають `GET /api/v1/catalog/selection/page`:
  `catalog-page-v2`, page10/20/50, exact total/pages/clamp, `facets:null`,
  `facetMode:paged`. Це явно інший транспорт, а не порожній complete universe.
- Їхні група/категорія/пакування використовують shared `CatalogFacet` і
  `GET /api/v1/catalog/selection/facets?field=&facetQ=&page=`. Сторінка30,
  exact total, search, батьківські фільтри; власне значення та дочірні фільтри
  не обмежують свій universe. У Studio збережено чинні видимі group/category
  controls; додатковий pack control не вигадано.
- Вибір ціни «За поточними фільтрами» бере весь matching set зі спільного
  `Selection`, а не поточну сторінку. Понад1000 явно відхиляється; manual skip,
  hidden/excluded fallback pinning, rounding, Decimal і окремий priceContext
  залишаються чинними.
- Звичайний v1 Product Save використовує durable0017 fresh-name/recipe index
  після LedgerLock. Dirty queue drain≤200: незавершений backlog→409
  `catalog_index_pending`, бізнес-запиту не записано. Незмінений name/cost edit
  не потребує name drain. Exact Python whitespace/casefold/Unicode semantics
  і правила unit/recipe використання збережено.
- Scoped reference resolver читає explicit refs один раз, scalar legacy stream
  і зберігає лише потрібні old/new ключі/IDs. За історичного pinned group ID,
  який відрізняється від raw caption, можливий другий scalar pass. Alias,
  archive, exact-before-alias, path-first caption та unknown unchanged ID
  лишаються чинними; довільний новий текст не створює дозволений запис.
- Старі `/api/v1/catalog/products` і `/references` залишено сумісними.
  Повний reference manager/ProductEditor reference universe, small atomic import
  snapshot та explicit export ще не мігровані цим пакетом. Увесь B24 не закрито.

## CPU, RAM, диск та чесні відмови

`catalog_selection.scalar_rows()` передає тільки price/filter/reference fields.
SQL перевіряє UTF-8 byte size **до Python JSON decode**, batch200, максимум64KiB
scalar projection на запис. SQLite зберігає native JSON bool/null і key presence:
missing markup не стає explicit null або truthy string `false`.

Facets і promotion selection використовують private derived SQLite spool:
tempfile0600, cache2MiB, disk≤256MiB, close/unlink у `finally`. Немає persisted
snapshot/cache або grants. Суми/ціни — серверний Decimal; SQLite REAL для грошей
не використовується. Звичайна сторінка без promotion не будує spool.

Full revisions потребують повного JSON. Окремий SQL before-decode guard:
≤256KiB full record, iterator50; preview candidates≤1001 і сумарно≤16MiB.
Selected page≤50 використовує той самий full-record guard. Scalar64KiB cap
**не** названо cap для повної revision. Oversized/byte-budget legacy record
викликає явну відмову, ніколи не пропускається або обрізається.

Explicit refs≤5000 /2MiB, full-record predecode guard; scoped legacy records
≤12000 /16MiB. Матеріалізація/sort/alias indexes bounded одним запитом, не
відтворюються для кожного preview row. Python elapsed120sec guard перевіряється
між scalar batches; він не є гарантією deadline першого SQL sort/lock/fetch.
Ізольований measurement має окремий hard process deadline360sec.

Це bounded-RAM **O(N)** scan/spool/streaming guard, не O(1), не cursor/cache
completion і не production SLA. Можливі довгі читання, SQL sort і500 resolver
queries для100k promotion selection; наступний пакет має оптимізувати цей CPU/
query fanout і paged facets повторних requests за scoped invalidation contract.

## Snapshot v2

`catalog_snapshot.snapshot()` використовує HMAC з typed/versioned canonical
records, кожний framed8-byte length prefix. Впорядковано: full product revision,
effective defaults, Kyiv day, active ERP stores, чинні campaign headers,
active-store memberships і всі їхні candidate prices для products.

Це консервативний guard, включно з losing candidates; сильніша false-positive
invalidation не названа повною effective-price equivalence. Selected-context
signing лишається окремим. Старий v1 preview явно409/read-again; exact committed
receipt replay відбувається до нового guard. Snapshot не передається касиру і
не приєднаний до його polling/list activity token. Actor/role/store/RR та ledger
serialization залишаються Django/PostgreSQL authority.

## Controls і recovery

Temporary search не дорівнює committed choice. Caption committed значення
може лишатися pinned поза поточною сторінкою shared ComboBox; це не додатковий
matching server item. Clear явний, Escape скасовує typed search, paging повертає
focus після відповіді. Latest generation +abort+effect lifetime fence не дають
old response замінити поточні options; pending parent блокує stale children,
але parent/search/reset лишаються доступні. GET failure має explicit retry;
жодних автоматичних business writes або draft baseline adoption.

Facet search тепер literal Unicode `casefold` substring на сервері. Старий
локальний RAC `sensitivity:base` міг ігнорувати діакритику; ця різниця search
семантики явна. Exact committed SQL filter та whole matching selection незмінні.

## Докази

Усі синтетичні, локальні; disposable random QA PostgreSQL61144 або SQLite.
`/tmp/tsukenya-bounded-catalogue-proof/` містить logs/artifacts.

| Перевірка | Результат |
|---|---|
| Initial SQLite selection4 + existing pricing18 | PASS, повтор не робили без зміни input |
| PG selection4 + existing campaign tie/store/preview invalidation2 | PASS |
| PG scalar bool/key presence/oversize/minimum/fresh index/snapshot5 | PASS |
| Scoped reference global oracle + existing Save/orphan/archive/unknown ID | PASS; фінальний oracle включає історично інший pinned group |
| PG fullJSON guard,65 full-filter/1001 refuse, fallback pinning, exact lostACK4 | PASS, `full-snapshot-pg.log` |
| PG oldv1 conflict + committed receipt before newly oversized record | PASS, `v1-receipt-pg.log` |
| Strict page/facet runtime decoder unit5 | PASS, `decoder-unit.log` |
| Shared facet Storybook keyboard/paging/search/Escape/error/clear | PASS, `facet-story.log` |
| Actual Catalog/Studio delayed parent1440/320 | PASS, `native-facets.log`, zero business writes |
| Actual65-category paging +ignored-abort lateDTO +keyboard+1440/320/44px | PASS, `native-paging-tail.log`, zero business writes |
| Matching build/types +scoped lint +syntax/diff | PASS |

Єдину obsolete list interception у `tests/catalog-hidden-ui.cjs` переведено
на actual selection/page endpoint; решта прямих legacy API assertion helpers
лишилися compatibility перевірками. Цю окрему old hidden сім’ю не повторювали:
зміна лише pattern, syntax PASS; hidden/role contract перевірено new API target.

Native artifacts: `/tmp/tsukenya-facets-qa/results.json` (перший4-context run),
`results-tail.json`, `products-pending-1440.png`, `products-pending-320.png`,
`tags-pending-1440.png`, `tags-pending-320.png`, `paged-filter-1440.png`,
`paged-filter-320.png`. Візуально переглянуто320 paging overlay: немає
horizontal overflow, footer навмисно переноситься,44px targets.

### Capacity: не UI SLA

`capacity-{1000,10000,100000}.json`: sequential hard budgets360sec,384MiB RSS,
1GiB disposable DB,256MiB spool.100k лише після10k PASS. Це pre-fullguard
stage (snapshot iterator200); після зміни full guard повторено **лише** affected
full-record target, не приписано попередні100k результати новому snapshot path.

| SKU | promotion selection ms | facets ms | one-selected preview ms | process peak RSS MiB | spool bytes |
|---:|---:|---:|---:|---:|---:|
|1000|177|182|169|245|167936|
|10000|1477|1469|1093|238|1564672|
|100000|14420|15213|10095|228|15826944|

Python peak promotion scan100k≈1.90MiB; total seed+reads79.2sec; DB272.7MB;
all random QA DBs removed. Tracemalloc впливає на latency. Raw JSON/DB bytes
не дорівнюють compressed network payload/capacity. SQL plan artifact: Gather
Merge,318ms measured scalar query; не заявлено indexed search.1050 actual
overlap campaigns→1 retained winner,106ms /0.83MiB Python peak; permanent
oracle positive/zero/negative/equal-price UUID tie/legacy/regular≤winner.

`full-record-postguard.json`:200×128000-byte unprojected legacy fields,
snapshot batch50→12.41MiB Python peak/132.23MiB RSS/276ms;
100 candidates→18.45MiB/136.33MiB/88ms.200 candidates явно відхилені byte budget.
Первинний fixture seedbatch25 перевищив384MiB RSS (435MiB), failed artifact
збережено; seedbatch1 усунув саме QA preparation spike, cap не збільшено.
Final process144.36MiB, QA DB removed. Браузер тільки bundled headless Chromium.

### Команди

```sh
npm exec --workspace frontend -- vitest run src/features/catalog/api.test.ts --project unit
npm exec --workspace frontend -- vitest run src/features/catalog/CatalogFacet.stories.tsx --project storybook
PYTHON_BIN=/tmp/tsukenya-review-venv/bin/python node tests/catalog-facets-ui.cjs
QA_FACETS_FROM=tail PYTHON_BIN=/tmp/tsukenya-review-venv/bin/python node tests/catalog-facets-ui.cjs
```

Full runner має scrub `QA_FACETS_FROM`; default family включає старі4 контексти
та новий paging tail. Targeted reuse: старі4 і новий tail виконано окремо.
PG commands використовують очищений env та тільки явно погоджену local QA DB.
Для opt-in capacity: `scripts/measure_catalogue_selection.py --run-local-pg
--rows 1000 --output …`, далі `--rows 10000`;100k додатково потребує
`--allow-100k --prior-10k …`. Postguard only: `--rows 1000 --full-record-only`.
Host127.0.0.1/port61144/DB_NAMEtsukenya_b24_catalogue_capacity обов’язкові.
Жодних100k/full/prod benchmarks автоматично у regression registry.

## Інтеграція з portal/managed recovery

Own catalogue commit інтегровано поверх accepted PR115 та пакета PR116 без
копіювання старих залежностей гілки. Full registry додатково очищає
`QA_FACETS_FROM`, тому targeted tail не звужує майбутній явний full pass.
Registry syntax, diff і `test:full -- --plan` PASS; full не запускали.
Matching integrated frontend build PASS. Попередні isolated PG/Storybook/native
докази наведено вище; новий 100k прогін не виконувався. Прийняття та deployment
цього пакета ще не підтверджені.
