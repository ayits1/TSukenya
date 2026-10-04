# B06 P1: reload чернетки місячного бюджету

База цього власного пакета — category `7788f2d` поверх accepted `cb8eca4`. Категорійний consumer/codec не змінено. Реалізовано реальний `MonthlyBudgets` у `#operations/expenses`, namespace `native-monthly-v1`; шаблон бюджету, P2/P3 та інші відкриті сім'ї не підмінено цим пакетом. Схему, ledger, рецепти фінансових підсумків і права не змінено.

## Межа збереження

Синхронний whitelist містить raw плановий виторг, до200 ordered рядків із незмінними UUID/category/mode/base та raw amount/rate. Грошові inputs тепер text+decimal inputmode, тому `-`, `1..2`, порожній рядок чи неточний відсоток не перетворюються на нуль. Серверний Decimal та чинний strict Save-validator лишаються авторитетними. Компонент вибору місяця/довідник зберігають тільки committed значення; тимчасовий пошук, відкритий popup та позиція прокрутки не є committed магазином/місяцем.

Raw значення полів вибору місяця/магазину відокремлені від **вже відкритого** authoritative контексту плану. Вони відновлюються без навігації та без зміни адреси Save. Підпис показує відкритий місяць/мережу або магазин; контекст змінюється тільки явним «Відкрити». Збережений ID/month/store незмінні. Invalid raw filter не використовується для авторизації іншого магазину. Beforeunload/route guard залишаються; Close/навігація не є Discard.

Окремий whitelist baseline має original terms/revision/історичні підписи рядків, frozen first UUID/method/path/body та confirmed ID. Серверні fact/coverage/comparison totals, довідник, список магазинів, permissions, credentials/CSRF і API caches не серіалізуються. Bounded P0 sessionStorage/owner/session/role/store та byte/node/record limits діють без truncate. Quota до beforeSend блокує business fetch.

## Переходи

- Cold reload не відновлює поля автоматично. Кнопка «Локальні чернетки» → явний Restore читає fresh session, pinned recovery-context та fresh readonly facts/choices. Async route/mount має Abort/generation/12s timeout; дозволені поля монтуються лише після strict decode. Warm повернення до тієї самої форми робить GET-only verification; dismissal recovery dialog не стирає вже відновлену форму.
- POST exact first intent durable **перед fetch**. Type-button повторює frozen UUID/body попри новіші invalid поля. Unknown/reload → будь-який наступний4xx не звільняє intent. Лише bound live-first HTTP400 rollback proof `{resource:'monthly_budget',request_key,write_rejected:true}` дозволяє виправлення; сигнал охоплює тільки atomic `budgets.save`, не commit callback/ACK serialization, Conflict409 чи authorization403. Це не глобальний доказ відсутності UUID. До-fetch quota failure, коли first intent ще не записано/нічого не надіслано, не створює удаваної ambiguity.
- Existing planning receipt/identity лишаються creator-bound. Positive identity, включно з readonly preflight під час Restore/verification, persisted **до окремого current GET**; повернена mutable revision не стає baseline. Deleted/tombstone блокує recreate. Legacy_unknown не доводить відсутності. Initial `budget_exists` пропонує explicit period/current comparison без creator claim; frozen intent не використовується для автоматичного POST. ID/revision чужого першого створення приймаються лише на Apply.
- Authorize спершу завершує P0 unchanged-storage fence. Лише після його успіху positive receipt підтверджується durable, перед mount/незалежним read callback. Позитивне підтвердження під час exact retry зупиняє зайвий POST; `legacy_unknown` лишає frozen intent без твердження про відсутність. Немає запису storage всередині codec.authorize, який порушив би його race fence.
- Кожний business POST/PUT після передзапитного P0 guard читає fresh session. Безпосередньо після останнього await і перед fetch перевіряються generation/hash/живий current/context/visibility/abort. Зміна actor/session/scoped контексту запускає P0 revalidation і блокує запис; pagehide/navigation/cancel не можуть пізніше надіслати frozen body. Failed final-session read не породжує автоматичного POST.
- Unknown PUT після reload не повторюється. Current GET/cats читаються через P0 verifyRead; старий baseline лишається до явного Apply. Виторг — independent field; умови одного рядка atomic. Зміна membership/order/removal-v-change обирає весь список, без union. Apply лише локальний, fresh revision Save — окремий.
- Strict ACK перевіряє ID/context/resource/key, ordered writable terms та revision. Identity/ACK envelope лишається після strict API validation, щоб durable confirmation повторно перевіряла authoritative key. Незалежний confirmed current GET потрібний перед cleanup; GET503 не породжує нового POST. Invalid newer raw лишається окремою чернеткою навіть при valid ACK.
- Read503/malformed/cancel приховують приватні plan/fact/category panels і лишають public GET-only access retry/cancel. Current resource403 прибирає лише denied record після fresh session recheck; actual role/store/session зміна чи401 застосовує P0 global privacy. Late response не приймає baseline/Apply. Actual401 повертає login; запити не повторюються автоматично.

## Цільові докази

- `monthlyPersistence.test.ts`:4 PASS — exact raw/extra rejection, UUID/order, frozen context/key/body, identity/tombstone без revision adoption, UPDATE Apply/cleanup, rollback-key binding.
- `tests.test_monthly_drafts`:3 PostgreSQL PASS; own QA DB `tsukenya_monthly_reload`, log `/tmp/tsukenya-monthly-drafts-pg.log`: fresh owner/store/deactivation; READ ONLY RR/no financial columns/no DML; invalid context; rollback/no audit; commit callback та receipt conflict без false no-write proof.
- Types, scoped lint, own matching build `/tmp/tsukenya-monthly-draft-build.log`, JS syntax/diff та bundled browser static policy PASS.
- Actual isolated SQLite/Playwright bundled headless Chromium: `/tmp/tsukenya-monthly-reload-final/primary-report.json` cold overview→Restore invalid revenue/amount, stableUUID,1440/320/44px; committed CREATE lostACK→reload→later400 exact terms; identity-before-current503→reload; keyboard Apply no write, separate Save/confirmed GET cleanup.
- `/tmp/tsukenya-monthly-update-final/update-report.json`: committed PUT lostACK/raw invalid reload; external authoritative line change→explicit whole-list removal; Apply no write, separate revision3 Save, final revision4/0 rows.
- `/tmp/tsukenya-monthly-validation-final/validation-report.json`: actual archived-category first400 rollback→explicit correction, same unusedUUID, один бюджет.
- `/tmp/tsukenya-monthly-policy-fixed/policy-report.json`: uncommitted month/store + invalid rate restore independently of pinned scope, before-send quota/no POST, canceled navigation/read fence.
- `/tmp/tsukenya-monthly-privacy-final/privacy-report.json`: actual owner→accountant між preflight/current403, hide/erase/no write; actual session deletion/current401→login/records removed.
- `/tmp/tsukenya-monthly-existing-proof/existing-report.json`: existing unsent reload потребує explicit current/Apply перед Save; separate revision1 Save/cleanup.
- `/tmp/tsukenya-monthly-session-final/session-report.json`: actual login того самого actor із новим сеансом прибирає raw777/888 із двох cached періодів; fresh server100/empty, no auto write.
- `/tmp/tsukenya-monthly-preflight-final/preflight-report.json`: positive preflight CREATE identity durable перед cold readonly facts503; next reload зберігає invalid newer raw/confirmed ID, no revision adoption/no duplicate POST.
- `/tmp/tsukenya-monthly-send-proof/send-report.json`: actual Save із delayed final-session await; pagehide приховує UI і відтинає generation, resolution → zero POST, original intent durable.
- Old-family affected independent/policy/create stages retargeted to public access gate; original merge/Save/budget_exists/late-navigation/private403 assertions retained. `/tmp/tsukenya-monthly-compat-independent/report-independent.json` , `/tmp/tsukenya-monthly-compat-policy/report-policy.json` і `/tmp/tsukenya-monthly-compat-create-complete/report-create.json`: terminal PASS. Source updated helpers wait actual error, not checking-before-send; resource403 перевіряє тільки denied record, не стирає unrelated month. Ці primary/old-family результати отримані до фінального preflight-confirmation extension; повторені лише два нові affected stages вище. У поточному harness exact-later400/403 assertion зберігається для `legacy_unknown` preflight, positive preflight натомість переходить до confirmed barrier без зайвого POST. Other matching formulas/history/receipt concurrency, shared monthly Story2/merge unit6 reused; no whole old-family/full suite claim.

Raw PNGs: `/tmp/tsukenya-monthly-reload-final/monthly-raw-1440.png`, `monthly-raw-320.png`;320 переглянуто, natural vertical flow без горизонтального обрізання. Caption про pinned context додано після цих raw PNGs; наступні policy/compat actual runs використовували цей caption. Незмінені успішні inputs повторно використано. Первинні failed artifacts збережені: shallow draft/baseline alias виправлено; подвійне reduced identity decoding виправлено; передчасний harness entries-empty wait замінено confirmed-ready barrier. UPDATE radio fixture ретаргетовано на keyboard; validation портовий overlap не є business proof та повторений на окремому завершеному процесі. Окрема old create перевірка виявила, що confirmed-read gate блокував «Оновити факт»; readonly retry розблоковано, Save/зміна контексту лишились guarded. Її entries-empty assertion тепер чекає confirmed-ready, а hidden-read helper — actual error, не pre-send gate. External fonts заблоковано у focused harness, щоб не залежати від Google CSS startup. Всі own сервери/браузери завершено.

```sh
env -i PATH="$PATH" PYTHON_BIN=/tmp/tsukenya-review-venv/bin/python QA_OUTPUT_DIR=/tmp/tsukenya-monthly-reload-proof node tests/monthly-draft-reload-ui.cjs
# Один незалежний affected stage, не вся матриця:
# QA_MONTHLY_DRAFT_FROM=update|validation|policy|privacy|session|existing|preflight|send
```

No VPS/production/Google Sheet/full regression/backup0.1/push/deploy. Між браузерними reads немає обіцянки persisted server snapshot; факт завжди readonly актуальний запит, historical/formula semantics чинні.

Фінальний static tail: browser-policy219, scoped ESLint/Prettier та JS syntax/diff PASS. Перший запуск нового preflight stage у sandbox не міг відкрити local socket (`Operation not permitted`), бізнес-сценарій не почався; повтор із дозволеним isolated localhost terminal PASS у `preflight-final`. Ці межі не є production/load/physical-print QA.

## Незалежний response-boundary follow-up

Окрема правка поверх `3e06f8a9e87eac9b3221a65d2e13484018ba4489`:
API перевіряє live/generation guard після останнього session await, після
`response.json()` і перед обробкою 401 або декодуванням ACK. Відповідь уже
надісланого POST, що закінчилася після pagehide/нової авторизації, не може
відкликати новий сеанс чи прийняти старий ACK. Frozen first intent залишається
для окремого identity/read recovery; невідомий результат не є доказом rollback.
Поточний business POST403 запускає свіжу P0 session-перевірку до будь-якого
повторного показу private UI. Та сама session identity зберігає початковий intent
і raw; підтверджена зміна session/role/scope прибирає приватні записи за P0.
Жодного автоматичного POST/PUT або прийняття нового revision тут немає.

Лише два нові actual isolated SQLite/bundled headless Chromium stages:

- `QA_MONTHLY_DRAFT_FROM=response`: PASS,
  `/tmp/tsukenya-monthly-response-proof/response-report.json` — issued POST401
  після pagehide та fresh warm authorization: zero global invalidation,
  no redirect/private hide, frozen100 + newer invalid raw, тільки один POST.
- `QA_MONTHLY_DRAFT_FROM=write403`: PASS,
  `/tmp/tsukenya-monthly-write403-final/write403-report.json` — реальне
  owner→accountant після final session preflight: сервер POST403, private
  plan/fact/category DOM прихований, revoked-session storage прибрано,
  бюджетів у БД нуль. Перший harness wait помилково прийняв pre-send gate за
  фінальний hide; failed artifact лишився у `monthly-write403-proof`, wait
  замінено на фактичну POST403 і виконано лише цей stage ще раз.

Own matching TypeScript/Vite build, JS syntax, diff whitespace та static
browser-policy219 PASS. Перед першим local run sandbox заборонив socket,
бізнесовий сценарій не почався; перевірки виконано з дозволеним isolated
localhost. Інші author unit/PG/layout/merge proofs вище використано повторно
без запуску: server, codec, shared controls і geometry не змінено. No full,
production/VPS/Sheet, push/deploy або нові міграції. Category baseline із
авторської гілки не є частиною цього follow-up; root інтегрує її окремі виправлення.

## Інтеграція після закупівель

Own monthly source та незалежні response fixes інтегровано поверх accepted main
із React-закупівлями. Конфлікти loader/import вирішено додаванням monthly
bridge: збережено category, recipe та work-shift recovery.
Matching TypeScript/Vite build, syntax/py_compile, diff whitespace і static
browser policy PASS. Один actual integrated preflight stage PASS: positive
CREATE identity durable до наступного facts503, reload зберігає newer invalid
raw та confirmed ID без прийняття revision чи повторного POST.
Попередні unit4, PG3 та targeted raw/privacy/response proofs використано
повторно за незмінних inputs. Full runner лише перевірено з --plan; додано
primary і10 окремих monthly scopes та scrub QA_MONTHLY_DRAFT_FROM.
Цей пакет не переносить шаблон бюджету й не означає завершення B06.

### CI fixture follow-up

Серверний Django SQLite CI пройшов845 tests, але наступний Node decimal
fixture не мав нового MonthlyBudgetPersistence bridge і зупинився на configure.
Додано лише VM fixture bridge з перевіркою складу callback configuration;
production/formulas не змінено. Повторено тільки monthly-budget-decimal:
exact .98/.99, negative facts/kopecks, ACK/rate3 PASS. Перша локальна правка
назвала bridge помилково; виправлено на фактичний MonthlyBudgetPersistence
і повторено цей самий вузький fixture. Full/Django/browser не повторювали.
