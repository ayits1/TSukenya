# Відновлення п’яти дій замовлення

B06: actual native `TradeOrders` reserve / release / expire / close /
expected_date підключені до прийнятої P0 same-tab/same-session foundation.
Це окрема сім’я; решта P2/P3 не оголошуються завершеними.

## Контракт

`NativeOrderAction` і `TradeOrderRecovery` зберігають лише whitelist raw:
reason, quantity, expires_on, expected_date та впорядковані line ID/quantity.
Невалідні нові рядки не нормалізуються й не замінюють frozen request. Окремо
зберігаються скалярна початкова ідентичність id/kind/store, control revision,
стан/дата спостереженого замовлення, UUID і точний перший body. Контексти,
FEFO limits, grants, permissions, зарплата, receipt history й повний документ
не потрапляють у storage. Quota перевіряється до business fetch.

- POST `/api/v1/trading/order-actions/execute`: exact `{id,kind,store,body}`.
  Body лишається чинним legacy `orders.mutate` canonical input. Авторитетні
  Django Decimal, FEFO, строк, actor/store/kind та LedgerLock незмінні.
- POST `.../identity`: `{request}`; READ ONLY REPEATABLE READ, fresh actor,
  creator/order/hash binding. `confirmed:false` не доводить відсутності запису.
- GET `.../context`: id/kind/store/action та reservation лише для release.
  Scalar-unique query, JS-safe positive IDs, fresh actor і READ ONLY RR;
  жодних get_or_create, audit чи LedgerLock записів. Selected reservation
  дістається за exact ID незалежно від першої сторінки історії.

ACK `order-action-v1` містить exact request і compact outcome
`{id,revision,state}` з незмінного `OrderOperation`. Replay перевіряє чинні
права і creator/order/hash до mutable status/revision. Історична revision
має дорівнювати observed control revision + 1. Це **не** voucher revision і
**не** поточна editing baseline. Нових receipt таблиць/міграцій немає.
Target reader defer payload; історична receipt читається selected scalar
projection. Legacy expected_date без OrderControl проходить SQL type/byte
межу до Python; підтримуються чинні falsy fallback, а непідтримуваний
object/array/довгий scalar дає явну помилку конкретного документа.

## Реальні переходи

Кожна з п’яти кнопок захоплює source identity перед першим await. Raw input
пишеться синхронно. Перший запит запису frozen до fetch; точний type=button
retry доступний попри newer invalid input. Після reload невідомість не
зникає. Positive identity/ACK записується durable **до** independent current
GET; його 503 не відновлює повтор уже підтвердженої дії. Current comparison
не міняє baseline: Apply локальний, наступний Save/дія окремі.

Лише перша live спроба може прийняти exact bound no-write proof після
rollback domain400 або order_revision409. Auth/collision, postcommit
response failure, reload/попередній unknown та пізніший4xx такого дозволу
не дають. Незмінні old legacy endpoints лишаються сумісними.

Свіжі session/resource reads проходять P0 verifyRead: поля й заголовок
приватної форми приховані; allowed raw переживає503 із GET-only recovery.
Чинний401/identity role/store change очищає private storage; denied resource
підпорядкований P0 окремій політиці. Cancel/hash/generation/visibility/abort
fences перевіряються після останнього await до mutation. Restore ніколи не
виконує бізнес-запис; cold restore монтує actual sales/purchases.

## Перевірки

Ізольована PostgreSQL база `tsukenya_order_action_qa` localhost61144.
`tests.test_order_action_recovery`: початкові6 нових сценаріїв та випадково
виявлені імпортом14 unchanged B10 тестів PASS; імпорт виправлено, повтору
unchanged набору немає. Нові targeted scalar/safeint та legacy selected
JSON/falsy parity PG1+PG1 PASS; останній також SQLite1 PASS. Покрито п’ять
дій, no cash/stock movement changes, creator/role, RR/no-DML, exact replay,
rollback/collision і реальні два паралельні same-key запити (один резерв,
один audit). Typed codec unit5, TypeScript, scoped lint, matching Vite build
та JS syntax PASS. Shared P0 RecoveryPanel/controls unchanged: їх попередні
Story/keyboard докази reused, нових shared control немає.

Native harness: `tests/order-action-reload-ui.cjs`, disposable SQLite18289,
лише bundled headless Chromium; stages перевіряються до temp/server,
успадковані DB/PG/settings очищені. finally закриває Chromium та чекає
SIGTERM/SIGKILL з exitCode **і** signalCode; видаляє лише власні дані.

```sh
PYTHON_BIN=/tmp/tsukenya-review-venv/bin/python \
QA_ORDER_ACTION_FROM=guard \
QA_OUTPUT_DIR=/tmp/tsukenya-order-action-proof/guard-fixed \
node tests/order-action-reload-ui.cjs
# Незалежні stages: actions, remaining, final-actions, policy, role,
# validation, expiry, cold, compat. Full suite не запускали.
```

Actual proofs `/tmp/tsukenya-order-action-proof/`:

- `actions/actions-partial.json`: reserve lost committed ACK → invalid raw
  reload → creator identity → current → one operation; actual1440/320 PNG.
- `remaining-fixed/remaining-partial.json`: exact old release з history page2
  серед65 reservations і expire мають ті самі business barriers PASS.
- `final-actions/final-actions-report.json`: close й expected_date terminal
  PASS, blank date clears лише explicit action; positive close identity
  durable перед independent current503/reload.
- `guard-fixed/guard-report.json`: unknown → reload → later409 та falseidentity
  зберігають key/body; live-first revision409 → local Apply → separate action;
  quota до execute fetch PASS.
- `policy-fixed/policy-partial.json`: readonly503 hides/GET-only raw retry,
  cancel ignored-abort issued401 без пізньої redirect/erase/action PASS.
- `role/role-report.json`: actual fresh role revoke hides heading/body,
  clears changed-session raw, writes0 terminal PASS.

Це prefix/tail evidence; жоден перерваний первинний run не названо повним
PASS. Знайдену сторонню freshness policy race Sales/Purchases/Finance/Staff
передано root; цей пакет не копіює її WIP. Capacity,100k та production тут
не перевірялись. Фізичні записи/roles/period/FEFO не замінюються browser
арифметикою. Наступні результати cold/validation/expiry/compat додаються
окремо після terminal proof.

Окремі terminal tails:

- `validation/validation-report.json`: actual first past-date400 rollback
  proof → raw correction → readonly current/Apply → separate new key PASS.
- `expiry/expiry-report.json`: actual PortalSession deletion → current401;
  beforeunload private form hidden, private storage erased, writes0 PASS.
- `cold-fixed/cold-report.json`: overview → explicit cold Restore → actual
  purchases; invalid raw date retained, current/Apply readonly, separate clear
  action PASS. Before-fix trace `cold-trace/failure-state.json` довів, що
  неактивний `portal-draft-recovery.prepareInline` скасовував restore на
  hashchange; early return без mounted fields до check виправляє саме це.

1440 і320 screenshots оглянуто: modal/raw/current comparison без
горизонтального обрізання. Старий B10 fixture retargeted без втрати business
assertions; його Escape→row focus ще не пройшов на старому accepted viewer,
який захоплює opener після GET/React busy. Це незалежна viewer integration
межа, не заявлений compatibility PASS; original expected focus лишено.

## Additive інтеграція та opening privacy

Власний пакет ребейзовано на accepted673e84d; standalone voucher-actions
script/routes/native exports і всі попередні guards збережені. Matching
build PASS. Compact viewer source `_documentActionSource` підтримується
поряд із чинним `_confirmedVoucher`; у recovery не копіюється full header
чи grant. Old fixture бере reservation history через actual tab, якщо
підключений bounded viewer, і зберігає всі original business assertions та
44px gate для реальних видимих дій (hidden recovery CTA не touch targets).

`opening/opening-report.json` terminal PASS: реальна owner→accountant зміна
перед reserve entrypoint; old source heading/body/foot ховаються **до**
fresh session/context, denied403 лишає public readonly retry, raw form не
монтується, business writes0. Reading/session та old modal generation fences
залишаються окремими від pending business intent.

Private compatibility QA `/tmp/tsukenya-order-action-viewer-qa` мав dependency
viewer root2b5cdab + own0436 + test-only compositionfe5a. Частковий
`compat-viewer-visible` довів opener focus,44px, immutable lost-ACK repeat,
stale409/local Apply, source revision і partial sale/reserved quantity;
далі зупинився на реальному viewer RAC per-reservation Enter callback, що
не досягав native handler. Це передано viewer author/root; його sourcefix
не включено до власної доставки. Нема заяви whole compat PASS, original
Enter assertion збережена. Stage `release` перевіряє exact ID на page2
65-record history для обох50/30-page DTO; target — шостий старий запис,
не перший ID за припущенням. Новий viewer keyboard/pointer callback окремо
перевірив його автор; доказ stage release сім’ї не повторювали. Інші
завершені family/PG перевірки не повторювалися.

Фінальний власний source baseline — accepted105e2e3 (PR123); лише own range
після нього. Matching build повторено після additive rebase; unchanged PG/
unit/native inputs reused. Order controls не додають нової політики закритих
фінансових періодів: чинні права/FEFO/date/control rules лишаються server
послугами; фінансові проведення не змінюються.

Для compatibility tail дозволено `QA_ORDER_ACTION_FROM=compat-tail`:
ізольований synthetic checkpoint створює еквівалентні два резерви та
partial sale/reserved1 через unchanged server services. PASS prefix не
повторюється; всі наступні original release0.500/close used1/date-clear/
optional minimum/audit assertions лишаються.

## Остаточний affected compatibility tail

`QA_ORDER_ACTION_FROM=compat-tail` terminal PASS у private QA composition
`ad45c21612ae1465826453ad7e498f3ca904087b` (viewer b1d6905 поверх692e8de,
own tests/controller copied з869f092 + нижчеописаний selector fix).
Команда — та сама isolated command вище з
`QA_OUTPUT_DIR=/tmp/tsukenya-order-action-proof/compat-tail-final`.
`compat-tail-report.json` має три явні action POST: release0.500, close і
expected_date blank. Перевірено reserved0.5 → reserved0/used1, date null,
нові optional minimum/date порожні, actual44px external voucher submit
buttons, owner business audit before/after/reason та Escape focus.
`order-1440.png` і `purchase-terms-320.png` переглянуто, обрізання немає.

Перший tail дійшов до purchase-terms geometry і виявив лише тестовий
selector без `button[form=tradeVoucherForm]`; він виправлений без зміни
44px/count>0 assertions. Failure artifacts збережено у `compat-tail/`.
Доказ не означає новий whole-old-family run: попередній успішний prefix
перевикористано, цей tail почався з еквівалентного partial checkpoint.
Viewer source/QA ancestry до власної доставки не входить.

## Інтеграція на прийняті PR124/125

Private checkout `/tmp/tsukenya-order-action-integration`, base
`9bdb3387b5c1242c5b30e341ae634c633067b06e`: PR124 bounded viewer і PR125 Docker
вже прийняті та розгорнуті. Pending catalogue пакет не включено.
Власні frozen commits перенесено без private QA/viewer dependency commits.
Єдиний textual conflict — `frontend/src/native-conflict-entry.tsx`:
збережено імпорт, Window type та runtime export для обох `NativeDocumentView`
і `NativeOrderAction`. Автоматично merged ERP/hooks зберігають прийнятий
viewer read/grant/action-host dispatch. Static byte comparison усього
`documentActions`/`viewVoucher` region з accepted base PASS.

Full runner реєструє default п’ять дій Order5 і окремі guard/policy/validation/
expiry/cold/opening stages; exact inherited `QA_ORDER_ACTION_FROM` очищено.
До document-details додано окремий `QA_DOCUMENT_VIEW_STAGE=actions`:
actual page2 reservation Enter/pointer → exact context/no POST. Його selector
також уже очищається. Existing original B10 registration збережено; нова
Order5 registration не додає дублювання compat-prefix/tail до full run.

Нова перевірка інтеграції: types і matching frontend build PASS; JS syntax
семи змінених modules/tests/runner, OpenAPI JSON, entry format, diff check,
`makemigrations --check --dry-run --noinput` (isolated SQLite, no schema
changes) PASS. `npm run test:full -- --plan` PASS, без тестів/контейнерів/DB.
Static registry assertion підтвердив exact stage names/selector scrub і два
exports. Runtime поведінка при resolution не змінювалась; попередні PG/unit,
п’ять native action сімейних proofs, final compat-tail і авторський page2
Enter/pointer proof перевикористано без повтору. Browser/server не запускали.
