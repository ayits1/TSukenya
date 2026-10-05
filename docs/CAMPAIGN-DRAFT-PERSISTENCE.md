# B06 — локальне відновлення редактора акцій

## Межа

Чинний `CampaignManager` на `#operations/products`: CREATE, повний UPDATE (увімкнення також є полем Save), архівування. Дати включні в Києві, чинні магазини, validation ціни, вибір найнижчої чинної ціни, журнал та задачі передруку залишаються у старих Django mutation services. Нового DELETE/visibility endpoint немає. Збереження потребує актуального власника мережі; manager/warehouse не отримують приватні умови кампаній через recovery.

`CampaignEditor` користується тим самим `DraftStore`/`RecoveryController` та shared three-way/`ConflictComparison`. Ця сім’я має окремий codec `campaign_editor`. У sessionStorage того самого tab/session — тільки scalar whitelist raw editable terms, product IDs/captions, opening revision, frozen envelope та compact ACK. Немає Product/Campaign DTO, авторів, ефективних/закупівельних цін, секретів, DOM/PDF. Quota зупиняє запит до business await; raw не обрізається. Відновлення та відкидання явні; autoRestore/autoPOST відсутні.

## Протокол

`contracts/campaign-recovery.openapi.json` описує v1 context/current/identity/execute. Генерований контракт використовується strict runtime decoder; input whitelist/UUID/resource/revision/hash та поля ACK перевіряються окремо.

- Context/current GET — READ ONLY RR та `current_actor`. Роль/global scope перевіряються у snapshot. Ordinary context/history/list/detail GET також мають цю межу.
- POST envelope `{key,operation:create|update|archive,target,request}` зберігається до network await. CREATE body `idempotencyKey` точно дорівнює `key`; UPDATE/archive revision — opening revision. Identity теж POST read-only з CSRF та останньою перевіркою same-session, а не business mutation.
- Execute має outer ledger transaction, fresh actor/role/scope, creator/fingerprint lookup **до** нових target/revision/product/store guards. Новий receipt namespace `campaign_action_receipts/` містить тільки author, immutable envelope fingerprint і scalar ACK. Generic document API цей namespace не приймає. Replay має первісний результат без повторного audit, оновлення, resurrect або validation чинних товарів. Body/author collision — 409.
- Exact canonical SHA256 envelope зберігає spelling raw decimal/date/reason. Серверні normalisation/Decimal правила не замінено клієнтськими формулами. Окремий старий CREATE fingerprint є byte-exact старим `json.dumps` over sorted FIELDS.
- **Legacy CREATE fallback** підтверджується тільки з незмінних `PromotionCampaign.author_id/request_fingerprint`. Чинні PATCH/archive їх не змінюють (source + targeted test). Змінений/архівований DTO не є provenance. Відсутній старий campaign без receipt дає `confirmed:false/unresolved`; це не known absence, не retire intent і не baseline. Нова codec-сім’я записує CREATE тільки через атомарний receipt protocol; історичних in-memory чернеток старого UI вона не імпортує.
- Bound `write_rejected` є тільки результатом rollback inner transaction перед outer commit. Перший live definite validation/revision refusal може звільнити його intent. Після unknown/reload/cancel пізній 4xx цього не доводить. Collision/permission/postcommit callback failures не отримують proof.
- Позитивна identity або ACK зберігає confirmation **до** незалежного current GET. Current503/404/reload не повертають CREATE/UPDATE у повторний POST, не підставляють нову revision і не стирають новіші invalid поля.
- Explicit current GET читає snapshot для порівняння. Conservative atomic group: name/dates/scope/stores/all prices/active; reason незалежний. Apply локальний, Save окремий. Archived current не можна Apply/Save. Ніякого eager adoption revision з ACK/GET.
- Кожен transport має live/generation/Abort fence до/після session/JSON decode та actual fetch. Current401/403 проходять через Foundation privacy/read gate; stale/cancelled ignored-abort401 не відкликає новий редактор. Non-JSON last-session errors зберігають HTTP status.

## Scalar caption follow-up

Campaign/list/history DTO більше не завантажують цілий Product JSON лише заради підпису. SQL повертає JSON text **тільки name**: PostgreSQL `->name::text`, SQLite typed `json_type/json_quote(json_extract)`; Python декодує лише цей leaf і застосовує старий `str(name or '')`. Це відрізняє JSON-like string `"true"/"1.00"/"{}"` від bool/числа/object. Порядок campaign prices/stores і name fallback збережено. Цей caption leaf та campaign price rows самі можуть бути великими; це не абсолютна RAM/capacity гарантія і не заміна існуючих pricing write reads.

## Цільові докази

Власний clone `/tmp/tsukenya-campaign-recovery-next`, база `7efb6998f6416eafd5cdafc647dae05331497ed0`. Усі дані синтетичні; SQLite/server ephemeral, PG database `tsukenya_campaign_recovery`; лише bundled Chromium headless. Жодного full/prod/Sheet/VPS/push/release.

| Перевірка | Фактичний результат |
| --- | --- |
| Own server SQLite6 | PASS `/tmp/tsukenya-campaign-recovery-sqlite-final.log`. Перший setup/import fixture failure та два assertion-only failures залишені у попередніх логах. Це не повний promotions suite. |
| Own PostgreSQL7 | PASS `/tmp/tsukenya-campaign-recovery-pg.log`: receipt create/update/archive replay/collision/rollback/current privacy/scalar; parallel exact UUID одна кампанія/receipt; cached actor реально чекає Lock і після scope revocation не отримує старий receipt. |
| Generic receipt namespace з чинним CSRF | Affected SQLite1 PASS `/tmp/tsukenya-campaign-prefix-guard-tail.log`; retained попереднє expected403→actual400 fixture failure. |
| Review caption follow-up | SQLite1 + PG1 PASS `/tmp/tsukenya-campaign-caption-{sqlite,pg}.log`: actual null/0/bools, JSON-like strings true/false/null/123/1.00/{}/[], object/list/Unicode/escapes; direct full Product.data SELECT forbidden, великий unknown graph не вибирається. Старі economics не перезапускалися. |
| Strict codec/API unit6 | PASS `/tmp/tsukenya-campaign-unit-contract-tail.log`: raw/immutable identity/ACK, wrong hash/target/private additions, bound refusal, nonJSON401/403, delayed session cancel/change before POST. |
| Existing CampaignManager stories4 | PASS `/tmp/tsukenya-campaign-stories.log`. Synthetic adapter без durable flag збережений лише для існуючих mock/story consumers і не є enrollment proof; actual createPromotionApi завжди повертає durableRecovery:true. |
| New recovery actions stories3 | PASS `/tmp/tsukenya-campaign-recovery-stories.log`: Enter exact retry, confirmed GET-only, Cancel pending. |
| Types/lint/own production build | PASS `/tmp/tsukenya-campaign-{types,lint}-delivery.log`, `/tmp/tsukenya-campaign-build-source-freeze.log`. Assets власні, не symlink на root. |

Actual isolated native harness `tests/campaign-draft-reload-ui.cjs`, `QA_CAMPAIGN_DRAFT_FROM=<stage>` запускає лише один stage. Default послідовно запускає ті самі named stages (не виконувалося як ще один загальний прогін). Registry/env scrub додає root після інтеграції.

Докази `/tmp/tsukenya-campaign-draft-proof/<stage>-report.json`:

- `create`: committed/lostACK CREATE, invalid newer raw/reload/explicit Restore, later bound400 retains exact first envelope, readonly identity підтверджується до current503; confirmedID/reload без повторного CREATE; full terms comparison/Apply local + separate UPDATE.
- `conflict`: два actual revision409; rollback proof звільняє тільки first live intent, raw не скидається; Apply не пише, друга Save знову потребує fresh comparison.
- `update`: committed/lostACK UPDATE, invalid newer reason/reload; первісний receipt після чужого пізнішого edit; independent current503/reload без adoption latest revision/повторного UPDATE.
- `archive`: committed/lostACK archive/reload, newer blank reason; receipt перед archived current, readonly Apply, лише revision2.
- `privacy`: actual preflight403 після зміни owner→manager, private form hidden/local record erased, execute0.
- `quota`: storage refusal до business await, raw залишається, execute0.
- `late`: cancelled ignoredAbort current401 після нового editor не приховує/не стирає його raw.
- `layout`: 1440/320 long Ukrainian labels, >=44px actions/no document overflow, calendar Enter/Escape focus, sidebar Restore Enter та raw, mutations0. Initial sandbox bind failure і mobile hidden sidebar fixture failure retained. Пізніший capture-only tail явно scrolls editor/actions у viewport. Остаточний tail — `/tmp/tsukenya-campaign-native-layout-final.log`, screenshots `editor-{1440,320}.png` та `actions-{1440,320}.png` переглянуті. Бізнесові prefixes reuse після no-empty-frame CSS та уточнення product search cache key поточним store, не whole-family repeat. Prefixes працювали з власними matching builds; їх не називаємо повторним exact-final-head прогоном.

Залишки повного плану не закрито цим пакетом. Cross-tab/new-session persistence, provider integrations, physical print, capacity100k/full regression і deployment не виконувались. Нові settings/інші editor codecs не дублювалися.

## Review follow-up: pending raw та синхронна privacy межа

`CampaignEditor.updateRaw` тепер записує кожну зміну raw синхронно в input handler, включно з назвою, причиною, датами, магазинами, цінами та пошуком. Busy не блокує capture; exact frozen firstIntent UUID/body/hash зберігається окремо й не змінюється. Після guarded fresh identity/session поля доступні для новішого введення під час execute. Foundation suspend/revoke синхронно прибирає private form через `flushSync` до redirect/beforeunload; obsolete response guards лишаються. Strict raw scope приймає лише string, масиви не coercing.

Цільові докази цього follow-up з власним новим matching build:

- `QA_CAMPAIGN_DRAFT_FROM=pending-create` — PASS: committed CREATE ACK held, новіша invalid blank назва/ціна `0.00` durable **до** ACK; pagehide приховує форму; reload + явний Restore зберігає поля й незмінний первісний body/UUID/baseline, лише один POST.
- `QA_CAMPAIGN_DRAFT_FROM=pending-update` — PASS того самого pending/reload boundary для UPDATE.
- `QA_CAMPAIGN_DRAFT_FROM=auth-sync` — PASS: актуальний session-invalidated синхронно прибирає DOM/record у тому самому стеку beforeunload; actual nonJSON last-session401 проходить Foundation revoke, private DOM/storage порожні, execute0.
- Reports `/tmp/tsukenya-campaign-draft-proof/{pending-create,pending-update,auth-sync}-report.json`; terminal logs `/tmp/tsukenya-campaign-{pending-create,pending-update,auth-sync}-final.log`.
- Unit7 `/tmp/tsukenya-campaign-followup-unit.log`, scoped lint і matching TypeScript/Vite build PASS `/tmp/tsukenya-campaign-followup-{lint,build}.log`; harness syntax/diff guard PASS.

Перший delayed CREATE assertion помилково очікував blank decimal після очищення лише гривень за наявних `00` копійок (чинний MoneyField правильно дає `0.00`). Failure artifact лишився; fixture тепер явно вводить invalid `0.00`, лише цей affected stage повторено. Cleanup звільняє held route і при failure. Старі вісім prefixes/stories/server proofs вище reuse; whole wrapper/full/production не запускались. Нові три stages додані до майбутнього explicit family wrapper, незмінний flag `QA_CAMPAIGN_DRAFT_FROM`.
