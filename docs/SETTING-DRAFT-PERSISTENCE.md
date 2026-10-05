# B06 P3: три налаштування обліку

Пакет охоплює фактичні `#trade/setup` форми: обліковий період (дата включно та причина), вимога номера чека ПРРО і максимальна знижка касира. Початкова база — `fb9202d344dffe6fc8a4f16e41038e5031074596`; окремі залежності касових змін — локальні `562da6a` (root `9af342e`) і `6d30c2e` (root `4b7b84e`). Власна доставка налаштувань не містить повторної доставки цих залежностей.

## Серверна межа

- Старі POST `/api/erp/period`, `/fiscal`, `/discount-limit` без UUID/версії зберігають чинну поведінку й ACK. Наявність UUID або версії вмикає строгий keyed protocol; пропущені/зайві поля відхиляються.
- `0026_setting_action_receipts` залежить від `0025_cash_shift_action_receipts`. Receipt містить лише автора, вид налаштування, UUID, fingerprint, нормалізовані дозволені поля, застосоване значення/версію та час. Паролів, session/CSRF або інших credentials немає.
- Під `LedgerLock` повторно читається активний актор/роль власника. Прив'язаний до магазину власник зберігає чинне право змінювати ці глобальні налаштування. Exact receipt перевіряється після авторизації, до поточної версії/періоду; повтор повертає початковий ACK без нового аудиту чи запису. Інший автор/вид/тіло того самого UUID →409.
- Нормалізоване тіло включає observed revision: ISO date або null, точну причину до4000 символів, boolean fiscal mode або десятковий percent0..100 з максимум2 знаками. Кома/крапка і зайві нулі відсотків мають спільну Decimal representation; exponent, NaN, числові JSON percent та інша точність відхиляються. Причина не обрізається й не підставляється з історії.
- 32hex HMAC revision використовує вид, поточне типізоване значення та ID останньої релевантної audit події. Точні action/subject фільтри ловлять ABA та legacy зміни того самого значення; чужі касові/документні події не змінюють версію. Cash balance не входить у неї.
- Current period читає лише `closed_through` і scalar audit `detail.reason`; повний JSON/history не матеріалізується. Неочікуваний тип/надмірна історична причина відхиляється.
- Версійні `recovery-context`, `current`, `identity` працюють у READ ONLY REPEATABLE READ із fresh actor. Query keys відхиляються. Identity прив'язаний до автора та exact normalized first body; false не доводить відсутності й не звільняє unknown intent.
- Доказ `write_rejected` прив'язаний до виду/UUID. Він описує лише validation400 або revision409 після inner rollback; outer commit/on_commit/response failures і permission/collision не мають цього доказу. Після будь-якої невизначеності клієнт його не використовує для звільнення початкового запиту.
- Правило минулої Kyiv дати, заборона закриття за наявності чернеток, fiscal requirement, discount rules та наявний audit лишаються серверними.

## Фактичні native форми

`TradeSettingEditor` і `TradeSettingPersistence` використовують спільний P0 store/controller та `NativeConflictComparison`. `NativeSettingPersistence` — строгий TypeScript codec; generated trading types додано окремо від catalogue contract. Нові скрипти завантажуються до `erp.js`, codec експортується до ready event; cold restore чекає фактичного setup mount із route/generation/abort fence.

Raw capture дозволяє невалідні новіші рядки. До send зберігаються first body/UUID/revision та raw; quota блокує fetch. Exact retry є окремою кнопкою `type=button` і не читає нову FormData. Raw-only reload не означає previous unknown; restored firstIntent означає невизначеність. Перший живий доведений rollback звільняє intent, revision409 вимагає GET/Apply. Пізні4xx його не звільняють.

Позитивний ACK або creator identity зберігає confirmation **до** незалежного current GET. Confirmed більше не виконує POST; current503/reload зберігає цей стан і новіші невалідні поля. Current revision не стає baseline автоматично. Явне Apply змінює лише локальні baseline/raw і UUID; окреме Save робить mutation. Date/reason — одна консервативна atomic group; fiscal і percent — окремі групи.

Нова period форма завжди має порожню причину. Аудитована минула причина показується лише в поточному серверному значенні/порівнянні. Приватні GET/POST проходять fresh P0 grant і last-awaited live/abort/hash fences. Current403 очищує записи старого grant і приховує body; current401 прибирає приватний DOM до login. Public Cancel припиняє читання й відновлює доступні recovery controls. Password/users/account форми не enroll і не autosave.

## Цільові докази ·05.10.2026

Локальні оперативні `/tmp` шляхи — артефакти автора, не production дані.

| Перевірка | Результат / matching coverage |
| --- | --- |
| PostgreSQL `tests.test_setting_recovery` |6 PASS, `/tmp/tsukenya-settings-pg.log`: all3 exact replay/collision/changed current, legacy ABA, bound-owner compatibility, scalar READONLY/fresh role, actual HTTP/strict DTO, two concurrent identical requests та cached-role revocation під реальним ledger wait, period rollback, firstrevision409 і postcommit callback failure без proof |
| Змінений percent validator |Окремий strict test PASS, `/tmp/tsukenya-settings-pg-strict.log`; додано exponent1e1, successful6-case prefix reuse |
| Посилений scalar SELECT guard |Окремий current/fresh-owner test, `/tmp/tsukenya-settings-pg-scalar-final.log`; відхиляє direct full audit JSON SELECT, дозволяє member extraction |
| Codec |4unit PASS, `/tmp/tsukenya-settings-unit-final.log`: strict resource/semantic/ACK binding, invalid raw, frozen first/confirmation/Apply і proof transitions |
| Shared comparison |Лише новий `SettingPeriodTerms` Story PASS1 (інші9 не запускались), `/tmp/tsukenya-settings-story-v2.log`: keyboard choice переносить цілу date/reason group |
| `period` |Terminal PASS, `/tmp/tsukenya-settings-period-proof-v2/period-report.json`: raw/cold/Apply0POST, actual blocking-draft400 та corrected Save, committed lostACK/new invalid reason/later400, durable identity перед current503/reload, GET-only recovery;1440/320,44px, keyboard |
| `fiscal` |Terminal PASS, `/tmp/tsukenya-settings-fiscal-proof/fiscal-report.json`: raw/cold, actual first409, persisted review, Apply0POST/окремий Save |
| `discount` |Terminal PASS, `/tmp/tsukenya-settings-discount-proof-v2/discount-report.json`: comma raw/cold, actual first409, Apply0POST/окремий Save з fresh revision |
| `policy` |Terminal PASS, `/tmp/tsukenya-settings-policy-proof/policy-report.json`: actual role revocation/current403, private wipe/0POST; users password не серіалізується |
| `preflight` |Terminal PASS, `/tmp/tsukenya-settings-preflight-proof/preflight-report.json`: delayed ignored-abort session →suspend,0POST |
| `preflight-tail` |Terminal PASS, `/tmp/tsukenya-settings-preflight-tail-proof-v2/preflight-tail-report.json`: quota-before-fetch; real committed lostACK→positive preflight receipt→current503→reload invalid newer percent/0repeatPOST |
| `expiry` |Terminal PASS, `/tmp/tsukenya-settings-expiry-proof/expiry-report.json`: actual current401, private DOM/session records removed,0POST |
| Старі consumers |Тільки affected `erp-settings-ui.cjs` period/fiscal PASS, `/tmp/tsukenya-settings-compat-{period-v2,fiscal}.log`. Discount prefix пройшов до передчасного `isVisible`; тільки `QA_SETTINGS_FROM=discount-sale` tail PASS у `/tmp/tsukenya-settings-compat-discount-tail.log`. Збережено ліміт/state/reopen, actual sale fiscal requiredness і discount reason assertions; **цілий oldfamily run не заявляється PASS** |
| `layout` |Terminal PASS, `/tmp/tsukenya-settings-layout-proof/layout-report.json`: усі3 initial/raw forms1440/320, довгий fiscal option, dialog/page reflow,44px controls,0POST. Fiscal320 і period1440 PNG оглянуто |
| Інші gates |Own matching Vite/TypeScript build, scoped eslint/format, syntax/pycompile, makemigrations--check, additive existing-schema parity і static browser policy252 PASS. Full registry лише `--plan`, нові8 stages зареєстровано й selector scrubbed |

Усі browser stages використовували власний production build, disposable SQLite і bundled Chromium `headless:true`; системний Chrome не запускався. Build2/final змінив лише текст помилки невалідної причини/відсотків і явний тип `fields`; успішні business inputs не змінювались. Cash dependency ambiguity fix додано окремо без повторення її вже перевірених root сценаріїв.

Збережені невдалі артефакти: initial period показав реальний raw-only/unknown mixup, усунутий до v2; перший discount запуск без sandbox escalation не зміг bind localhost; Story v1 мав локальну symlink resolution помилку, v2 із власними APFS dependencies PASS; preflight-tail v1 звертався до непублічного payload entry, v2 перевіряє public metadata+actual reload; old period DELETE fixture не мала JSON body/revision, old discount хвіст поспішав до P0 grant. Їх не видаємо за цілий успішний набір.

## Межі

Пакет не реалізує зовнішнього ПРРО провайдера, credentials persistence, generic settings autosave, initiative actions або окремі standalone voucher post/reverse/delete families. Інші P1/P2/P3 boundary лишаються окремою роботою. Не запускали full regression, load/capacity, production mutations чи deployment. Перезавантаження відновлює чернетки лише в тій самій browser session після чинної авторизації; міжсесійної/міжпристроєвої persistence немає.
