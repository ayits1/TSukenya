# B24: цілісний каталог, довідники, імпорт та CSV

## Межа пакета

Авторська гілка `codex/bounded-catalogue-workflow` перебазована на прийнятий
`105e2e3fd26511c86e38511ab61dfc62ad002e25` (#123). Цільові докази виконано від
`673e84d00b0040fa2991f356136b4a039d2598e3` (#122); catalogue/control inputs не
змінені parent report-read-grants комітом, результати reused. Фінальна збірка
виконана після rebase. Міграція
`0028_catalog_scalar_invalidation` залежить від прийнятої
`0027_voucher_action_receipts`. Копій чужих QA моделей/міграцій у доставці немає.
Код пакета не розгорнуто цим агентом; він не закриває всю B24 або всю CRM.

Пакет змінює фактичні споживачі `#operations/products`, а не додає невикористаний
endpoint. П’ять полів редактора та менеджер довідників читають сторінки/вибрані
ID. B30 переглядає і змінює **весь** відповідний вплив. Малий атомарний та великий
durable імпорт зберігають невідомі історичні JSON поля через SQL merge. Нова
кнопка CSV експортує весь підтверджений фільтр, а не видиму сторінку.

## Контракти та фактичні споживачі

| Контракт | Поведінка |
| --- | --- |
| `GET /api/v1/catalog/references/page` | Один field, search/state, контекст parentId **або** parentType, 30 items, exact total/pages/query, canEdit/CSRF. Повторні й невідомі query keys відхиляються. |
| `POST /api/v1/catalog/references/details` | До20 exact selected descriptors; за наявності ID відсутність означає unresolved. Немає fallback на інший текстовий ID чи висновку про архівування. |
| `POST /api/v1/catalog/references/impact-page` | request + reviewed snapshot + section + page; усі products/references/coalesced/blocked доступні сторінками30. Змінений вплив409. |
| Старі whole GET `references`/`references/manage` | 410 `bounded_read_required`; фактичні React consumers мігровано. POST явного створення запису лишається. Test-only enumerators перевіряють старі бізнес-assertions. |
| `GET /api/v1/portal/catalogue.csv` | Повний q/type/category/pack/promotion/visibility/store; page/limit не приймаються. Schema14/transportCSV1 unchanged, cost/markup redacted для cashier. Legacy includeHidden=true — обидва стани owner-only, без змішування з visibility/фільтрами. |

Новий `contracts/catalog-references.openapi.json` та generated types доповнюють
чинний catalogue contract; retired GET у ньому позначено deprecated410. Runtime
декодери перевіряють echo, ресурс/parent, кількості, дублікати та snapshot/section.
Оригінальний `reference_records()` збережено як pure compatibility oracle;
активний редактор/менеджер більше його не завантажує.

ReferencePicker використовує спільний React Aria ComboBox: debounce, abort і
request sequence, сторінки/Alt+PageUp/PageDown, явний server option commit,
підпис архівованого selected item, Escape без зміни committed value (у тому числі
null selection), окреме inline-create і focus return. Батьківська група змінює
query категорії; старі options не можна вибрати під новим query. Менеджер має
окремий selected source/target та перегляд повного впливу. Exact frozen B30 UUID
retry не перебудовується з нових input.

## Серверна авторитетність і збереження історії

- READ: fresh actor у READ ONLY RR; WRITE: чинна роль після LedgerLock. Права й
  accounting rules не перенесено у браузер. Committed UUID receipt перевіряється
  до нового snapshot guard; exact replay не дублює audit і не відновлює видалений
  товар. Непідтверджений старий guard409 вимагає нового перегляду.
- `ReferenceIndex` зберігає повний index/aliases на приватному диску: ті самі
  Python clean/casefold, canonical-before-alias, path order, tombstones/defaults
  і parent hierarchy. Unknown selected ID/старе legacy значення не доводять
  archive/delete. Artifact Sheet unknown-ID destructive guard не змінений.
- Product projections читають лише підтримувані поля; recipe validation читає
  лише product/quantity до чинних100 rows. SQL top-level replacement зберігає
  recipe-child metadata й довільні невідомі поля, включно null. Нового ліміту
 256КіБ/16МіБ на matched історичний документ немає. Legacy unit/recipe та
  duplicate-name guards читають scalar fields; перевірка ingredient uses EXISTS.
- Product HMAC revision — **той самий** Python canonical `json.dumps` матеріал,
  з nested sorted keys, array order, Unicode/escapes і numeric spelling. JSON
  chunks проходять через disk sorter; це не SQL-text hash і не нова ревізія.
- Source-v3 guard консервативно зв’язує product/reference transactional counters,
  pricing config, frozen Kyiv day, stores та current campaign header/memberships/
  prices у тому самому snapshot. Direct/bulk/delete/rollback не обходять counters.
  Money/manual/local promotion/hidden/name/unit/reference validators залишаються
  у спільному `normalise_product`/`validate_product`; рецепт не замінюється його
  проєкцією. Missing defaultMarkup/rounding відрізняються від явних null/0.
- SQLite0028 передає product/ref scalar envelopes + SQL raw data-change flag у
  callbacks; старі full envelopes сумісні до застосування міграції. Runtime
  trading wrapper проєктує його єдиний internal settings-defaults query; frozen
  migration0024 routing/Decimal formulas не переписано. PG triggers не змінено.
  Інші SQLite сім’ї зберігають свої старі правила; їх whole envelopes ця робота
  не оголошує bounded.
- B30 не переписує назви історичних VoucherLine/партій. Audit before/after names
  збережені для всіх змінених refs: перші10 в головній події, решта окремими
  `catalog_reference_detail`, з exact detail count; без unknown/private JSON.

## Ресурсні межі й чесні обмеження

Python не тримає повний каталог/довідник/impact/історичну recipe/unknown graph.
Scalar batches≤200, driver fetch batches50/200; canonical JSON chunks16384
символів і driver fetch8. Підтримувані scalar fields/JSON keys/numeric tokens
мають явний64КіБ guard. Це не приховане обрізання: перевищення повертає відмову,
write rollback, export refusal до CSV headers. Incoming validation/recipe100/
atomic import1000 та чинні durable worker batch limits залишились.

Canonical namespace обмежує **canonical.bin + keys.sqlite3** сумарно256МіБ:
write reservation/max_page_count, journalOFF, index-matched Python collation
ORDER BY без temp sort. Інші private index/selection namespaces та CSV файл
мають окремі256МіБ guards; це **не** загальна disk quota всього процесу. SQLite
lookup/query sorter temp files та source PostgreSQL/SQLite JSON operators/temps
не входять у цю гарантію. Driver scalar projection не доводить абсолютний RSS
DB або операційної системи.

Спільний deadline120с передається nested record/hash/reference/import calls;
record budget не подовжує цілу атомарну дію. Deadline перевіряється під час
ітерації та перед commit. Durable worker step має свій bounded deadline і
rollback cursor/rows/catalogue при перевищенні. Це cooperative deadline,
не hard DB statement cancellation: окремий SQL statement/ledger wait може
тривати довше. Whole-impact/reference rebuild/count, source hash/campaign/store
iteration і повний CSV мають O(N) роботу/диск; пагінація не робить їх O(30).
Немає persistent snapshot/cache grant, capacity100k чи production proof.

CSV спочатку готується на приватному диску в одному RR, потім FileResponse
віддає Content-Length і private no-store. Client відхиляє wrong content type,
length, oversize/truncated transport і ignored abort; зміна filter/store скасовує
старий download та не створює Blob URL. Regular/manual/blank0/.5/local promotion
відокремлені від effective campaign; readonly metadata не стало editable.

## Цільові докази (ізольовані, без full)

| Перевірка | Фактичний результат / артефакт |
| --- | --- |
| Canonical/SQL merge/counters/0028 primitives | SQLite8 PASS `/tmp/tsukenya-catalog-primitive-final-sqlite.log`; PG primitive3 earlier PASS. Nested Unicode/arrays/numeric old HMAC oracle, unknown JSON, bulk/delete/rollback/path transition/true no-op. |
| Whole B30 + ReferenceIndex HTTP + atomic/durable imports | PG8 initial7 PASS +1 fixture outer-transaction ERROR (`/tmp/tsukenya-catalogue-whole-pg.log`); affected HTTP TransactionTestCase tail1 PASS `/tmp/tsukenya-catalogue-reference-pg-tail.log`. No combined8 terminalPASS claim. |
| Shared action deadline + hard canonical disk + wholeimpact current source | SQLite6 PASS `/tmp/tsukenya-catalogue-resource-final.log`; PG budgets4 PASS `/tmp/tsukenya-catalog-budget-pg-tail.log` after authoritative schema QA correction. First-write rollback/no receipt/audit, worker cursor rollback. |
| ReferenceIndex shared deadline during later disk passes | Narrow pure SQLite index2 cases FAIL before fix (`/tmp/tsukenya-reference-iterator-before.log`), then PASS (`/tmp/tsukenya-reference-iterator-after.log`). Expiry between iterator steps refuses before consuming another row and closes the cursor; expired direct get/put make no disk query or position change. Complete ID/value order remains unchanged. Existing whole-import/B30/PG proofs reused; no broad repeat. |
| Small/durable huge history + old index validators | SQLite7 PASS `/tmp/tsukenya-bounded-import-sqlite.log`; PG matching import4 included in previous7-success prefix. Arbitrary recipe/unknown preserved, exact receipt before new guard/no resurrection, conflict after unknown edit. |
| Old reference assertions | SQLite25 (1 PG-only skip) PASS `/tmp/tsukenya-bounded-reference-compat-sqlite.log`; scoped oracle1 PASS `/tmp/tsukenya-scoped-ref-compat.log`. |
| Scalar editor/export | Initial SQLite2 PASS +1 fixture status mismatch403 vs400 retained; affected CSV tail1 PASS. Settings/campaign SQLite2+PG2 PASS (`catalogue-settings-campaign-*`); final settings-only tails and scalar unit/duplicate guards1 each vendor PASS (`catalogue-settings-final-*`, `catalogue-editor-guards-*`). |
| Actual SQLite callback with huge product AND settings unknown fields |1 PASS `/tmp/tsukenya-catalogue-callback-settings-tail.log`; instrumentation json.loads refuses any transported string≥2048 inside callback. |
| Strict reference/impact and CSV runtime protocol | Reference API/management6 PASS `/tmp/tsukenya-catalogue-reference-unit-final.log`; CSV2 PASS `/tmp/tsukenya-catalogue-export-unit.log`. |
| Stories | Relevant4 files19:17 PASS +2 async fixture failures retained, affected archived story1 PASS and source focus fix1 PASS tails. Final changed ReferencePicker3 PASS `/tmp/tsukenya-catalogue-picker-cancel-story.log` (null/pinned Escape + paging). No whole Storybook claim. |
| Actual native5fields/impact/CSV/stale download |4 successful scopes in `/tmp/tsukenya-bounded-catalogue-ui-option-tail.log`, then geometry fixture hidden1px RAC button failure retained. Prefix report `tsukenya-catalogue-bounded-8L5Hx2/report.json` is explicitly partial. |
| Actual native layout1440/320 | Layout-only PASS `/tmp/tsukenya-bounded-catalogue-ui-layout-tail.log`; `tsukenya-catalogue-bounded-uVIO0x/report.json`, `editor-popup-{1440,320}.png` viewed. |
| Old inline create/keyboard/5fields/native delete |Affected null Escape failed twice before fix (artifacts retained), then full references-only scope PASS `/tmp/tsukenya-catalogue-inline-compat-cancel-tail.log`, proof `tsukenya-catalogue-bounded-V5j74Z`. |
| Old B30 rename/409/merge/lostACK/archive/restore |Initial management prefix through archive PASS, then dialog Escape fixture assumed old Select focus (`/tmp/tsukenya-catalogue-b30-compat.log`, `GbCCft`). Archive/unchanged editor/restore-only tail PASS `/tmp/tsukenya-catalogue-b30-archive-tail.log`, `BUb7vv`; rename/merge/exact lostACK prefix reused, no whole-family terminal claim. |
| Matching frontend types/Vite/lint/generation |Own build перед rebase `/tmp/tsukenya-catalogue-picker-build-final-tail.log`; final accepted123 types/Vite `/tmp/tsukenya-catalogue-accepted123-build.log`, scoped eslint/Prettier `catalogue-accepted123-*` PASS. Catalog chunk `catalog-CR-FRUCa.js` unchanged across rebase. Own dist, no borrowed root bundle. Model migration check `/tmp/tsukenya-catalogue-migrations-check.log` no changes; JS syntax/diff check PASS. |

Тимчасову спробу fixture записати settings-array штатний SQLite/PG invalidation
trigger відхилив до READ; failed setup logs збережено (`catalogue-settings-refusal-*`).
Фінальний oracle використовує підтримувані object settings; довільні malformed
settings цей пакет не оголошує допустимими.

### Повторювані вузькі команди

```sh
# Ізолювати SQLite environment / localhost PG test DB, як у development modes.
PYTHON_BIN=/tmp/tsukenya-review-venv/bin/python
"$PYTHON_BIN" manage.py test tests.test_catalog_projection --noinput
"$PYTHON_BIN" manage.py test tests.test_catalog_budget --noinput
npm run test --workspace frontend -- src/features/catalog/referenceDirectoryApi.test.ts src/features/catalog/catalogExport.test.ts
npm run test:components --workspace frontend -- src/features/catalog/ReferencePicker.stories.tsx
PYTHON_BIN="$PYTHON_BIN" node tests/catalogue-bounded-ui.cjs
# affected tails: impact/export/layout/references/management/management-archive
QA_BOUNDED_CATALOGUE_FROM=layout PYTHON_BIN="$PYTHON_BIN" node tests/catalogue-bounded-ui.cjs
```

`QA_BOUNDED_CATALOGUE_FROM` перевіряється до створення ресурсів. Harness scrubbed
DB/PG/DATABASE_URL/POSTGRES_URL/TSUKENYA_REQUIRE_POSTGRES/Django settings/secrets/
owner-password inheritance before hashing, uses explicit server.settings,
перевіряє exitCode/signalCode/readiness, зберігає failed artifacts і чекає
SIGTERM/5s SIGKILL cleanup. Лише bundled Chromium headless. Новий script треба
зареєструвати у full runner під час root integration і scrub цей stage flag;
full command цим пакетом не запускали. Physical printer/screen reader/cross-engine,
100k capacity, unrelated B06 families і external provider inputs не доведені.
