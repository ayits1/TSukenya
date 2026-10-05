# B06: відновлення асортименту товару на складі

База: accepted `b3909cd`. Ціла family — actual ReactStock, перше створення та
редагування пари warehouse/product, кілька одночасних/off-page чернеток. Це не
завершення решти B06. Same-tab/same-session P0; без нової міграції.

## Погоджений протокол

- `GET /api/v1/trading/assortment/recovery-context?warehouse=…&product=…`
  і `/current` — fresh actor усередині READ ONLY REPEATABLE READ; exact selection,
  роль/store, scalar product caption/unit/default minimum та поточний рядок.
  Невідомі historical product поля не передаються до Python/клієнта.
- `POST …/identity {request: original}` — READ ONLY, без ledger/DML. Відсутність
  квитанції не доводить rollback. Current warehouse grant перевіряється до receipt.
- `POST …/execute original`, де original має exact поля
  `{key,warehouse,product,revision,unit,terms:{sold,min_stock}}`.
  Revision nullable для відсутньої пари; min_stock null означає успадкування,
  "0" означає явний нуль; unit — спостережена одиниця, без конвертації кількості.
- Ledger → fresh actor/current warehouse scope → creator+exact hash receipt →
  mutable row/product/unit/revision validation. Protected Document prefix
  `assortment_action_receipts/<UUID>` не входить у generic legacy collections.
  Existing Decimal .001, audit і sold/min_stock формули залишаються авторитетними.
- Bound write_rejected можливий лише для першої живої rolled-back400 або
  revision409. Auth, collision, outer commit/on_commit/serialization failures
  не є rollback proof. Пізніший4xx після unknown не змінює immutable intent.

## Реальний P0 consumer

Raw sold/minimum string записується синхронно на edit до await. Окремий запис на
пару; explicit Restore/Discard, existing/unreadable record не перезаписується.
ProductDTO, stock/cost rows, grant/CSRF не зберігаються. Quota блокує write без
eviction. Frozen exact body з новим UUID зберігається до fetch; новіший invalid raw
допустимий одночасно. ACK/positive identity durable перед незалежним current GET.
Apply sold+minimum атомарний, один local persist; окремий Save створює новий UUID.
Unresolved intent забороняє Apply. Unit change забороняє автоматичне переприв'язування.

## Перевірки

Backend: 4 нові SQLite цілі + 2 зачеплені legacy checks; перший run знайшов
помилкову довжину revision у новому decoder (64 замість чинних32). Після виправлення
тільки дві зачеплені цілі PASS (`/tmp/tsukenya-assortment-recovery-sqlite-tail.log`),
інші4 докази використано повторно. Первинний red log збережено.

PostgreSQL18: 5 нових цілей PASS, exact concurrency та реальний READ ONLY RR,
creator/collision/scope, postcommit callback без false rollback proof. Через
імпорт fixture class unittest також запустив13 чинних AssortmentTests: разом18
PASS3.739s (`/tmp/tsukenya-assortment-recovery-pg.log`). Fixture import змінено на
module alias, щоб надалі не повторювати ті13 автоматично. Власна локальна база
127.0.0.1:61144, env scrub; без production; власні QA role/base/test DB видалено.
Повний набір і системний Chrome не використовуються.


### Frontend та actual consumer

Інтеграція: `frontend/src/stock-entry.tsx` вимагає P0 (відсутній controller
блокує редагування), а `StockModel` делегує actual зміни в окремий
`AssortmentRecovery`. Старий RAM adapter лишається для ізольованих story/unit
fixtures; actual route не може тихо перейти на нього. Підтверджений склад і
товар утворюють стабільний SHA256 record ID. Не зберігаються ProductDTO, залишки,
ціни, CSRF або grants. Baseline містить тільки мінімальний контекст асортименту.

- Перша холодна поява existing raw пропонує Restore/Discard, не перезаписує його
  поточною сторінкою. Зміна пошуку, сторінки, складу чи native route зберігає окремі
  записи. Store quotas загального P0 застосовуються без eviction.
- Перший bound rollback response повертає raw до review; unresolved original
  лишається immutable після пізніших4xx. Atomic unit comparison sold+minimum,
  Apply одним local persist, Save окремим новим UUID. Відсутній product/нова unit
  залишає старий raw доступним для відкидання, не конвертує кількості.
- ACK/positive identity очищає firstIntent durable **до** незалежного current
  GET. Новіший invalid raw може існувати під час POST і під час GET після ACK.
  Після останнього await береться latest durable record, не попередній object.
- Кожен request має current session check, exact actor/scope binding і фінальний
  signal/generation fence. Поточний nonJSON401 закриває P0; resource403 робить
  fresh P0 session recheck і прибирає лише denied record. Старі late401 не
  зачіпають чинний сеанс. Окрема відмова stock workspace зупиняє ACK adoption.

Вузькі unit докази `persistence.test.ts` виконано інкрементально. Початковий
fixture strict-unit тест помилково змінював unit на те саме значення; виправлено
fixture і повторено тільки affected case. Додані реальні last-await
регресійні сценарії спочатку FAIL, потім PASS: raw після ACK/current GET та
workspace denial під held POST; окрема FAIL-before/PASS-after ціль зберігає
введення у pinned рядку, коли його склад більше не має caption у поточній сторінці.
Повторний edit використовує original baseline store, без переприв’язування. Решту успішних сценаріїв не повторювали.
Логи: `/tmp/tsukenya-assortment-unit*.log`, `*-current-raw-before/after.log`,
`*-deny-before/after.log`.

Actual isolated SQLite + bundled headless Chromium:

| Scope | Доказ |
| --- | --- |
| `raw` | `/tmp/tsukenya-assortment-raw-final/raw-report.json`: кілька рядків/два склади/off-filter, sync invalid raw, cold Restore Enter, Apply0POST, окремий Save, інші raw не змінені |
| `unknown` | `/tmp/tsukenya-assortment-unknown-proof/unknown-report.json`: committed lostACK, новіший raw під POST, durable identity перед current503, reload GET-only; один audit/receipt/POST |
| `rejected` | `/tmp/tsukenya-assortment-rejected-corrected-headless/rejected-report.json`: actual revision409/reload/Apply/newUUIDSave; зміна unit без автоматичного перенесення |
| `privacy` | `/tmp/tsukenya-assortment-privacy-proof/privacy-report.json`: Cancel/ignored-Abort late401, quota RAM/noPOST, current nonJSON401 |
| `scope` | `/tmp/tsukenya-assortment-scope-corrected/scope-report.json`: current nonJSON403/лише denied record, інший raw лишається; allowed owner identity змінюється на final session check — private workspace hidden/noPOST |
| `ack` | `/tmp/tsukenya-assortment-ack-proof/ack-report.json`: durable ACK, held current GET і новіший invalid raw, cold Restore, один audit/receipt/POST |

PNG `raw-final/assortment-1440.png` та `assortment-320.png` переглянуто:
читабельні controls/actions, ≥44px, без горизонтального переповнення. Геометрія
не змінювалась після цих PNG. Первинні failure artifacts збережені: ambiguous
однакові назви двох складів у helper, невибраний склад після reload, hidden-radio
`.check()` (замінили actual keyboard focus+Space), заблокований sandbox local
port. Scope fixture спершу помилково очікував збереження denied record; його
приведено до чинної P0 privacy policy з перевіркою збереження іншого raw.

Full runner реєструє всі шість нових isolated scopes і прибирає зовнішні
`QA_ASSORTMENT_FROM`/`QA_ASSORTMENT_COMPAT_FROM`. Це реєстрація, не запуск full.
Усього B06, cloud/cross-tab recovery, навантаження/100k/SLA та production
розгортання цей пакет не підтверджує. Серверні фінансові/stock формули незмінні.


Legacy consumer `tests/assortment-drafts-ui.cjs` адаптовано до `/execute` і
справжнього server revision409 (конкурентна зміна isolated row, без вигаданого
rollback proof). Усі старі assertions залишені; додано явне очікування завершення
P0 порівняння перед keyboard вибором конфлікту. Виконано тільки
`QA_ASSORTMENT_COMPAT_FROM=pending` — PASS
`/tmp/tsukenya-assortment-compat-pending-settled.log`: два склади, editable newer
raw під held POST, remount/search lock, GET/Apply0POST/Save після409, late
success/error isolation, Reset heading focus, 390/320. Початковий legacy prefix
refresh/navigation/unload у цьому запуску **не виконувався**; його assertions
залишено в default runner. Початковий console summary був надто широким для tail,
тому звужено його текст без повторення незмінених assertions. Fixture failures
односторінкового directory footer та ранішнього вибору radio до завершення
P0 remount збережено в `*-compat-pending*.log`.


Дві нові synthetic Storybook states `DurableExactRetry` та `DurableUnitChange` —
PASS2 (`/tmp/tsukenya-assortment-stories-local-deps.log`). Початковий запуск
не дістався tests: symlink dependencies поза власним Vite root не дозволили
імпортувати setup-file. Власна APFS-копія тих самих installed dependencies
усунула тільки QA-path помилку; production config/lockfile не змінено.

Остаточний matching build/TypeScript:
`/tmp/tsukenya-assortment-build-freeze.log` — PASS. Target lint/format,
OpenAPI/generated parity, Node syntax та diff whitespace перевірено окремо.
Усього11 різних unit випадків доведено цільовими/інкрементальними запусками;
це не твердження про повний повторний run усіх11 на останньому head.
