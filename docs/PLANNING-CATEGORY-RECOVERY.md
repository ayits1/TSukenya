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
