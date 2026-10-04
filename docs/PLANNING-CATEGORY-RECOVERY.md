# B06: квитанції планування та редактор статті

База: accepted main66 `9e8e2a8`, entity receipt dependency root `bc65fbf` (авторський `1ad4c318`), legacy receipt dependency `2d65ce1` (локальний `d8b9930`). Міграція `0022_planning_create_receipts` залежить від справжньої `0021_legacy_create_original_snapshot`.

## Серверна межа

`PlanningCreateReceipt` містить key/resource/author, UUID первісного target, nullable typed FK, month/store scope, request/created fingerprints і час. Квитанція не містить назв, сум, raw payload або історичного snapshot. Фізичне видалення зануляє FK; UUID не прив'язується до іншого запису. DELETE API не додано. Створення запису, audit та квитанції атомарні під LedgerLock; current_actor перечитується після блокування, включно з replay.

Для category UUID body.id — ключ і ID статті. Для monthly_budget idempotency_key — ключ, ID бюджету незалежно генерує сервер. Fingerprint нормалізує writable поля, exact money2/rate3, scope і порядок стабільних UUID рядків. Застарілі запити без line UUID лишають nullable identity у request projection; згенеровані IDs закріплені created fingerprint. Readonly captions, alias, fact і revision не доводять первісний CREATE. Автор перевіряється окремо.

Exact same-author repeat unchanged повертає чинний DTO з `resource/request_key`, без нового audit. Edited target повертає409 `original_request_confirmed`, ID лише після перевірки первісного запиту; tombstone409 `original_request_deleted`. Wrong author/resource/body — `idempotency_conflict`, без target ID. Старі записи без квитанції не отримують вигаданого автора: identity `confirmed:false/status:legacy_unknown`. Старий legacy replay лишається сумісним, але не повертає нової позитивної квитанції.

GET `budget-categories/:uuid` / `monthly-budgets/:uuid` повертає `{resource,record,permissions:{canEdit}}` у RR/READ ONLY, зі свіжою роллю. Category read owner/manager/accountant, edit owner включно scoped owner. Monthly owner/current store scope; saved plan без обчислення facts/history. POST `.../identity` з `{request:frozenBody}` — CSRF-protected read з тим самим snapshot. Present дає ID/revision/permissions; deleted ID без revision; monthly positive додає frozen month/store. Revision identity ніколи не є editable baseline. Відсутність квитанції не доводить відсутності запису. Схема — `contracts/planning.openapi.json`.

Чинні past-month, inactive-store, archive/alias та облікові формули збережені. Planning Save не додає проводок або нової заборони closed period. System semantic_key та aliases не можна записувати з editor; category UUID при PUT незмінний.

## Спільний редактор статті

`NativePlanningCategoryEditor` строго перевіряє ACK/current/identity та лише name/active projection; ці поля незалежні в чинному NativeConflictComparison. UUID, semantic_key і історичні aliases не входять у writable merge. `app/planning-category-editor.js` має власний dialog, dirty state, Abort/generation fences і frozen first CREATE.

Unknown CREATE → exact type=button retry або readonly identity. Після unknown→4xx первісний UUID/body зберігається; некоректне новіше введення не блокує exact CTA. Positive identity підтверджує лише ID; потім current GET, explicit Apply і окремий Save. Known PUT unknown/409 → current GET/compare, без сліпого PUT retry. Apply не пише. Late/canceled/malformed/403 read не змінює baseline. Newer draft після successful exact retry зберігається. Tombstone не створюється заново.

Native adapter `MonthlyBudgetCategories.mount(host,{categories,onSaved})` не змінює план місяця. Власник plan UI підключає його в окремому пакеті; monthly structured-line merge не входить у цей commit. `canLeave/blocked` доступні для plan context guard.

## Цільові докази

- PostgreSQL `tests.test_planning_recovery`:7 PASS, включно actual two-thread repeat/one audit, роль відкликана під ledger wait, RR/READ ONLY, exact Decimal normalization, creator mismatch, edited/deleted identity, rollback і HTTP no-write.
- Unit `planningCategory.test.ts`:3 PASS: semantic ACK, strict current/identity та independent name/active merge. Типи `tsc --noEmit` PASS.
- Незмінені monthly formula/history/alias/cash/posting сценарії не повторювались. Широкого/full прогону немає.
- Native/Storybook докази доповнюються після actual consumer integration; цей backend етап сам не оголошує UI пакет завершеним.

## Завершення category consumer QA

Actual consumer hook взято з робочого `app/monthly-budget.js` + `NativeMonthlyBudgetEditor` іншого агента `/tmp/tsukenya-monthly-budget-recovery-next` лише як QA dependency. Власні коміти цього пакета не включають його плановий controller/adapter/entry export; root інтегрує обидві доставки. Category dialog і його mount adapter — власний production source, не тестовий макет.

Точні команди (з ізольованим Python):

```sh
npm run test --workspace frontend -- src/shared/native/planningCategory.test.ts
npm run test:components --workspace frontend -- src/shared/native/PlanningCategory.stories.tsx
npm exec --workspace frontend -- tsc --noEmit
npm exec --workspace frontend -- eslint src/shared/native/planningCategory.ts src/shared/native/planningCategory.test.ts src/shared/native/PlanningCategory.stories.tsx src/native-conflict-entry.tsx
npm run build --workspace frontend
PYTHON_BIN=/tmp/tsukenya-review-venv/bin/python node tests/planning-category-recovery-ui.cjs
PYTHON_BIN=/tmp/tsukenya-review-venv/bin/python node tests/planning-category-recovery-ui.cjs --scope-only
PYTHON_BIN=/tmp/tsukenya-review-venv/bin/python node tests/planning-category-recovery-ui.cjs --ack-repeat-only
```

Native primary PASS: реальний CREATE committed/lost ACK → стороннє редагування → exact409 з тим самим UUID/body попри нове порожнє ім’я → identity підтверджує лише ID → current GET503 → independent name/active comparison → keyboard Apply без PUT → окремий Save. Незбережений виторг `777.77` лишається у плані. Known PUT409 + скасований запізнілий GET не приймають baseline. Wrong semantic ACK відхилений.

Scoped tail PASS: власник одного магазину створює shared category, план `555.55` збережений локально; current manager403 відмовляє Save, readonly current не стає writable baseline. ACK repeat tail PASS: старий meaningful malformed `{}` case перенесено на actual dialog; invalid newer input не блокує exact original success, одна стаття/один audit, confirmedID не підміняє revision.

Артефакти: `/private/var/folders/9_/xkms65w90g57nhx8n9bhp6300000gn/T/tsukenya-planning-category-proof/`: `report.json`, `scope-report.json`, `ack-repeat-report.json`, `category-comparison-1440.png`, `category-comparison-320.png`. Обидва PNG переглянуті; горизонтального обрізання немає, labels вибору≥44 px. Storybook2 PASS. Попередні два Storybook attempts не зібрали жодної історії через зовнішній symlink setup URL; після приватної копії залежностей виконані саме ці дві історії, не весь набір.

`tests/monthly-budget-recovery-ui.cjs` змінено лише category block: assertions one record/audit/exact body збережені; решту monthly cases адаптує власник plan package. Дев’ять старих сімейств або повна регресія цим доказом не оголошуються виконаними. Physical deletion/creator/rollback/RR перевірені серверними цільовими тестами; реальна фізична роздруківка, screen reader та capacity не перевірялися.


## Root інтеграція planning/category/monthly

Root переніс лише own1416155/f43f82b/f8089f4 та ownmonthly a69d02b поверх main68/legacy69.
Конфлікт entry/routes вирішено additive: budget-template, entity, recipe, voucher namespaces
та script loaders залишені. 0022 залежить від справжньої0021. Backend source збігається
з delivery. Root independent PostgreSQL2 PASS0.418s: atomic receipt rollback/audit і actual
RR READ ONLY identity. Незмінені author PostgreSQL7/unit3/Story2 докази використані повторно.
Combined tsc/Vite build, targeted lint/Prettier/syntax PASS. Actual combined category consumer
primary PASS: lostACK/edited exact409/identity-only/current503/name-active merge, keyboard
Apply(noPUT)/separateSave, план777.77 не втрачений; canceledGET/wrongsemanticACK такожPASS.
`/tmp/tsukenya-root-planning-category/report.json`; actual320 PNG переглянуто.
Harness pins isolated settings/password helper, scrubs DB/PG/URL/owner credentials, closes
log FD, detects earlyexit і awaitsclean teardown. Explicit full registry включає primary/
scope-only/ack-repeat-only по одному разу; його --plan перевірено, full не запускався.


## Уточнення старого CI сценарію повторного CREATE

Перший CI PR #70 виявив старе очікування HTTP400 після перейменування статті
та повернення початкового імені. Durable receipt навмисно повертає HTTP409
`original_request_confirmed`: той самий створений запис підтверджений, але
його revision3 не стає новою базою редагування. Змінено лише цей тест:
додано перевірки ID/request_key/resource, відсутності revision, одного receipt,
незмінного audit і revision3. Бізнес-код не змінювався. Цільовий сценарій
SQLite PASS (0.018s) і PostgreSQL PASS (0.181s); повний локальний прогін
не повторювався. Новий exact-head CI має пройти до прийняття PR.
