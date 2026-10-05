# B06: керовані задачі після reload

База: accepted `e50f85258d6b488b90fbb248bd73af9937a9bdd6`.
Цільова сім’я — auto/reprint accept/defer/complete/resume та raw відкладення.
Backend commit `f093610` і наступний consumer commit покривають цю сім’ю цілком.
Actual `ManagedAlerts` підключений до P0; весь B06/P2 не оголошується виконаним.
Звичайні задачі/ідеї/DELETE та 11 дій initiatives — окремі сім’ї.

## Read contracts

- `GET /api/erp/alerts/tasks/{id}/recovery-context`, без query: strict
  `managed-alert-context-v1`, поточний role/store/networkOwner, whitelist task
  identity/title/revision/scope/store/cycle/active/workState/until/reason і canAct.
  Inactive condition дозволяє читання, але canAct=false; завершений reprint має
  canAct=true через чинну можливість resume. Остаточну дію вирішує сервер.
- `POST /api/erp/alerts/tasks/{id}/identity` з `{request: exact original body}` —
  **read-only**. Жодного business action, ledger lock або DML. Fresh active actor
  всередині READ ONLY RR і поточна visibility/scope перед receipt lookup.
  Missing task не надає історичного grant і повертає403.
- `AlertTaskAction` уже містить UUID/author/task/fingerprint/appliedRevision/cycle.
  Identity повторює точну існуючу JSON serializer семантику, включно raw reason
  та написанням UUID, без нових separators/нормалізації. Чужий author/task/body —
  409; відсутність receipt — confirmed=false, це не proof відсутності запису.
  Positive DTO містить key/task/action/observedRevision/appliedRevision/appliedCycle.
  Current revision/cycle читаються окремо й не підміняють первісний результат.

`managed_alerts.action`, порядок lock/authorization/receipt/revision та його
response shape не змінено; міграцій немає. Вихідний lifecycle описано у
`MANAGED-ALERTS.md`.

## Цільові докази першого backend commit

`tests.test_managed_alert_drafts`: **6 PASS, PostgreSQL18, 0.831s**.
Контекст різних ролей/read vs act; raw serializer/uppercase UUID parity;
creator/task/fingerprint mismatch; absent receipt/missing task; fresh current
actor після HTTP auth; підтвердження старої дії після resolve/cycle2; capture SQL
без DML/FOR UPDATE та реальний RR при конкурентній зміні задачі.

Лог: `/tmp/tsukenya-managed-drafts-pg.log`. Runner:
`/tmp/tsukenya-managed-drafts-pg.py`; existing disposable local
`tsukenya-review-pg18`, перевірений `127.0.0.1:62812`, унікальна роль/тестова БД,
production environment scrub, synthetic credentials, finally cleanup.
Тестову БД й роль видалено. Python syntax PASS. Existing mutation/concurrency
oracle не повторювали: mutation inputs/source незмінені.

## Actual consumer та переходи

- `frontend/src/shared/native/managedAlertPersistence.ts` — strict codec payload,
  контексту, creator identity і локальних transitions. Через `native-conflict-entry`
  доступний як `NativeManagedAlertPersistence`; P0 storage/controller не змінено.
- `app/managed-alerts.js` — реальний consumer усіх 4 дій для auto/reprint, рядки
  поточного списку й огляду. `accept/complete/resume` тепер мають коротке явне
  підтвердження; `defer` використовує ту ж форму з датою та причиною. Відповідна
  кнопка в рядку відкриває форму, окреме підтвердження надсилає дію.
- Детермінований ID `managed_<task-id>` не дозволяє після reload створити другу
  дію повз збережений unresolved record. UUID запиту окремий. До P0 authorization
  видно тільки існування запису; приватний payload не читається й не малюється.
- Raw `until/reason` зберігається синхронно без trim і без Save-validation.
  Baseline — whitelist initial task projection/revision/cycle; permission grants,
  session credentials, весь Document.data, caches не серіалізуються.
- До business POST durable first UUID/body/revision і newer raw. Exact retry —
  `type=button`, не залежить від валідності нового введення. Відсутність receipt
  і будь-який пізніший400/409 після unknown/reload не змінюють firstIntent.
- **Перший live definite400 без code або409/revision_conflict** від цього
  atomic endpoint означає відхилений запис: лише newly-frozen attempt із живим
  response/session/JSON guard може durable перейти в review. Codec звіряє
  key/task/action/revision; raw і original baseline лишаються. Apply читає current
  і змінює локальний baseline/UUID, окремий Save виконує нову дію. Collision409,
  permission errors, malformed JSON, transport loss, повторний або restored запит
  цього переходу не отримують. Endpoint/його serializer не змінювалися.
- Success ACK веде до readonly creator-bound identity. Positive identity durable
  **до незалежного current GET**. Якщо наступний GET/list refresh падає, record
  уже confirmed: після reload доступне тільки читання або review новіших полів.
  Current revision/cycle ніколи не підміняють первісну applied identity.
- Current GET показує початкові й поточні title/store/state/cycle/defer terms.
  Apply атомарний у storage, без POST, не переприв’язує unknown intent. Save
  окремий. Старий receipt не скасовується після resolve чи нового alert cycle.
- `Закрити`/Escape/перехід маршруту зберігають raw. Quota помилка блокує write й
  закриття з незбереженим введенням. Нове введення під час POST також має стати
  durable до confirmation/cleanup; невдала quota не закриває форму зі втратою raw.
- P0 fresh session/resource context потрібний для cold Restore і warm reveal.
  Role/store binding change стирає чужі записи. Current resource403 після fresh
  P0 check прибирає лише цю чернетку; інші доступні записи залишаються. Inactive
  readable task не означає втрату receipt. Немає generic editable task bypass.
- Final session перед fetch, після fetch і JSON, generation/route/close fences
  відсікають пізні відповіді, ACK та401. Cancel не скасовує можливий уже виконаний
  серверний запис: frozen intent залишається для явної перевірки.
- Кнопка «Чернетки системних задач» у `serverWork()` і чинна глобальна P0 кнопка
  відкривають explicit recovery. Codec реєструється на native-conflict-ready.
  `canLeave()` доданий до маршрутизатора. Незавершені поточні записи пінуються
  поза сторінкою списку; доступ до них після reload через P0.

## Цільові докази consumer

`managedAlertPersistence.test.ts`: **6 PASS**, strict raw/action/task/revision,
absence vs positive identity, old-cycle/current separation, first definite rejection,
atomic quota/Apply. Matching TypeScript/Vite build та focused ESLint/Prettier PASS:
`/tmp/tsukenya-managed-build-final.log`.

Actual isolated SQLite + bundled headless Chromium:

| Scope | Перевірено | Артефакти |
| --- | --- | --- |
| raw | Empty/invalid raw → reload → explicit Restore/Apply без POST → окремий Save, exact spaces | `/tmp/tsukenya-managed-raw-approved` |
| unknown | Lost ACK, exact retry з invalid newer raw, later409 не звільняє intent, old receipt cycle1/current cycle2, Apply без POST | `/tmp/tsukenya-managed-unknown-retirement` (affected rerun після retirement fix) |
| confirmed | Positive identity → current503 → reload, firstIntent null, exact retry відсутній, GET-only recovery | `/tmp/tsukenya-managed-confirmed` |
| lifecycle | Усі accept/complete/resume/defer для auto й reprint, 8 дій/8 receipts | `/tmp/tsukenya-managed-lifecycle` |
| privacy/resource | Current role change private clear; current resource403 видаляє тільки відповідний record | `/tmp/tsukenya-managed-privacy-final`, `/tmp/tsukenya-managed-resource-final` |
| guards/late | Close на final session без POST; late successful JSON не adopted; ignored-Abort late401 не revoke | `/tmp/tsukenya-managed-guards-final`, `/tmp/tsukenya-managed-late-final` |
| cold | Existing-record gate на New action; warm/new-opening route cancellation без пізнього reveal/write | `/tmp/tsukenya-managed-cold` |
| quota/quota-late | Before-send quota та newer raw під час POST: немає запису/cleanup зі втратою введення | `/tmp/tsukenya-managed-quota-final`, `/tmp/tsukenya-managed-quota-late` |
| rejected | Actual preflight200 → concurrent writer → POST409 → reload/current/Apply без POST → separate Save; first server400 correction | `/tmp/tsukenya-managed-rejected-retirement` |
| layout | Final текст review,1440/320,44px controls, focus, немає overflow; PNG оглянуто | `/tmp/tsukenya-managed-layout-final` |

`rejected` validation400 використовує явно ізольований transport fixture: request
forward із blank reason до справжнього endpoint повертає400, frontend original raw
лишається незмінним. Це не твердження про звичайне введення порожньої причини —
цей випадок client validator відхиляє до POST. Revision409 race справжня без
підміни response/body: паралельна зміна task між preflight і business POST.

Compatibility:
- `tests/managed-alerts-bounded.cjs` тепер перевіряє actual transport lifetime,
  final-session/JSON, current vs obsolete401, exact body на unknown/later409 і
  видиму відмову при недоступному P0. Pinning/receipt/read-only assertions
  збережені в actual native тестах.
- `tests/managed-alerts-ui.cjs` default PASS: exact retry, нові raw після Escape,
  explicit local discard, справжній cron wake і completed work + active condition.
  `QA_ALERTS_FROM=read` PASS: confirmed action + metadata503 → лише читання,
  один receipt. `uncertain` використовує той самий успішний prefix default;
  окремо його повторно не запускали. Логи `/tmp/tsukenya-managed-compat*.log`.
- `tests/portal-collections-ui.cjs`, тільки `QA_COLLECTIONS_FROM=managed` PASS:
  чинний фільтр виключає committed row, unresolved record доступний поза сторінкою,
  exact UUID/body repeat і один receipt. Інші scopes не змінено/не запускали.
- `runtime-managed-refresh.cjs` PASS, його source unchanged.

Відтворення вузького scope:

```sh
PYTHON_BIN=/tmp/tsukenya-review-venv/bin/python \
QA_MANAGED_DRAFT_FROM=rejected QA_OUTPUT_DIR=/tmp/managed-proof \
node tests/managed-draft-reload-ui.cjs
```

Registry `scripts/full-check.mjs` додає explicit managed scopes і очищає
`QA_MANAGED_DRAFT_FROM` перед full. Виконано тільки `--plan`, syntax і browser-policy,
не full. Перший raw запуск зупинився до перевірок через sandbox bind
(`/tmp/tsukenya-managed-raw/server.log`); allowed local run успішний. Перший privacy
assertion перевіряв storage до завершення async session bind; додано очікування,
повтор тільки affected scope PASS, failure збережено у `/tmp/tsukenya-managed-privacy`.

Unchanged PG6/економіка/lock proofs reused. WebKit, screen reader, load/performance,
завершення всього B06, initiatives, rollout не заявляються. Full, VPS, Google Sheet,
production data, generic ordinary-task codec й catalogue не чіпали.
