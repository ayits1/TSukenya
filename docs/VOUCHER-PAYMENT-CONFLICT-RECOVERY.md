# B06: відновлення чернеток документів і платежів

Перевірено 2026-10-04 у `/tmp/tsukenya-voucher-conflicts-next`, гілка `codex/voucher-payment-conflict-recovery`, від прийнятого `b49212a`. Власні коміти коду: `358e390`, `f604375`, `9368568`.

## Реальна інтеграція

`app/erp.js:voucherForm` та `app/erp-payments.js:TradePayments.form` використовують `app/erp-voucher-recovery.js`. Порівняння делеговано чинним `NativeConflictComparison` / `compareThreeWay`; другої merge-логіки немає. `NativeVoucherEditor` додається до наявного entry без перезапису entity/work-shift exports.

- Перший create зберігає незмінний запит і UUID. Окрема кнопка точного повтору не читає новіший FormData та працює за невалідних новіших полів.
- Після невідомого результату пізніша 400/403/428 не доводить відсутність початкового запису. Intent зберігається, звичайний Save заблокований.
- `POST /api/erp/vouchers/identity` є явно read-only CSRF-запитом: frozen body потрібен для fingerprint. Справжній RR/READONLY знімок, актуальний actor, роль, початковий і поточний store scope та expense permission перевіряються перед підтвердженням. Відповідь містить лише identity, стан і поточну policy metadata. Немає бізнесових записів або аудиту. `confirmed:false` не звільняє intent, оскільки інша транзакція може ще завершитися.
- Підтверджений ID зберігається до наступного GET. Поточна ревізія з lookup/409 не стає ревізією для Save; для цього потрібні окреме читання й явний Apply. GET503 або невалідна новіша форма не повертають підтверджений POST у чергу повтору.
- Save ACK повинен мати точний `request_key`, правильний ресурс та нормалізовані writable умови початкового запиту. Structurally valid ACK з чужими сумою/приміткою не закриває форму. Server-only snapshots, COGS і derived posting totals не прирівнюються до довільних клієнтських сум.
- Для пов'язаних receipt/sale/returns пропущене `reference_line` може відновити сервер лише для того самого reference, line_key та product; явно переданий ID не підміняється. У returns сервер визначає source price, а для supplier return також lot/expiry. Quantity та решта writable реквізитів залишаються строгими. Назва прив'язаної статті приймає серверний snapshot до160 символів лише з тим самим category UUID; довільний текст без ID має чинну межу100.
- Update409 залишає поля і початковий baseline. GET читає актуальний документ та поточну policy в одному знімку. Примітка незалежна; решта реквізитів, рядки з lineage UUID/reference_line, payload і payment allocations є однією консервативною атомарною групою.
- Apply змінює лише форму. Валідація обраних умов, поточного scope/закритої дати й requested recipe UUID відбувається до baseline/revision adoption. Save окремий, після Apply фокус переходить до нього.
- Невідомий результат Post відновлюється читанням стану. Автоматичних PUT/Post немає. Перевірену draft revision можна провести окремою кнопкою; posted/reversed/closed/inactive-store records лишаються read-only.
- Скасування/закриття огороджує пізні GET та асинхронний Apply. Нова чернетка не підміняється старою відповіддю.

Вхідні money/quantity limits не розширено. Readonly total/cost допускають чинні серверні агрегати до `99999999999999.99`. Payroll Save без клієнтської суми використовує чинний 0; нарахування після Post залишається серверним. Затверджена recipe snapshot copy не створює зайвого конфлікту поряд із версією; legacy recipe та actual production facts зберігаються.

## Цільові докази

Повного regression не запускали. PostgreSQL тести використовували лише окремий `test_tsukenya_voucher_recovery`; native Chrome — власну тимчасову SQLite та API, без production/Sheet. БД видаляється harness після завершення.

| Перевірка | Результат і межа |
| --- | --- |
| Початкові PostgreSQL tests | 3 PASS: fingerprint-only original409 без write; current store/period policy; real RR/READONLY concurrent voucher/period snapshot. Окремий manager-zero-production policy case 1 PASS. Policy queries збережені при винесенні в `recovery_editing`. |
| Follow-up PostgreSQL | 2 PASS, 0.500 s: identity після закриття/актуальної відмови ролі, no audit/write, exact fingerprint/current scope, RR/READONLY. Aggregate input/output bound case 1 PASS, 0.321 s. |
| Native helper units | 7 PASS: strict resource/policy/lineage, atomic terms + independent note, approved recipe snapshot parity, exact UUID/terms ACK binding, allocation guards, aggregate bounds, identity policy та merged closed/scope refusal. |
| Root integration | 9 unit PASS включно з двома новими normalization boundaries; PostgreSQL3, combined build/tsc/lint та node syntax PASS. Combined production native proof повторено після інтеграції strict recipe decoder; wrong UUID, canceled Apply, local Apply/separate Save PASS. Незалежне read-only рев'ю normalization не знайшло нових blockers. |
| Storybook | Новий `NativeConflict / Voucher Terms`: 1 PASS; інші 4 stories пропущено через target filter. Наявний shared control не змінювався. |
| Frontend / source | build + tsc, affected ESLint/Prettier, node syntax та git diff whitespace PASS. |
| Compatibility | `QA_RECOVERY_FROM=documents` у `erp-recovery-ui.cjs`: 4 document scenarios PASS, повторено тільки після зміни ACK contract. `draft-revision-ui.cjs`: stale Save/Post/Delete, confirmed original409 без baseline substitution та stale native directory PASS. |

Native докази збережено в `/tmp/tsukenya-voucher-conflict-proof/`. Кожний scoped run окремий, з власними даними; один загальний `all` run не заявляється.

| Scoped run / JSON | Що доведено actual UI + Django |
| --- | --- |
| `existing-report.json` | Update409, незалежна note/server lines, GET503 без write, Apply без write, другий409, явний keyboard atomic choice і separate Save. |
| `create-report.json` | Committed create/lostACK, точний незмінний UUID/body при invalid newer quantity, confirmed ID + GET503/GET-only retry, newer draft Apply/Save. |
| `post-report.json` | Committed Save+Post/lostACK → GET підтверджує posted; повторних PUT/Post немає, форма readonly. |
| `payment-report.json` | Actual TradePayments: amount/account/allocations атомарні, note незалежна, Apply без POST, separate Save, без CashEntry у draft. |
| `payment-create-report.json` | Payment create/lostACK + invalid newer amount: exact UUID/body, GET без POST, newer amount/note збережені. |
| `create-edited-report.json` | Початковий create вже змінено іншим редактором: exact retry409 підтверджує лише identity, invalid newer draft лишається, GET/choice/Apply/Save окремі. |
| `privacy-report.json` | Malformed semantic200 та current role403 відмовляються до adoption; поля збережені. Canceled delayed GET не відкриває/не застосовує стару форму. |
| `layout-report.json` | Focused radio/actions у видимій межі dialog на 1440/320, без horizontal overflow; keyboard Space/Enter Apply. |
| `production-report.json` | Актуальний follow-up: wrong UUID рецептури того самого product відмовлено; canceled delayed Apply не змінює DOM; правильні frozen version/planned/actual facts + independent note, Apply без POST та separate Save. |
| `identity-report.json` | Актуальний follow-up: lostACK → closed-period400 → current role403 збережуть frozen body + invalid newer draft; guarded UUID lookup підтверджує original readonly без фінансового write або revision adoption. |
| `ack-report.json` | Актуальний follow-up: same-resource valid-shaped ACK із total999/noteother відмовлено; UUID lookup підтверджує справжній original; newer amount12 збережено через GET/Apply/separate matching Save. |

Focused images: `/tmp/tsukenya-voucher-conflict-proof/voucher-choice-320.png` та `voucher-choice-1440.png`. Старі `voucher-comparison-*` показували переважно верх форми; їх не використовуємо як доказ видимості comparison. PNG оглянуто. Повторні невдачі tail були вузькими: wait на async opening/Apply, актуальна назва shared Cancel, hidden DOM проти `:visible`, actual bootstrap endpoint. Перед зеленим production proof виправлено реальний false conflict redundant recipe copy.

## Команди та межі повтору

```sh
npm exec --workspace frontend -- vitest run --project unit src/shared/native/voucher.test.ts
npm exec --workspace frontend -- vitest run --project storybook src/shared/native/NativeConflict.stories.tsx -t 'Voucher Terms'
VOUCHER_QA_FROM=identity PYTHON_BIN=/tmp/tsukenya-review-venv/bin/python node tests/voucher-conflict-ui.cjs
VOUCHER_QA_FROM=ack PYTHON_BIN=/tmp/tsukenya-review-venv/bin/python node tests/voucher-conflict-ui.cjs
VOUCHER_QA_FROM=production PYTHON_BIN=/tmp/tsukenya-review-venv/bin/python node tests/voucher-conflict-ui.cjs
QA_RECOVERY_FROM=documents PYTHON_BIN=/tmp/tsukenya-review-venv/bin/python node tests/erp-recovery-ui.cjs
```

`VOUCHER_QA_FROM` має `all` за замовчуванням та перелічені вище stage names. `VOUCHER_PROOF_DIR` змінює лише місце proof; `CHROME_PATH` має platform fallback. Partial JSON явно називає scope. Full registry належить root integration; не видаємо scoped pass за повну регресію.

Після follow-up незмінені дев'ять попередніх сімейств не запускали повторно. Нові ambiguity/ACK/recipe-UUID boundaries мають власні matching proofs; решта результатів є збереженими доказами початкового пакета. Root combined production Apply після інтеграції нового recipe decoder signature пройшов: `/tmp/tsukenya-root-voucher-production/production-report.json`.

## Свідомі межі

Intent живе у відкритій формі цієї вкладки; durable відновлення після browser reload у цьому пакеті не заявляється. Whole terms group навмисно консервативна: конфліктні фінансові рядки не зшиваються окремо. Recipe approval/legacy recipe editing має окремий B06 пакет. Posting/reversal/FEFO/COGS/reserve/settlement/payroll правила та фінансові формули не змінювалися. Інші браузери, screen readers, capacity/full regression, deployment та backup0.1 не перевірялися.


## Root normalization proof

`/tmp/tsukenya-root-voucher-normalization/normalization-partial-report.json` підтвердив actual linked receipt: повторний вибір product прибрав source ID, сервер відновив єдине походження, правильний Save ACK дозволив окремий Post рівно один раз. Наступний category tail зупинився через неправильне очікування payment form у finance helper; helper тепер явно розрізняє voucher/payment, production код через цю fixture правку не змінювався.

Повторено лише category tail: `/tmp/tsukenya-root-voucher-category/normalization-report.json`, `normalizationFrom:category`, PASS. Actual expense з назвою прив'язаної статті160 символів збережено, повторно відкрито та окремо оновлено. Linked receipt, production proof і попередні незмінені families вдруге не запускали. Запуск без `VOUCHER_NORMALIZATION_FROM` перевіряє обидва normalization cases; explicit full registry видаляє partial flags і реєструє harness один раз. `npm run test:full -- --plan` — лише dry-run, не повний regression.
