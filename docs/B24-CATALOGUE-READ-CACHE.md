# B24: повторні Catalog / Studio facet та promotion reads

База `50074dda11bbffac83c0721ac9528f76b56e105a`, власний clone
`/tmp/tsukenya-catalogue-read-cache`, `codex/catalogue-read-cache`.
Без міграції, зміни economics/ролей, deployment або повної регресії.

## SQL inventory і прийнята межа

`catalog_selection.Selection.build()` раніше на кожний facet request читав
scalar universe, сортував товари та будував новий SQLite spool. Promotion
додавав `PriceResolver` на кожні200 paths. Попередній100k доказ у
[bounded catalogue](B24-BOUNDED-CATALOGUE.md) зафіксував14–15с і502 SELECT;
його тут **не повторювали**.

Новий opt-in QA вимірює той самий механізм на1k/10k. Для10k старий шлях:
52 SELECT,2069.6мс membership /2048.6мс facets. Scalar SQL plan:
`Seq Scan erp_document → Sort(type,category,name,path)`, без full recipe JSON.
Новий cold SQL має correlated numeric minimum через indexed
`erp_promotionprice.product_id` і `state_current_campaign_dates`;
`Limit → Sort(price,campaign_id) → indexed joins`,10000 loops на10k.
Це один statement, а не500 round trips, і все ще пропорційна каталогу робота.
Actual SQL/`EXPLAIN (ANALYZE,BUFFERS)` містяться у measurement artifacts.

`Selection(read_cache=True)` застосовується тільки в actual GET
`/api/v1/catalog/selection/page` і `/facets`. POST pricing фізично лишається
`read_cache=False`, передає frozen `effective_day`; одночасне cache+explicit
day відхиляється. Atomic preview/commit snapshot v2, ревізії, receipts,
fallback pinning/manual/hidden і LedgerLock незмінні.

## Дані та authoritative перевірки

`catalog_read_cache.key()` і cold build виконуються в **одному** READ ONLY RR
snapshot. `_handle()` спочатку виконує `current_actor`; `source()` перевіряє
current requested/own ERP store та hidden-owner policy перед будь-яким hit.
Cached content не є дозволом, baseline або frozen price selection.

Private index містить тільки path/order, raw facets/captions, promotion
membership і distinct facet terms для всіх дозволених parent combinations.
Cost, markup, regular/sale prices, full JSON, full revisions, сесії та grants
не зберігаються. Selected≤50 products та їхній resolver/serialization читаються
знову в current RR. `regular_price`, `promotion_amount` і shared
`eligible_amount` залишаються Decimal authority. SQL minimum повертає numeric;
SQLite не зберігає ціни як REAL. UUID/legacy ties обирають metadata у чинному
`PriceResolver`; однакові minima не змінюють boolean membership.

Distinct prefix terms мають `WITHOUT ROWID` PK з Python `casefold` sort key.
Category/pack охоплюють також unconstrained/one-parent combinations. Власне
значення і descendants не звужують свій facet universe; committed filters
лишаються exact raw JSON string comparisons. Hit не робить DISTINCT/sort
товарів, search перевіряє facet terms; count/page/search все ще залежать від
розміру доступного facet universe. Product IDs сканують rowid order без sorter.
Це не cursor/O(1) completion.

## Invalidation / privacy map

Server-only HMAC key містить schema/code digest, role/profile store, visibility,
normalized base search words та promotion-membership mode. Yes/no ділять один
індекс з обома membership classes. Parents, page і facetQ не створюють окремий
product scan. Code digest охоплює cache/selection/current promotion/catalog
helpers; зміна цих semantics не може вибрати старий file schema.

| Джерело | Чинне покриття0015 / перевірка |
|---|---|
| Product create/edit/delete, direct SQL/ORM/bulk | Atomic `StateVersion.catalog` через document trigger; key читає revision і PG row xmin |
| Default markup/rounding | Current effective Decimal config у тому самому RR; pricing trigger лишається чинним |
| Campaign header/price/M2M membership, old/new | Atomic per-campaign counters; key streaming SELECT **current eligible scoped IDs** +counter/explicit0 |
| Future/foreign campaign | Не вибирається у current scoped key; own membership/date/active transitions змінюють selected IDs або counter |
| Midnight commit boundary | Current Kyiv day в key; selected current campaign IDs/counters, а не mutation-time day predicate |
| ERP store activation | Fresh `context_store` перед hit: explicit inactive selection відхиляється; чинний implicit own inactive context лишається сумісним з resolver. Store captions serialize fresh |
| Role/store/deactivation | Fresh actor/resource checks; role/profile store у key; hidden cache не відкривається касиру |

No-promotion facet key не включає campaign/day/store-price activity, бо результат
від неї не залежить. Global catalog counter консервативний: private-only manual
cost/revision edit може збити internal cache. Key, xmin і counters **ніколи не
надсилаються** як ETag/domain event/client token; це не новий public activity
channel і не заміна scoped polling contract.

PG xmin лише додатковий discriminator після reinsert/reset counter: це
**не абсолютна DB identity** при physical restore/wraparound. TTL≤1година і
namespace lifecycle обов'язкові. Namespace HMAC включає DB engine/name/host/port
і secret; files одного code schema не є переносним backup. Після DB restore
оператор має зупинити відповідні readers, видалити **лише їхній configured
derived namespace** і запустити readers знову. Тут restore/VPS не виконували,
backup0.1 не оголошено завершеним.

## Диск, lifecycle і відмова

PostgreSQL вмикає capability за замовчуванням; SQLite default uncached,
explicit `CATALOGUE_READ_CACHE=True` +trusted isolated
`CATALOGUE_READ_CACHE_DIR` дозволяє development proof. Це engine configuration,
не визначення TestCase або послаблення RR. Root parent directory за замовчуванням
OS temp; namespace0700, image0600, no-follow opens і owner/mode checks.

Published≤32 images; published +one reserved builder image≤512MiB на namespace.
**До build** резервується worst-case256MiB; active-reader shared locks не
витісняються, нестача місця→retryable503. Builder `max_page_count` обмежує
свій image256MiB. Journal вимкнений тільки у disposable derived DB; failure
ніколи не publish. Prefix terms вставляються bounded batch200 (≤7 terms/row)
у готові порожні B-tree indexes, без index-build sorter/journal files. Hit
plans підтверджують відсутність `TEMP B-TREE`. Це bound SQLite images; filesystem
metadata і PostgreSQL sort/temp storage не названі частиною512MiB.

Closed/fsynced image переходить atomic rename **на тому самому filesystem**;
немає copy та другої256MiB image. Неповний file не може стати hit. Publication
lock один постійний, не per-key необмежені locks; both shared-read/build waits
≤2с. Orphan builders очищаються тільки всередині own0700 namespace під lock;
cleanup не обходить active reader locks і не торкається чужих temp directories.
TTL-expired image ніколи не served stale. Корумпований private image rebuild;
busy/disk failures→503 `catalog_read_pending`, `Retry-After:2`, explicit GET retry.

Cold Python elapsed guard120с +SQLite VM progress interrupt збережено. Це не
hard deadline першого PostgreSQL sort/statement. Scheduler/worker/retention
service не додається. Retired namespaces після зміни DB/secret потребують
операторського cleanup; per-namespace bound не названо глобальним host quota.

## Targeted докази

Artifacts: `/tmp/tsukenya-catalogue-cache-proof/`.

| Доказ | Результат |
|---|---|
| SQLite4 initial membership/direct rollback/scope/file policies | PASS, `sqlite-unit.log` |
| PG5 current-role/scoped direct/bulk/rollback/config/day/foreign/future campaign, locked files/TTL/corrupt/partial publish/POST bypass, real RR concurrent write-between-key-and-body | PASS, `postgres-final.log`; незмінені invalidation/RR inputs reused після storage-only correction |
| Final bounded prefix membership+old winner oracle | PASS, `capacity-sqlite-final.log`, `winner-oracle.log`; negative/zero/equal regular/legacy/UUID tie/1000 mocked overlaps |
| Capacity PG1 reserve-before-build /pinnedreader refusal/no-sort plans | PASS, `capacity-pg-final.log` |
| Final128KiB namespace /64KiB image observed peak, max-page refusal, no journal/copy/temp-sort, no silent truncation | PASS, `hard-cap-final.log` |
| Actual Catalog lock503→explicit GET retry; Studio same index hit under held build lock;65 choices page2/search/committed64/Escape;1440/320/44px | PASS, `native/report.json`, writes0/errors0; API/UI inputs unchanged by final image reservation correction |
| Python/Node syntax, diff check, browser-policy253 | PASS, bundled headless only; no full run |

Native matching frontend dependency:50074dd, frontend source unchanged. PNGs:
`native/cached-studio-1440.png`, `native/cached-studio-320.png`;320 inspected.
Initial native wrong Studio tab/locator failure retained in `native/failure.*`,
fixed as harness navigation, not a production UI workaround. Shared controls
and their previous Storybook/generation tests unchanged; reused existing proof.

### Sequential bounded measurement

Opt-in command, disposable random QA DB only:

```sh
env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin \
 DB_HOST=127.0.0.1 DB_PORT=61144 DB_NAME=tsukenya_catalogue_cache_measure \
 DB_USER=postgres DB_PASSWORD=isolated-review-password \
 DJANGO_SECRET_KEY=isolated-review-only-secret-key-not-production-at-least-fifty-characters \
 /tmp/tsukenya-review-venv/bin/python scripts/measure_catalogue_read_cache.py \
 --run-local-pg --rows 10000 --output /tmp/cache-10000.json
```

Choices лише1000/10000, немає100k option. Process180с/RSS384MiB/QA DB512MiB
caps; teardown видаляє тільки власну random DB і private QA namespace.
`--reuse-baseline` бере passing same-row old values, не повторює незмінений old
read. Final service measurements **не включають HTTP authentication/currentactor
queries або wire/network latency**; SQL counts вказують SELECT окремо від
BEGIN/SET/COMMIT wrapper queries.

| 10k service | ms | SELECT / wrapper queries |
|---|---:|---:|
| Old membership (reused same inputs) |2069.6|52 /53|
| Final cold index |990.5|4 /5|
| Final membership hit |7.9|3 /4|
| Final facets /page3 /search hit |8.0 /8.4 /7.5|3 /4|

Final artifact `measure-10000-final-batch.json`: Python peak≤1.051MiB,
process RSS117.422MiB, cache2301952 bytes, total5.89с incl seed/migrations/reads;
DB/cache removed. Initial1k `measure-1000.json` proved budget before10k, then
affected cold/hit paths remeasured after reservation/prefix changes. Earlier
`measure-10000.json` contains unchanged old baseline; intermediate artifacts
are history, not claimed final performance.

No new100k/full/concurrency throughput/SLA claims. Cold O(N), shared global
build lock, conservative product invalidation, distinct-term search cardinality,
normal page query/indexing, reference reads, import snapshot, cursor/cache
distribution/tombstones and large write-amplification remain separate open work.


## Root integration

Own commit0ee066a інтегровано поверх accepted PR117 main9cbd49d як4b08e43.
Runtime source і тести byte-identical author delivery; source review повторно
звірило reserve-before-build, max_page_count, prefix PK і atomic rename. Source
семантика PR117 та його SQLite fixture isolation збережені. Незмінені author
цільові PG/SQLite/native/capacity/10k докази використано повторно. Full registry
отримав окремий native cache scenario; запуск runner лише --plan, не full.
