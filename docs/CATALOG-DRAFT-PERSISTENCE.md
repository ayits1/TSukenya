# B06: React каталог і довідники після reload

## Протокол та межа реалізації

Доставка базується на accepted catalogue126
`a13c99753042f7975129940fa8612699449bd6bd`. Початковий server commit після
перебазування — `312f075888ae736e274dbd4bde607031a3cf1640`; наступний commit
додає actual React consumers, typed API/codec та цільові докази. Це whole family
ProductEditor/inline reference CREATE/ReferenceManager, не завершення всього B06.

Actual ProductEditor (CREATE/UPDATE/visibility/guarded DELETE), його inline
reference CREATE та reviewed ReferenceManager B30 commit підключаються до
чинних DraftStore/RecoveryController. Same-tab/same-session P0 лишається межею;
Restore/Discard явні, business fetch ніколи не запускається під час restore.

Новий frozen envelope має `{key,operation,target,store,request}`. UUID canonical;
operation — product_create/product_update/product_visibility/product_delete/
reference_create/reference_commit. Target потрібний лише для existing product
або source reference; store — explicit pricing context або null. Request містить
лише поля чинного відповідного контракту; B30 idempotencyKey дорівнює key.
Fingerprint — SHA256 canonical JSON envelope зі збереженою scalar spelling;
decimal strings не перетворюються на Number і не підміняють бізнес-нормалізацію.

Execute делегує чинним серверним сервісам усередині LedgerLock/atomic boundary.
Fresh actor і scope перевіряються перед creator/fingerprint receipt lookup;
exact committed replay повертає первісну компактну acknowledgement до current
revision/active/deleted checks. Receipt `catalog_action_receipts/<UUID>` містить
лише author/fingerprint/compact acknowledgement. Цей prefix не входить у generic
legacy collection allowlist; нової моделі/міграції не потрібно.

ACK та readonly identity мають `{confirmed,key,operation,target,requestHash,outcome}`.
Непідтверджена identity не доводить known absence, поточний стан — не authorship.
Fresh context/identity читаються READ ONLY RR; поточні Product/selected-reference
metadata читаються окремими чинними bounded endpoints. Compact confirmation
записується до independent current GET; confirmation не приймає current revision
як Save baseline. DELETE не відновлює видалене; changed original replay нічого
не перезаписує. Author/payload collision дає409.

Лише initial live400 validation або rollback409 conflict може отримати bound
write_rejected proof після inner rollback. Permission/collision/postcommit errors
не отримують proof; після unknown/reload будь-який пізніший4xx лишає intent.
Оригінальна дія повторюється окремою type=button навіть за нового invalid raw.

Storage whitelist: editable baseline fields/revision/target і readonly stable
reference IDs для pinning, raw editable strings/checkboxes, власний inline draft,
frozen exact intent і compact confirmation. Немає Product DTO, pricing/campaign
cache, recipe/unknown JSON, permissions, CSRF/session credentials або DOM/PDF.
Capture та quota replacement успішні до першого network await; fresh session,
resource read і останній generation/signal fence стоять перед actual fetch. Кожний
identity/execute POST окремо читає session/CSRF та звіряє draftOwner/draftSession/
role/store/networkOwner із verified Foundation session. CSRF не кешується між
діями і не потрапляє у storage. Старий transport, що ігнорує abort, перевіряє live
перед auth/decode та після кожного await.

Fresh GET не стирає newer input. Existing product comparison використовує чинні
threeWay groups; local Apply встановлює baseline, окремий Save надсилає mutation.
B30 fresh preview/review охоплює whole impact, не page1; snapshot/UUID frozen.
Серверні pricingRevision/type-category/B03/unknown SQL merge/DELETE guards і
bounded126 metadata зберігаються. Private body приховується при непройденому
read/session gate; current401/403 застосовує P0, late/cancelled transport ігнорується.

Поза пакетом: Studio/CampaignManager/assortment/receipt-price review recovery,
cross-device persistence, capacity, повна регресія, deployment і backup0.1.


## Реальні consumers і recovery UX

- Actual API позначає `durableRecovery`; synthetic Storybook mocks лишають старий
  stub шлях. В інтегрованому UI немає прямого save/visibility/delete/inline-create/
  reviewed-commit bypass поза recovery wrapper.
- Кнопка «Вимкнути акцію» відкриває редактор із незбереженою зміною та окремим Save.
  Вона більше не робить прихований write із table row.
- Коли CREATE підтверджено, але current GET503, залишається лише GET-only
  «Прочитати підтверджений запис». Invalid newer input не блокує exact intent retry
  чи current read. Inline confirmed reference обирається окремою явною дією.
- Visibility після ACK читається/порівнюється; local Apply і Save окремі. DELETE
  confirmation не потребує існування target, не створює його повторно і зберігає
  newer raw до явного закриття/Discard.
- Restore existing raw робить fresh comparison, не fresh revision substitution.
  B30 raw містить compact selected records і reviewed request; impact/products/
  facets/page results у storage відсутні. Після Apply потрібен новий whole preview.
- Raw autosave залежить від стабільної raw identity, щоб quota failure не створював
  цикл рендерів. Quota під час Apply відмовляє ДО зміни local/storage baseline;
  comparison і newer raw залишаються. Після звільнення місця Apply повторюється
  локально, business POST не виконується.

## Цільові докази і точні межі

Усі mutations нижче — disposable SQLite або окрема локальна PG test database.
UI — matching own production build, bundled Chromium headless. Manifest entry
в кожному report фіксує build asset; source SHA server312f075 + uncommitted own UI
описує стан перевірки до freeze, не release SHA. Немає borrowed dist чи production
даних. `page.route` лише fault injection; прямі fixture mutations явно відділено
від UI execute POST counter. Жодна перевірка не запускала installed Chrome.

| Перевірка | Фактичний результат / artifact |
| --- | --- |
| Сервер SQLite | 6 cases terminal PASS, `/tmp/tsukenya-catalog-recovery-server-initial.log` |
| Сервер PG receipt/rollback/context | 7 assertions PASS у першому run; teardown тоді FAIL через дві незакриті thread connections (`/tmp/tsukenya-catalog-recovery-pg.log`). Worker cleanup виправлено; лише affected concurrency terminal PASS (`/tmp/tsukenya-catalog-recovery-pg-concurrency-final.log`) |
| Справжнє очікування LedgerLock | 1 PG terminal PASS (`/tmp/tsukenya-catalog-recovery-pg-realwait.log`): pg_stat_activity підтвердив Lock wait, cached actor revoked у blocker transaction, historical receipt після wait denied |
| Codec/ACK/session | 7 unit PASS (`/tmp/tsukenya-catalog-recovery-unit-session.log`): whitelist, unknown stable IDs, exact whole B30 key, frozen-body/confirmation binding, ignored abort, last-session mismatch zero POST |
| Shared recovery UI | 3 stories PASS (`/tmp/tsukenya-catalog-recovery-stories.log`): invalid required input + Enter exact type=button retry/44px/280px, confirmed GET-only, public Cancel/private gate |
| CREATE / confirmation | Prefix 2 PASS з `/tmp/tsukenya-catalog-draft-proof/product-partial.json`: real committed lostACK, invalid newer raw/reload/later bound400; positive identity до independent current503/reload; shared Apply без POST, окремий UPDATE. Original run terminal FAIL на наступному stale-preview fixture, prefix не повторювався |
| Conflict tail | Terminal PASS `conflict-report.json`: initial rollback409, fresh GET/Apply/no auto write, second409 збережений raw (`/tmp/tsukenya-catalog-draft-conflict.log`) |
| Inline + B30 | Terminal PASS `references-report.json`: actual lostACK обох operations, invalid newer raw/reload, identity без repeated commit, original whole reviewed key/snapshot, explicit reference selection |
| Visibility + DELETE | Terminal PASS `visibility-report.json`, `/tmp/tsukenya-catalog-draft-visibility-final2.log`: hide lostACK/current comparison, guarded DELETE lostACK, identity після відсутнього target/no resurrection. Retained failures: occupied orphan port (teardown виправлено), fixture намагався редагувати під disabled comparison (порядок Apply→edit виправлено) |
| Cancel / last awaited session | Prefix 1 PASS `guard-partial.json`: ignored-abort preflight після pagehide zero POST/frozen retained; Cancel late identity zero write. Run далі знайшов quota loop, тому не оголошено whole guard PASS |
| Quota capture | Окремий terminal PASS `quota-report.json` після stable-raw fix: storage failure до POST, raw не стерто |
| Quota Apply | Окремий terminal PASS `quotaApply-report.json`: refused baseline adoption, old storage/raw/comparison unchanged; повторний Apply після звільнення quota без POST |
| Current policy | Terminal PASS `policy-report.json`, `/tmp/tsukenya-catalog-draft-policy-final.log`: actual preflight role403, private body hidden/session draft erased/zero execute. Перший run мав assertions PASS, teardown FAIL; `unrouteAll({behavior:'wait'})` виправив inflight cleanup |
| Last session POST binding | Terminal PASS `/tmp/tsukenya-catalog-draft-proof-session-passed/sessionBinding-report.json`, `/tmp/tsukenya-catalog-draft-session-passed.log`: ordinary CREATE exact one record; session changes after identity, private body hidden and zero next execute. Earlier failures retained: sandbox localhost bind denied; premature hidden-body assertion; false assumption of exactly one session GET (P0 independently revalidates after403). Neither fixture correction changed production |
| 1440 / 320 | Terminal PASS `layout-report.json`: explicit Restore Enter, no overflow, 44px; exact retry Enter з invalid name у `layoutIntent-report.json`. Final spacing-only affected proof `/tmp/tsukenya-catalog-draft-proof-spacing/layoutIntent-report.json`, `intent-320.png` переглянуто: focus border не перекриває heading |

Reports без іншого явно вказаного шляху — `/tmp/tsukenya-catalog-draft-proof/`.
Відмови й partial artifacts збережено; таблиця не стверджує один whole native run.

### Адаптація зачеплених старих fixtures

`tests/catalog-recovery-navigation.cjs` відкриває явний access gate/comparison/
confirmed current controls, не міняє login global state. Старі assertions
перенесено на actual compact execute request; production alias/duplicate handlers
не додано.

- `catalog-editor-next.cjs`: terminal PASS `/tmp/tsukenya-catalog-editor-compat.log`.
  Чинні B28 копійки/акція/stale preview/B29 atomic pricing/два409/focus/1440/320
  assertions збережені.
- `catalog-reference-management.cjs`: rename/snapshot/merge prefix assertions
  пройшли до helper, який помилково вимагав textbox для merge; він виправлений.
  Лише affected `QA_REFERENCE_MANAGEMENT_FROM=recovery` tail terminal PASS
  `/tmp/tsukenya-catalog-b30-compat-tail.log`, report
  `/tmp/tsukenya-catalog-recovery-b30-compat-tail/report.json`: merge/coalesce,
  identity без repeated commit, archive/unchanged old choice/restore stable ID,
  keyboard/1440/320. Initial server error-text fixture FAIL теж збережено.
- `catalog-hidden-ui.cjs`: separate primary terminal PASS
  `/tmp/tsukenya-catalog-hidden-primary.log`, tail terminal PASS
  `/tmp/tsukenya-catalog-hidden-compat.log`. Actual dirty hide/unknown ACK/GET503/
  retry/cancel/Apply/restore/explicit Save та privacy403/session erase збережені.
- `catalog-ui.cjs` і `catalog-price.cjs` лише зачеплені locators/explicit promotion
  Save адаптовані; окремі whole runs не виконувались. B28 money assertions у
  editor compatibility покривають змінений consumer; незмінені server economics
  і bounded126/whole-impact/source/resource proofs reused.

### Команди і майбутній full registry

```sh
npm run test --workspace frontend -- src/features/catalog/recovery/codec.test.ts
npm run test:components --workspace frontend -- src/features/catalog/recovery/RecoveryActions.stories.tsx
npm run build --workspace frontend
npm run generate:api
QA_CATALOG_DRAFT_FROM=sessionBinding PYTHON_BIN=/tmp/tsukenya-review-venv/bin/python node tests/catalog-draft-reload-ui.cjs
QA_REFERENCE_MANAGEMENT_FROM=recovery PYTHON_BIN=/tmp/tsukenya-review-venv/bin/python node tests/catalog-reference-management.cjs
```

New native harness default future explicit full entry runs isolated stages once;
на цій доставці виконувались лише named stages/affected tails. Registry integration
має scrub `QA_CATALOG_DRAFT_FROM` і `QA_REFERENCE_MANAGEMENT_FROM`, щоб зовнішній
flag не скорочував explicit full command. Root owns registry addition.
Останній build/types/lint/syntax/diff checks PASS; generated existing catalogue
output unchanged, additive `catalogRecovery.generated.ts` включено.

Обмеження: same-tab/session, не disk/cross-device restore; physical print/PDF і
screen reader не перевірялись (output DOM не змінено). Scope не охоплює private
cached table freshness поза editor gates, import/legacy Sheet transport, campaign/
Studio/assortment/receipt-pricing recovery, capacity/100k/full suite/deployment.
B30/pricing/stock бухгалтерські формули та arbitrary historical JSON preservation
лишилися authoritative серверам126; compact recovery не читає/зберігає unknown
Product JSON і не підміняє whole-impact preview.
