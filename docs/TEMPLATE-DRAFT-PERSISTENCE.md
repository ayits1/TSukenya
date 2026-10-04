# B06: reload чернетки кількості магазинів

Цей count-only підпакет базується на monthly `3e06f8a` у власному checkout. Реальний `budget-template.js` підключено до прийнятої P0 foundation, namespace `native-template-v1`. Monthly/category/voucher/entity/workShift/recipe джерела не змінено.

**Сім'ю template загалом ще не закрито:** raw `expenses` inline amount/category, new-name/create та LegacyEditors expense fields лишаються наступним P2 enrollment. Чинні one-field PATCH/ревізії/partial saves та одиниці expense amount не змінено цим count пакетом; його codec їх не видає за збережені. P2/P3, browser restart/cross-device та backup0.1 не виконано.

## Авторитет і whitelist

Серверний `/api/v1/portal/budget-template` лишився GET/PATCH ресурсом scalar count. Current actor, network-owner scope, READ ONLY RR, ledger lock, count revision, no-op/audit та legacy settings guards не змінено; нових backend routes/schema/migrations немає. Count revision — відбиток effective count, незалежний від label token. Legacy X-Budget-Template-Revision обов'язковий для count; чинний optional If-Match label guard збережено (обов'язкової dual guard немає).

Шаблон **не має CREATE чи server receipt UUID**. Збережений local UUID і frozen PATCH body — ідентичність локальної спроби, не доказ її автора/серверного виконання. Unknown PATCH після reload ніколи не відтворюється автоматично чи через blind retry. Current count, навіть рівний original request, не оголошується creator receipt.

Versioned strict codec зберігає лише original `{budgetStores,revision}`, raw count string, review flag, local UUID, first method/path/body/revision та strict confirmed scalar після ACK. Source/canEdit, session/CSRF/credentials, settings/tag/expense arrays, totals/facts/model/cache та comparison choices не серіалізуються. P0 owner/session/role/store binding і byte/node/record limits діють без truncate.

Raw input тепер text+numeric inputmode: порожнє значення, `1..2`, `-` не губляться через number DOM. Save окремо перевіряє integer1..1000. Formula/default count order не змінено. На input capture синхронний; opening baseline фіксується перед async перевірками, але приватні поля не показуються до fresh actor/resource read. Capture/first replacement оновлює in-memory payload тільки після успішного atomic storage replace. Quota before-send блокує PATCH та не вигадує unknown intent, якого не записано.

## Реальний діалог

- Новий діалог починає з public loading. Cold reload → «Локальні чернетки» → explicit Restore; no business writes. Stored revision після Restore не дозволяє Save до current comparison та явного Apply. Cold count може відновлюватися з огляду: це глобальний scalar dialog, route/resource не перепризначаються.
- Original body/key durable до business fetch. Перед PATCH P0 verify перевіряє current actor/resource. Безпосередньо після останнього awaited session і перед fetch перевіряються generation/hash/live dialog/private visibility/abort та session binding. Initial GET має аналогічний mount fence. Late401 після закриття/cancel не redirect'ить інший live контекст.
- Unknown PATCH: first body/key лишаються поряд із новішим invalid raw; доступні тільки read/compare, Apply локальний і **окремий** Save з актуальною count revision. Apply/Cancel не є PATCH. Invalid mine у порівнянні не перетворюється на нуль; можна виправити або явно вибрати server count.
- Strict ACK має відповідати submitted count. Confirmation durable до незалежного current GET. GET503 не очищає first/confirmation/dirty і не повторює PATCH. Confirmed matching count+revision після fresh GET прибирає completed record; newer invalid raw лишається для review. Positive ACK не змінює original baseline до explicit Apply/complete barrier.
- P0 suspend ховає body/count/compare, залишає generic heading, Close і public GET-only retry/cancel. Allowed503/malformed зберігає record. Resource403 видаляє тільки denied record; його ephemeral raw не розкривається знову після видалення. Actual role/store/session зміна чи401 застосовує global P0 privacy; actual401 повертає login. Warm same-session verify може показати той самий дозволений draft без повторного Restore.
- Cancel/close/route fences відкидають late результат без baseline adoption. Close dirty редактора залишає durable record для explicit Restore; Discard виконується окремо в P0 registry і не є серверним rollback. Під час PATCH Close/навігація заблоковані.

## Цільові докази

- `templatePersistence.test.ts`: **4 PASS** — exact whitelist/raw/first path/key/revision; strict ACK count binding; no invented identity; old baseline separate from confirmation/current; Apply і matching confirmed cleanup. TypeScript, scoped ESLint/Prettier, JS syntax/diff і matching build `/tmp/tsukenya-template-draft-build.log` PASS. Browser static policy220 PASS, жодного системного Chrome.
- `/tmp/tsukenya-template-reload-proof/primary-partial.json`: completed cold Restore invalid raw from overview, blocked stored revision, keyboard1440/320/44px. `template-raw-320.png` переглянуто, natural flow без горизонтального обрізання. Primary **не terminal PASS**: наступний tail зупинився на mobile launcher fixture; повторено тільки affected recovery.
- `/tmp/tsukenya-template-recovery-final/recovery-report.json`: terminal actual committed PATCH lostACK→reload invalid newer raw/original local key+body; no blind PATCH/receipt claim; current/keyboard Apply без write, separate revision Save/confirmed GET cleanup; strict ACK persisted до незалежного GET503→reload→fresh GET-only cleanup. Settings stores/storeNames/private keys збережено.
- `/tmp/tsukenya-template-guard-final/guard-report.json`: terminal raw/first-intent quota replacement→zero PATCH, no invented pending intent; correction збережено; delayed final-session await+pagehide → no late PATCH, private hide/frozen intent retained.
- `/tmp/tsukenya-template-privacy-proof/privacy-report.json`: terminal actual owner→accountant during current read403, private hide/changed-session records erased/no write; actual session deletion/read401→login/storage erased/no write.
- `/tmp/tsukenya-template-cancel-proof/cancel-report.json`: terminal pending authoritative GET cancel→late completion fenced; no comparison/revision adoption/PATCH; fresh GET-only access retry shows same authorized raw count.
- `/tmp/tsukenya-template-layout-final/layout-report.json`: terminal affected existing `TEMPLATE_STAGE=layout`, delayed opening GET, server409+GET503 with hidden raw/public retry, keyboard conflict choice and local Apply/no PATCH, 1440/320/44px/focus/overflow. `template-320.png`/`template-actions-320.png` retain original layout assertions. Existing legacy harness retarget retains its other arithmetic/second409/unknown ACK/cancel/malformed/resource403/metadata503 scenarios; **весь old recovery stage не повторювався**. Resource403 переміщено після malformed/Cancel: denied draft більше не reuse як allowed.

Незмінені backend PostgreSQL докази `tests.test_budget_template` (readonly/no-DML/default inference, independent label token, preservation/no-op/audit, legacy bypass/PUT omission, roles/scopes/current actor after ledger wait та two-client one-winner), а також shared BudgetTemplateConflict story/unit reuse з `BUDGET-TEMPLATE-RECOVERY.md`: API/business source цього підпакета незмінний, зайвого повтору PG/concurrency не було. Не є capacity/production/SLA/physical-screenreader доказом.

Focused disposable SQLite18283 commands (bundled Playwright Chromium `headless:true`, без channel/executablePath; signal-aware SIGTERM5s/SIGKILL awaited teardown):

```sh
env -i PATH="$PATH" PYTHON_BIN=/tmp/tsukenya-review-venv/bin/python QA_OUTPUT_DIR=/tmp/tsukenya-template-reload-proof node tests/template-draft-reload-ui.cjs
# Повторити лише потрібний independent stage:
# QA_TEMPLATE_DRAFT_FROM=recovery|guard|privacy|cancel
```

Existing layout command: `TEMPLATE_STAGE=layout TEMPLATE_QA_PORT=18284 TEMPLATE_PROOF_DIR=/tmp/tsukenya-template-layout-final node tests/budget-template-ui.cjs` з тим самим isolated Python/env. Failed artifacts збережено: obsolete mobile launcher, accessible heading mistaken for modal close, initial hidden Save locator. Business assertions не видалено. Всі own browsers/servers завершено; no full/production/Sheet/VPS/push/deploy.

## Незалежне рев’ю count: response fence, actor binding та Apply

Рев’ю точного `2cdbdc409d38eb9ae5f6f60bb0f6e259a50ef5f6` охопило лише дев’ять файлів count-пакета. Виправлення зроблені окремо від замороженого checkout:

- `request()` повторно перевіряє live/generation/signal після session, fetch і JSON, включно з помилками. Скасований session401 не починає нову P0-перевірку; запізнілий ACK/401 після suspend і повторної прив’язки не підтверджує запис та не змінює поточний контекст.
- Authorize і незалежний current GET звіряють фінальний session з P0 binding. Зміна actor між читаннями залишає форму прихованою й не передає чужу revision у порівняння.
- Чинний PATCH403 запускає P0-перевірку actor та ресурсу з прихованою формою: зміна role/session очищає відповідні приватні записи; окрема відмова ресурсу видаляє лише count-чернетку.
- Apply зберігає обране raw-значення, поточну revision та звільнення попереднього intent одним записом storage, перш ніж змінювати in-memory baseline або поле. Другого запису, на якому quota могла втратити обраний варіант, більше немає. PATCH лишається окремою дією.

Новий вузький сценарій `QA_TEMPLATE_DRAFT_FROM=review` перевіряє затриманий саме `Response.json()` ACK/401 після pagehide + same-session rebind, reload unknown intent без PATCH, запізнілий final-session401 без P0 recheck, зміну actor перед authorize/current GET, atomic Apply з відмовою другого storage-запису, actual owner→accountant PATCH403 та same-actor resource403 зі сторонньою чернеткою. Окремий `review-resource` запускає лише останній сценарій.

Докази у `/tmp/tsukenya-template-count-review-proof/review-partial.json`: перші вісім перевірок успішні, потім тестовий helper припинився на `baseline:null` сторонньої synthetic-чернетки. Helper виправлено через optional chaining; лише фінальний сценарій повторено успішно: `/tmp/tsukenya-template-count-review-resource-proof/review-resource-report.json`. Це сукупність завершених вузьких перевірок, а не твердження про один повністю зелений запуск первісного harness. Логи: `/tmp/tsukenya-template-count-review-proof.log` та `/tmp/tsukenya-template-count-review-resource-proof.log`.

Команди виконувалися з `env -i`, `PYTHON_BIN=/tmp/tsukenya-review-venv/bin/python`, `QA_PORT=18286`, відповідними `QA_OUTPUT_DIR` та `node tests/template-draft-reload-ui.cjs`; локальна disposable SQLite, bundled headless Chromium. Незмінний frontend bundle повторно використано з авторського checkout. JS syntax, Prettier зміненого application-файлу та `git diff --check` успішні. Авторські codec, PostgreSQL, layout і решта попередніх proofs лишаються чинними для незмінених inputs; full regression, VPS і production-дані не використовувалися.

### Додаткова перевірка opening/warm

Переглянуто всі виклики `request()`. Гілка warm без запису тепер перевіряє generation, маршрут, видимість та actor binding первісного opening перед будь-якою обробкою відповіді; якщо binding ще немає, виконується нове guarded opening. Restore передає ephemeral session тільки з matching `authorize(signal, recordId)` у власний opening GET. Ці дані не записуються в codec payload. Повторне відкриття чекає завершення close lifecycle, щоб попередній dialog не інвалідував новий `openingId`.

Окремий `QA_TEMPLATE_DRAFT_FROM=review-opening` PASS: `/tmp/tsukenya-template-count-opening-retry-proof/review-opening-report.json`, лог `/tmp/tsukenya-template-count-opening-retry-proof.log`. Чотири вузькі докази: запізнілий warm JSON401 після наступного suspend; public retry після initial GET503; відмова changed-actor warm до resource GET; bound restored-opening із збереженим raw та наступним успішним explicit Restore без PATCH. Перший запуск `/tmp/tsukenya-template-count-opening-proof.log` зупинився у fixture: mode перемкнувся до завершення initial503 і retry був закономірно disabled. Fixture тепер очікує завершений503, потім виконує delayed warm сценарій. Решту count перевірок не повторювали; production source бізнес-операцій і codec не змінено.

## Інтеграція в прийнятий портал · 05.10.2026

Власний count commit2cdbdc4 та review50b4dba/1165984 перенесено на main3fd6a6f.
Збережено чинні monthly/category/recipe/workShift bridges та React sales.
Matching TypeScript/Vite build, node syntax і git diff --check PASS.
Цільовий integrated review-opening PASS: відкладений401 після suspend,
повтор відкриття після503, зміна actor між перевірками та read-only Restore
із прив’язкою до session/signal/id. Доказ: локальний
`/tmp/tsukenya-count-integrated-opening/review-opening-report.json`; writes0.
Перший запуск не зміг відкрити localhost у sandbox до виконання сценарію;
повторено лише цей сценарій із дозволеним localhost. Незмінені codec/backend
та попередні review/layout докази використано повторно.

У full-check зареєстровано primary і сім окремих recovery/review scopes;
QA_TEMPLATE_DRAFT_FROM очищається на вході. Виконано тільки --plan,
повну регресію й production mutation-тести не запускали. Цей реліз
охоплює кількість магазинів; відновлення статей витрат розробляється окремо.
