# B06 P1 · reload редакторів довідників

## Межа

Пакет від accepted `020a0d60d3c19726072830a22fec18250caaade3`. Реальні `entityForm` stores/warehouses/accounts/employees/parties enrolled у P0 `NativeDraftRecovery` як `native-entity-v1`. Відновлення підтримує ту саму вкладку й той самий чинний серверний сеанс. P1 загалом, інші native сім’ї та P2/P3 не завершено.

Немає нової бізнес-моделі/міграції, зміни ролей, posting, зарплатних формул або історії. Existing `EntityCreateReceipt` лишається авторитетним immutable CREATE receipt. Shared directory counterparties залишаються спільними; неактивні records не одержали нової загальної заборони.

## Контракт і capture

`GET /api/v1/trading/entities/{type}/recovery-context?store=&id=` виконує fresh current_actor у реальному RR/READ ONLY. DTO містить тільки type/id/store/role/storeId/networkOwner/canCreate/exists; SELECT record бере pk/store, без contact/payroll payload. Store/kind permissions відповідають чинному write contract. Новіші invalid raw поля не використовуються як authorization identity. `canCreate:false` не відхиляє читання original/confirmed draft.

Змінні opening source/dialog/tab/generation/store фіксуються перед першим await. Existing запис сам визначає store у fresh контексті: глобальний defaultStore не звужує network-owner доступ до іншого existing store.

Окремі `baseline` (original id/store/kind/revision), explicit raw `draft`, immutable `firstIntent` (POST endpoint/key/body/revision/possiblySent) і strict `confirmation`. Entity codec дозволяє тільки власні поля. Баланси, payroll debt, arrays/cache, CSRF/cookies/credentials/permissions не persist. Raw capture — explicit field getter/input/change/custom event; не FormData autosave. Ставки працівника — text input з inputmode decimal, щоб `1e-`, `-`, зайва точність або порожнє поле зберігались; Save validation лишається окремим Decimal contract.

Capture та durable first request завершуються **до fetch**. Quota/corruption fail closed, показують error, не надсилають POST. Error не стирає prior stored record. Foundation authorize/check/verify охоплюють warm re-show; немає другого session request із мовчазним catch.

## Recovery

- Unsent CREATE: explicit Restore повертає raw input, не пише бізнес-дані.
- Unknown CREATE: frozen first UUID/body окремі від newer invalid draft. Exact type=button не залежить від validity newer fields. Після reload unknown завжди ambiguous; наступні400/403/409 не звільняють first intent. Identity confirmed=false не доводить відсутність.
- Confirmed CREATE: ID/original receipt приймаються до current GET; current503 лишає GET-only barrier. Receipt revision не є fresh baseline; лише explicit comparison/Apply приймає latest baseline, Save окремий. Deleted original — readonly tombstone, без resurrection.
- Existing/unknown UPDATE: POST з id/revision не має CREATE receipt. Після reload потрібні fresh current GET, explicit comparison/Apply, окремий Save. Blind UPDATE replay відсутній. First unresolved body знімається тільки через strict same-ID ACK або actual fresh Apply; невдалий UPDATE після sent intent веде до review, включно400.
- First live CREATE validation400 може звільнити intent лише за type+UUID-bound `write_rejected:true`. Catch всередині outer atomic оточує inner `entity_save` savepoint: caught validation уже rolled back. Outer commit/on_commit callbacks відбуваються поза proof catch. Conflict та permission403 не отримують proof; post-commit serialization не входить у catch. Proof не доводить глобальної відсутності ключа й не застосовується після reload/unknown.
- ACK та confirmed read очищають локальний record лише коли newest normalized draft збігається з фактичним current record. Новіші поля/GET failure зберігаються. GET/identity/Apply не викликають business write.

## Cold/warm privacy

Cold Restore чекає actual allowlisted trading route mount із failed/abort/hash/timeout fences. Після mount виконується додатковий fresh context read до вставлення private DOM; observed bootstrap role/store мусять відповідати authorized session. Scoped manager/accountant parties відновлюються через дозволений customers route, не owner-only setup. Mount/cancel не активує Save.

Pagehide/hidden/session error приховують private body/heading/comparison і directory popovers. Public retry/Close лишаються доступними. Fresh warm verify повертає ту саму локальну форму без повторного Restore; 503 лишає її прихованою, GET retry не пише. Session401/epoch/role/store change використовують P0 global revoke; same-session resource403 — P0 denied-record policy. Close recovery dialog не очищає вже restored editor. Сховище не є шифруванням чи XSS захистом, не гарантує browser restart/crossdevice або виключне володіння request у duplicated tabs.

## Цільові докази

Нові перевірки запускались тільки на isolated даних. Shared PostgreSQL container localhost61144 не перезапускався/не видалявся; власна `DB_NAME=tsukenya_entity_reload`, test DB видалена Django.

- `tests.test_entity_draft_context.EntityDraftContextTests`: чотири нові PG scenarios PASS — fresh cached actor role/inactive, own/foreign scope, actual RR/READ ONLY/no DML/no private salary SELECT; усі5 resources + manager/accountant shared parties/network-store CREATE; actual first validation400 rollback/proof→correctedSave та409 без proof; synthetic on_commit validation після committed write не отримує no-write proof. Після minimal-column change повторено тільки scope target PASS. Перший HTTP fixture був403 через missing Origin; виправлено тільки fixture й повторено один target.
- `entityPersistence.test.ts`: 6 unit PASS — all5 raw whitelists, invalid strings, wrong resource/path/key, original receipt/tombstone/current barrier, UPDATE acknowledgment/explicit Apply, current policy match та bound rejection proof. Повторено після relevant decoder edit.
- `RecoveryPanel.stories.tsx:EntityFrozenCreate`: 1 Storybook keyboard PASS, решта144 skipped; bundled headless Chromium. Перший запуск заблокував sandbox local listener EPERM; повтор цільового story з дозволеним local listener PASS.
- Build/TypeScript, changed ESLint/Prettier, JS syntax, Python compile і diff check PASS.
- Actual `tests/entity-draft-reload-ui.cjs`, bundled headless Chromium, власна disposable SQLite/port18277:
  - **primary partial**: усі5 forms raw dirty hardreload→keyboard explicit Restore→Close/editable, 0 POST. Primary зупинився пізніше на CREATE barrier, тому не заявляється whole primary PASS.
  - **create terminal PASS**: actual committed CREATE/lostACK, newer invalid required name/rate, reload, exact sameUUID/body, later400 unresolved, one entity, confirmedID+current503→reload→GET-only; atomic payroll Apply/noPOST→separate Decimal UPDATE.
  - **update terminal PASS**: committed UPDATE/lostACK→newer raw→external rename→reload→current GET→explicit keyboard choice/Apply→fresh revision Save; no blind replay, immutable store/kind.
  - **validation terminal PASS**: actual duplicate warehouse atomic400 with proof→corrected explicit Save; raw incomplete rate не нормалізується, correction valid save.
  - **privacy terminal PASS**: quota before-fetch0POST/prior draft; warm focus same draft; resource503 private body/heading hide +public GET retry; actual session deletion→401 clears records; 1440/320 restored editor no horizontal overflow; обидва PNG переглянуто.
  - **cold**: initial success from overview PASS; final fresh-before-DOM/cancel continuation terminal PASS (`cold-report.json`). Старий closed dialog у hash-only navigation не є late mount; assertion відрізняє existing closed DOM від newly open private form.

Artifacts: `/tmp/tsukenya-entity-reload-proof/{primary-partial,create-report,update-report,validation-report,privacy-report,cold-report}.json`, `entity-restored-320.png`, `entity-restored-1440.png`, `server.log`. Failure diagnostics збережені окремо, не позначені успішними.

Відтворення: `PYTHON_BIN=/path/to/isolated/python node tests/entity-draft-reload-ui.cjs`. Вузький retry `QA_ENTITY_DRAFT_FROM=create|update|validation|privacy|cold|read`; unknown flag rejected. Script scrub DB/PG/production settings, pins isolated settings/secret, checks early server exit, awaits server/browser teardown. Full integration registry/env scrub належить root integration. Full suite, production/VPS/Sheet/backup0.1/PR/push не виконувались.

Existing receipt7PG/unit6/comparison keyboard-layout/P0 privacy/storage/late proofs reuse при незмінних inputs; цією доставкою не заявляються повторними full runs. Новий пакет не є completion решти B06.

## READ privacy follow-up

Reviewer підтвердив: direct `TradeDirectories.hydrate(manage)` кидав401/403,
але current/compare catches лише показували formError, тому private payroll fields
і heading лишалися видимими. Той самий getCurrent викликається після CREATE/UPDATE ACK.

`RecoveryController.verifyRead(id, callback)` тепер виконує fresh session check,
record authorization і strict decoded read у спільній generation/AbortController межі.
401 використовує global revoke;403 повторно перевіряє сеанс і видаляє лише denied record
за незмінного actor/scope. Зміна сеансу/ролі/scope очищає всі session-bound records.
503/malformed читання зберігає дозволені записи прихованими. Пізня відповідь після
cancel/dismiss не застосовує відмову й не приймає baseline.

Actual entity `persistence.read` використано для current/compare та explicit identity,
включно з CREATE/UPDATE post-ACK reads. Private body, heading і comparison приховані
від початку перевірки до успішного decoded read; failure має public access retry.
Під час read доступне public «Скасувати читання»; повторна authorization кнопка
disabled до завершення pending read/pre-write verification. Record-local counters
та module read counter не дають warm listener повторно відкрити форму під час
pending або старого скасованого читання. Initial prepare, backend і write endpoints
не змінені. Read/identity/public retry не записують бізнес-дані й не приймають
current revision автоматично; comparison/Apply/Save лишаються окремими.

Цільові докази follow-up:

- `npm run test --workspace frontend -- src/shared/recovery/recovery.test.ts`:
  **16 PASS**, включно з2 новими verified-read cases. Read401/403/503 після
  authorization, unrelated unknown intent, late403 after dismiss, read-only result
  без persisted baseline adoption. Це одна вузька foundation test family, не full suite.
- `QA_ENTITY_DRAFT_FROM=read PYTHON_BIN=/path/to/isolated/python node tests/entity-draft-reload-ui.cjs`:
  **terminal PASS**, bundled headless Chromium і disposable SQLite.
  `/tmp/tsukenya-entity-read-privacy-proof/read-report.json`: actual503/public auth retry
  з raw+original baseline; actual owner→accountant між preflight та manage read403;
  actual expired session manage401; explicit identity second-read403;
  closed/cancelled late403 не стирає record і не відкриває comparison. Є лише один
  deliberate CREATE для unknown identity; решта read actions не додають business POST.
- `ENTITY_CREATE_STAGE=tail PYTHON_BIN=/path/to/isolated/python node tests/entity-create-recovery-ui.cjs`:
  **terminal PASS**, `/tmp/tsukenya-entity-read-tail-proof/tail-report.json`:
  frozen retry з invalid newer input, confirmed ID+manage503/public auth retry,
  public Cancel із hidden raw/disabled Save, late closed identity без adoption.
- Matching build/TypeScript, changed ESLint/Prettier, JS syntax/diff PASS.
  Initial transient assertion чекала лише hidden DOM до завершення preflight;
  виправлено wait на error state. Old tail query disabled Save тепер перевіряє
  hidden DOM control, з окремою вимогою body hidden. Fail diagnostics збережені;
  ці спроби не оголошуються PASS.
- Harness перевіряє exitCode **і** signalCode; teardown тільки для живого server,
  SIGTERM з5-second SIGKILL fallback та awaited exit. Shared PG/container не чіпали.

## Сумісність старих native fixtures

`entity-create-recovery-ui.cjs` primary більше не очікує доступні payroll inputs
після owner→accountant→owner. Цей role/READ privacy scenario перенесено до actual
`entity-draft-reload-ui.cjs:read`, де доказано приховування й session-bound cleanup.
Old primary frozen request/invalid input retention тепер перевіряється як пізніший400
після lostACK, а identity/current503 — через explicit public authorization retry.
Збережено meaningful assertions UUID/body, confirmed ID, original baseline,
atomic payroll choice/second409/Apply-noPOST/separateUPDATE, всі5 CREATE consumers,
wrong ACK refusal та deleted-original tombstone. Old primary/layout цілком тут
не повторювали; targeted old tail PASS описано вище. Не заявляється whole-family PASS.

Решта P1 native сімей, P2/P3 та browser-restart/cross-device persistence лишаються
відкритими; source/proof цей follow-up не є їхнім completion.


## Інтеграція з актуальним порталом

Пакет інтегровано поверх accepted main `18b48b17`. Незалежне рев’ю
`f3616f4` підтвердило сумісність native entry, редакторів та нових контролів.
Повторено тільки залежні перевірки: build/TypeScript, scoped lint,22 unit tests,
headless native READ privacy та CREATE recovery. Попередні незмінені server,
keyboard/layout і codec докази використано повторно. Повної регресії не запускали.
Інші сім’ї B06 та пункт0.1 цим пакетом не завершено.

Під час інтеграційного CREATE сценарію виправлено застарілу тестову вимогу:
після503 приватна форма вже приховується політикою READ. Тест очікує стан error
і перевіряє приховану форму та підтверджений ID, після reload — лише current GET.
Перша спроба з попередньою вимогою не є успішним доказом.
