# B06 P1 · Чернетка табеля після reload

База: прийнятий `fc275695aa75ff638459a06e1b23a13bdfc46c3b`. Реальний consumer — `app/erp.js:workShiftForm`; P1 загалом ще незавершений. Рецепти, категорії, місячний план і шаблон бюджету — наступні сім’ї; P2/P3 не реалізовані цим пакетом.

## Межа

- Той самий tab/session: синхронні input/change і явні програмні зміни касової зміни/Apply зберігають лише named employee/date/cash_shift/units/shift_rate/bonus_percent/bonus_basis/note. Числові поля — text+inputmode: `1e-`, `-`, порожній текст і зайва точність не замінюються нулем. Save-validator окремий.
- Перший UUID/body/revision записано до fetch; quota блокує business POST. Новіші некоректні поля не змінюють цей запит. CREATE unknown після reload або пізнішого4xx — точний type=button retry або явне read-only identity. UPDATE unknown — поточне GET/порівняння/Apply/окремий Save; немає blind replay UPDATE.
- CREATE ACK strict `{id,type:'work_shift',request_key,request}` зв’язує саме firstkey і повний початковий запит. Сервер використовує чинний creator+request fingerprint receipt. Identity повертає тільки підтверджений ID і той самий запит; не вигадує історичний author/revision, не читає поточну ревізію як baseline. Міграції немає, старі receipt лишаються чинними.
- ACK/identity → confirmed ID + обов’язковий current-read/review barrier. GET503 ніколи не запрошує новий CREATE. Current GET та Apply не стирають новіші invalid поля й не записують зарплату. Apply приймає лише перевірену ревізію й атомарну групу умов, Save виконується окремо.
- Fresh session і RR resource context перед приватним DOM, fresh `verifyRead` для current/identity/реквізитів; зареєстрований P0 codec `native-workshift-v1`. Resource403 того самого сеансу стирає лише цей record; зміна ролі/магазину/сеансу й401 стирають session-bound записи. На503/protocol приватні heading/body приховано, allowed draft збережено, public retry лише перевіряє доступ. Warm reauthorization повертає ту саму форму; cold Restore явний і чекає actual staff mount з abort/route/30sec fence. Перед renderer перевіряється signal. Close recovery dialog не очищає відновлений editor.
- Відоме payroll/закритий період не забороняє переглянути й виправити локальний raw draft. Це не дозвіл Save: чинні server locks/period/rates/role/store і payroll participation залишаються авторитетними.
- Live-first400 може відпустити first intent лише з key/type-bound `write_rejected` навколо атомарного rollback `work_shift_save`. Conflict/403 і помилка після commit цього proof не мають. Після ambiguity/reload навіть такий пізніший400 не відпускає intent.
- Зарплатна економіка незмінна: units множить ставку; відсоток від виторгу вибраної касової зміни — один раз. Підтримувані legacy personal/profit bases не переписуються. Нарахування, відсоток, історична хронологія й виплата — Django/PostgreSQL. Browser не розраховує salary чи payroll totals.

## API

`GET /api/v1/trading/work-shifts/recovery-context?id=&store=&employee=` — fresh role/store, exists/canEdit без wage SQL; raw date/rate тут не валідовуються.

`POST /api/v1/trading/work-shifts/identity {request:firstBody}` — CSRF-protected READ ONLY RR, creator/fingerprint/scope bound. `confirmed:false` не доводить глобальну відсутність UUID й не запускає запис.

`GET /api/v1/trading/work-shifts/current?id=` — exact1 page чинного legacy DTO, fresh actor + role/store під READ ONLY RR. Кожне читання окремий snapshot; persisted immutable snapshot не заявляється.

Legacy POST/GET збережено, CREATE ACK additive; UPDATE ACK лишається `{id}`. OpenAPI в `contracts/trading.openapi.json`, typed codec в `frontend/src/shared/native/workShiftPersistence.ts`.

## Перевірки й точні докази

- Unit4: `npm run test --workspace frontend -- src/shared/native/workShiftPersistence.test.ts` — PASS: invalid raw vs frozenbody, ACK/key/terms, confirmed baseline/current barrier, Decimal spelling cleanup, current scope/payroll-read boundary. Typecheck/lint/Prettier/Vite й JS syntax/diff — PASS.
- PostgreSQL3, distinct DB `tsukenya_workshift_reload`: `tests.test_work_shift_recovery`. Initial validation/postcommit test PASS; перші2 fixture помилки JsonResponse виправлено, повтор лише цих2 після конкретного context SQL/routing fix PASS. Logs `/tmp/tsukenya-workshift-pg.log` та `/tmp/tsukenya-workshift-pg-tail.log`. Fresh actor role/store/deactivation, RR/READ ONLY/no-DML/no-wage-context-SQL, identity after mutable edit/creator/UUID/exact retry/no audit duplication, first400 rollback vs postcommit.
- Bundled headless actual native, own matching frontend build, port18280. Початковий primary **частковий**: cold Restore з overview, raw `1e-`/`-`/overprecision, write-free1440/320/44px PASS; `/tmp/tsukenya-workshift-reload-proof/primary-partial.json`, `workshift-raw-restored-1440.png`, `workshift-raw-restored-320.png`. Далі fixture очікував старий текст Save після confirmed ID; повний primary PASS не заявляється.
- CREATE stage **частковий**: `QA_WORK_DRAFT_FROM=create QA_OUTPUT_DIR=/tmp/tsukenya-workshift-create-proof node tests/workshift-draft-reload-ui.cjs`. `/tmp/tsukenya-workshift-create-proof/create-partial.json`: real committed lostACK→reload, exact later bound400, confirmedID/current503→reload onlyGET, invalid raw retained, Apply local/separateUPDATE/terms, quota-before-fetch PASS. Далі fixture чекав несвіжий staff list після Python setup; виправлено явний reload, повторено лише tail.
- UPDATE/privacy tail **terminal PASS**: `QA_WORK_DRAFT_FROM=tail QA_OUTPUT_DIR=/tmp/tsukenya-workshift-tail-proof node tests/workshift-draft-reload-ui.cjs`; `/tmp/tsukenya-workshift-tail-proof/tail-report.json`: unknown UPDATE→reload/current503/private-hide/publicGETretry, явний note conflict choice/Apply/Save freshrevision; actual role→manager між preflight/current403, hidden payroll/head/body і cleanup, no extra writes.
- Policy **частковий**: `QA_WORK_DRAFT_FROM=policy QA_OUTPUT_DIR=/tmp/tsukenya-workshift-policy-proof node tests/workshift-draft-reload-ui.cjs`; `/tmp/tsukenya-workshift-policy-proof/policy-partial.json` доводить actual closed-period first400→date correction→one save. Подальша identity гілка зупинилася через stale `E.closed_through` у fixture після direct setup; create helper тепер reload. Цей policy tail не повторено й не оголошено PASS. Строгий identity/current/Cancel/expiry механізм покрито unit/API та прийнятою P0/entity foundation, але окремий workShift native identity/Cancel/actual401 tail лишається неперевіреним runtime.

Для native команд додати `env -i PATH="$PATH" PYTHON_BIN=/tmp/tsukenya-review-venv/bin/python`; DB/PG/OWNER/settings env прибираються, власні tmp/data і сервер teardown очікується з signal/timeout guards. Системний Chrome не використовується. Нова stage allowlist undefined/create/tail/policy.

Чинні `tests/work-shift-conflict-ui.cjs` interceptions перенесено на versioned current API і public authorization retry. Усі вихідні B04 assertions distinct same-day tills/receipt/current409/atomic terms/Apply-noPOST/actual payroll600 збережено. Старе «403 зберігає видимі salary fields» замінено privacy boundary; цей старий native family заново не запускався. Незмінні B04/B05 posting/concurrency/chronology та shared AtomicTermsKeyboard Story докази reuse; повної регресії, capacity, production/release, physical devices чи screenreader перевірок немає.
