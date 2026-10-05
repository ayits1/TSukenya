# B06: відновлення одинадцяти дій ініціатив

База `d35b6149f062b29181eaed94910d0df177ca525b` (accepted PR115).
Межа: create/edit/start/complete/result_edit/cancel/task_create/task_link/task_update/
expense_attach/expense_detach у реальному `app/initiatives.js`. Серверні readers,
strict domain codec і всі реальні форми підключено до P0. Це окрема сім’я;
завершення всього B06 не заявляється.

## Незмінні правила

Authoritative `initiatives.mutate()` не змінено: ledger lock, fresh active owner,
scope, canonical key, exact historical replay, revision checks, KPI/Decimal,
whole-expense attribution, audit й ProjectOperation receipt зберігаються.
ProjectOperation уже містить достатній actor/project/key/fingerprint/result;
міграцій немає. Attach/detach витрат допускаються також для completed/cancelled
проєкту. Detach не додає вигадану voucherRevision і не змінює проведення витрати.

## Read contracts

- `GET /api/erp/initiatives/recovery-context`: тільки короткі scalar
  action/project/idea/task/voucher/store, exact набір параметрів для дії; duplicate
  query keys заборонені. Read-only RR і fresh owner всередині snapshot.
  Повертає `initiative-recovery-context-v1`, чинний actor scope, scalar plan/result,
  exact project revision або idea/task token64 і selected source, canWrite/reason.
  Source missing/ineligible лишає primary project доступним із canWrite=false.
  Foreign scope/недоступний primary повертає403. Закритий стан не є втратою grant.
  Exact `selection` envelope повертає requested project/idea/task/voucher/store;
  selected create store відділений від actor storeId. Missing source не стирає
  expected ID, тому consumer може відхилити відповідь для іншої вибірки.
- `POST /api/erp/initiatives/operation-identity`: **тільки читання**,
  `{project: null|canonicalUUID, request: exact frozen body}`. Existing serializer
  `sha256(json.dumps([project_id,value],sort_keys=True,separators=(',',':'),
  ensure_ascii=False,allow_nan=False))` не нормалізує raw/decimal/null/omitted.
  Current primary grant + actor/key/route/fingerprint перед positive receipt.
  Відсутність receipt — confirmed=false, не доказ відсутності запису.
  Positive `initiative-operation-identity-v1` містить project/appliedRevision,
  observedRevision/observedIdeaRevision, key/action/routeProject; історичний
  plan/tasks/expense payload не повертається і не стає current baseline.
- Scalar extraction `result__project__id/revision` не матеріалізує весь receipt.
  Expense context читає тільки header і JSON scope/category; task token потребує
  одного поточного Document.data, але DTO повертає лише whitelist.
- Чинні list/detail/options/idea/candidates/source readers тепер теж refresh-ять
  cached HTTP actor всередині RR. Окрема server mutation authority незмінна.

## Перший серверний доказ

`tests.test_initiative_drafts`: **6 PASS, PostgreSQL18, 1.540s**.
Усі11 типів actual operation receipts після наступних змін; exact raw/decimal
serializer та creator/key/route; old expense receipt після detach; closed-project
expense eligibility; missing source/foreign scope; malformed/duplicate query;
fresh role/deactivation для нових і чинних read paths; scalar projection та SQL
без DML/FOR UPDATE; concurrent project change після actor read підтверджує RR.
Ізольовані fixtures, не production.

Лог `/tmp/tsukenya-initiative-drafts-pg.log`, runner
`/tmp/tsukenya-initiative-drafts-pg.py`. Перед створенням унікальної QA ролі/БД runner
fail-closed звіряє existing QA container `tsukenya-review-pg18` із єдиним binding
`127.0.0.1:62812`; inherited DB/PG/URL env прибираються. У finally тестову БД і роль
видалено. Syntax/diff PASS. Чинні mutation/accounting concurrency proofs reused;
повна регресія, production, VPS, браузер на цьому серверному кроці не запускалися.

Additive exact-selection follow-up: лише
`test_context_exact_selection_survives_absent_sources_and_separates_actor_scope`
**PostgreSQL PASS1, 0.193s**;
`/tmp/tsukenya-initiative-drafts-selection-pg.log`. Request store відділений від
actor store, missing task/voucher залишають exact selection. Попередні PG6 reused.


## Реальні consumers і збереження

`frontend/src/shared/native/initiativePersistence.ts` — власний strict codec
`native-initiative-v1`; entry експортує його разом з чинним P0 bridge. Жодна дія
ініціативи не записується через generic task/idea adapter.

- Усі 11 кнопок відкривають реальну форму: plan/create, result/correction,
  start/cancel, task create/link/update, whole expense attach/detach. Start тепер
  має явну форму підтвердження. Чинні допустимі переходи й бухгалтерські формули
  не обмежено додатковими клієнтськими правилами.
- Raw whitelist зберігається на `input` **і** `change`, включно з committed ID
  directory control. Тимчасовий пошуковий текст combobox не стає обраним ID.
  Invalid/порожні рядки, пробіли, причини й точність десяткових полів зберігаються.
- Original scalar plan/idea/source terms і revisions відокремлено від raw.
  `frozenRaw` + перший exact method/path/key/body/revision записуються атомарно
  до send. Нові поля не змінюють retry. Ключ create record — SHA256 idea ID;
  existing record належить project UUID; authorize звіряє ідентичність повторно.
- Перший достовірний live400 (без code) або409 revision_conflict / create
  initiative_exists переводить у durable review. Пізніший4xx після unknown/reload
  не звільняє intent. 403, idempotency_conflict і malformed response не є таким
  доказом. Відсутність identity також не звільняє запит.
- Live `{ok:true,project}` проходить project/idea/store/next-revision binding і
  session/generation fence; з нього записується тільки scalar confirmation.
  Історичні ACK fields не підставляються як current baseline або приватний view.
  Unknown читає readonly identity після fresh P0 session/primary grant на сервері:
  positive confirmation durable **до будь-якого current context GET**. Навіть
  постійний current503 не повертає exact retry після reload.
- Окремий exact-selection current context з fresh role/scope потрібен до reveal,
  comparison чи Apply. confirmed=false сам по собі не дозволяє показати raw.
  Missing/ineligible source лишає дозволений primary raw, блокує Save; чужа
  область доступу приховується. Source expense GET повторно звіряє primary/link
  після останнього await, тому readable generic expense200 не дає права показати
  відв’язане історичне джерело.
- Restore explicit, Apply local, Save окремий. Plan/result використовують чинний
  shared three-way component; KPI metric/unit/target — одна група. Зміна KPI
  вимагає нового явного fact. `reason` лишається поза merge полів результату.
  Disabled controls читаються напряму з `form.elements`, тому FormData не стирає
  введення під час comparison. Source actions показують поточні scalar terms.
- Quota блокує send, Apply й небезпечне Close, зберігаючи попередній durable запис.
  ACK quota лишає первісний intent для readonly identity recovery. Cleanup лише
  після positive confirmation + independent current read і збігу frozen/new raw;
  новіші поля залишаються локально. Discard проходить чинне explicit P0 confirm.
- Закриття/route/скасований401/JSON мають lifetime fence; fresh role change ховає
  dialog/list і P0 видаляє старий binding. Recovery public gate не показує raw.
  Власний `pending()` захищає native dialog від конкурентної inline P0 підготовки;
  `portal-draft-recovery.js` має тільки additive перевірку цього pending.
  Після приватного reread або заміни list DOM фокус повертається до чинного
  заголовка/кнопки того самого проєкту, якщо користувач ще не змінив фокус.

## Цільові frontend докази

Unit `initiativePersistence.test.ts`: **8 PASS**, усі11 body schemas, exact
primary/secondary envelope (також source=null), malformed enum/scope, raw/frozen
розділення, bound positive receipt/ACK, first rejection, atomic KPI, реальний
DraftStore quota confirmation/Apply. TypeScript/Vite matching build, targeted
TS lint/format і JS syntax/diff PASS. Shared P0/comparison/controls не змінювалися;
їхні Storybook proofs reused.

`tests/initiative-draft-reload-ui.cjs`: disposable SQLite, env DB/PG/URL scrub,
синтетичні користувачі/товари, bundled Chromium `headless:true`, cleanup finally.
Business write counter відділяє readonly POST operation-identity.

| Scope | Фактичний доказ / артефакт |
| --- | --- |
| lifecycle | Усі11 дій/11 receipts, closed expense detach, empty P0 integration. `/tmp/tsukenya-initiative-lifecycle-final.log` |
| raw | Invalid raw close/reload, explicit Restore/Apply noPOST, separate Save,1440/320. `/tmp/tsukenya-initiative-raw-final.log` |
| unknown | Lost task_create ACK, newer invalid raw, exact retry, later409 immutable, один task. `/tmp/tsukenya-initiative-unknown.log` |
| create | Lost CREATE + reload з idea/store/hash, exact retry попри вже створений project, один project. `/tmp/tsukenya-initiative-create.log` |
| confirmed | Positive identity при current503 від початку; durable confirmation до current, reload без retry. `/tmp/tsukenya-initiative-confirmed-independent.log` |
| ack | Live ACK/current503/newer invalid raw/reload; жодного другого POST або ACK baseline adoption. `/tmp/tsukenya-initiative-ack.log` |
| rejected | Current preflight200 → інший writer → first409 → reload/merge Apply noPOST → explicit Save. `/tmp/tsukenya-initiative-rejected.log` |
| validation | Selected active store деактивовано між preflight/POST: actual first400; raw/review/Apply/separateSave. `/tmp/tsukenya-initiative-validation-public.log` |
| privacy | Owner→cashier hides list/form і стирає old binding; повернення owner не відкриває старий memory raw. `/tmp/tsukenya-initiative-privacy.log` |
| guards | Close during preflight noPOST; ignored-Abort late401 не інвалідує новий session/raw. `/tmp/tsukenya-initiative-guards.log` |
| quota | Before-send/Close/ACK storage failure; receipt recovery без дубля. `/tmp/tsukenya-initiative-quota.log` |
| source | Held generic expense200 → detach → final grant refuses historical source reveal. `/tmp/tsukenya-initiative-source.log` |
| layout | Public store change durable до Save, reload committed ID, settled header/actions1440/320. `/tmp/tsukenya-initiative-layout-settled.log` |

Команда вузького scope:

```sh
PYTHON_BIN=/tmp/tsukenya-review-venv/bin/python \
QA_INITIATIVE_DRAFT_FROM=confirmed QA_OUTPUT_DIR=/tmp/initiative-proof \
node tests/initiative-draft-reload-ui.cjs
```

Повний registry реєструє кожен scope явно та очищає успадковані narrow selectors;
звичайна розробка запускає лише affected scope. Незмінні PG6 + affected selection1,
ledger/receipt serialization/lock-order proofs повторно не запускалися.

## Межі

Цей пакет не оптимізує all-active options users/stores, не створює загального
adapter для іншої B06 family, не змінює money/stock/expense attribution,
не вводить нових моделей/міграцій/transition rules. Physical screen reader і
інші browser engines не перевірялися. Production/VPS/Sheets/full regression
не запускалися. Private raw не переноситься між role/store/login bindings.


### Сумісність чинних тестових consumers

- `tests/initiatives-ui.cjs`: збережено всі default assertions. Explicit Start,
  editable newer raw, visible-only geometry та keyboard Space для Aria radio
  відповідають чинним controls. У `...compat-final` префікс create/task/exact
  retry/source-task conflict пройшов до старого pointer-click radio. Решта
  conflict/expense/source/reverse/result/qualitative/audit пройшла окремим
  **terminal PASS** `/tmp/tsukenya-initiative-compat-tail-final.log` з
  `QA_INITIATIVE_COMPAT_FROM=conflict`; authoritative cash_opening fixture
  відтворює передумову первісного CRM harness. Цілий ранній run не названо PASS.
- `tests/initiative-conflict-ui.cjs`: same/unrelated fields, atomic KPI, cancelled
  GET, malformed context503/enum/ID, closed state, fresh fact і semantic opener
  пройшли в `/tmp/tsukenya-initiative-conflict-final` до останнього403 fixture,
  який помилково очікував JSON від HTML403. Окремий
  `QA_INITIATIVE_CONFLICT_FROM=privacy` **terminal PASS** у
  `/tmp/tsukenya-initiative-conflict-privacy-final.log` довів actual403, hidden
  private form і видалення old-role record. Fresh session завершення очікується
  перед перевіркою storage; synchronous hide перевіряється окремо.
- В обох default suites assertions не вилучено й немає silent skip. Explicit
  partial selectors очищаються full runner. `test:full -- --plan` PASS — лише
  реєстр, не запуск повної регресії.
- Initial raw proof знайшов FormData/disabled-fields loss і був виправлений;
  initial geometry враховував hidden retry, а early B20 fixture не мав коштів.
  Failure artifacts збережено поряд із terminal tails. Actual lifecycle
  попереднього ACK path reused; additive direct-ACK barrier має власні8unit,
  ACK/current503 і create/compat підтвердження, без повтору всіх11 дій.
- Final settled1440/320 PNG оглянуті: header/Close у viewport, recovery actions
  мають проміжки, форма не створює горизонтального переповнення.
- Додатковий `coexistence` scope перевіряє repeated ordinary inline prepare
  під час active initiative form: raw/DOM незмінні, немає network/render loop,
  current role change надалі приховує private form/list. Його результат
  перевіряється окремо на інтегрованій версії з обома pending guards
  (`ManagedAlerts` і `BusinessInitiatives`); авторська base — PR115.

## Інтеграція з прийнятим main · 05.10.2026

Пакет інтегровано після прийнятих PR116–120. Обидва pending guards
(ManagedAlerts і BusinessInitiatives) збережено; QA env registry містить
об’єднання чинних cash/settings/managed/facets та initiative scopes.
Один додатковий actual UI scope `QA_INITIATIVE_DRAFT_FROM=coexistence`
успішний: десять повторних prepareInline зберігають активну форму і raw
без циклу читання/рендеру; актуальне відкликання ролі приховує форму/список,
бізнес POST відсутні. Matching frontend build, синтаксис, diff check,
статична browser policy PASS; full runner лише `--plan`. Незмінені
серверні та індивідуальні native proofs вище використано повторно.
