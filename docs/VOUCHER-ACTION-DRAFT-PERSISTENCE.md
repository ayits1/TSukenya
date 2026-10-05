# B06: окремі проведення, сторно та видалення документа

Власна база `9cbd49d`; схема `0027_voucher_action_receipts` залежить від реальної
`0026_setting_action_receipts` (прийнята main `4b0bbeb`). Пакет додає відновлення
**реальних** кнопок `post-voucher`, `reverse-voucher`, `delete-voucher` у detail
документа. Save+Post редактора залишається окремою вже реалізованою машиною.
Це не оголошення завершення всього B06, P2/P3 чи destructive expense DELETE.

## Сервер і контракт

- `POST /api/v1/trading/voucher-actions/execute`: точні поля `key, action, id,
  kind, store, expenseScope, revision, reason`. UUID і цілий нормалізований запит
  прив'язані до creator. Причина сторно, як і раніше, обов'язкова та непорожня;
  її технічна межа — 4000 символів. Для інших дій причина порожня.
- `VoucherActionReceipt` зберігає лише відому scalar identity/terms/outcome;
  немає FK, що забороняє видалення voucher. Receipt переживає DELETE. Це не
  повний історичний документ, не поточна ревізія і не permission grant.
- Fresh actor, роль, магазин, kind та чинна network expense policy перевіряються
  **перед** receipt replay. Creator/body/action collision — 409 без розкриття
  чужого запиту. Exact receipt читається **до** target existence/status/period:
  повтор підтверджує первинну дію без нових рухів навіть після наступного сторно,
  закриття періоду або DELETE. Авторизація при цьому залишається поточною.
- Нова дія перевіряє observed revision під чинним LedgerLock. Викликає існуючі
  `post_voucher` / `reverse_voucher`, або чинний draft-delete audit/delete в тій
  самій atomic транзакції з receipt. Облік, ціни, залишки, COGS, зарплата,
  залежності/сторно, locks і legacy post/reverse/DELETE API не переписані.
  DELETE зберігає існуючу політику: видалення чернетки саме по собі не отримує
  нового обмеження closed period.
- Bound `write_rejected:true, request` видається лише після rollback цієї
  дозволеної першої спроби (BusinessError400 / revision409). Auth/collision і
  serialization/on_commit після commit не отримують no-write proof. Клієнт
  звільняє intent лише для першої live спроби, яка ще не мала unknown; після
  reload/unknown пізніший4xx не звільняє frozen key/body.
- `POST .../identity` — CSRF-protected READ ONLY REPEATABLE READ, exact creator
  + request binding. `confirmed:false` не доводить відсутність попередньої дії.
- `GET .../context` — READ ONLY RR, fresh actor/scope, рівно один екземпляр
  кожного query ключа. Замість повного payload читає scalar expense scope.
  `canExecute` — лише поточний hint, не grant. Closed/deleted запис залишається
  доступним для дозволеного recovery view; actual action перевіряє сервер.
- OpenAPI: `contracts/voucher-actions.openapi.json`; strict network/storage
  decoder: `frontend/src/shared/native/voucherAction.ts`.

## Actual consumer та переходи

`app/erp-voucher-actions.js` зареєстровано у P0; `app/erp.js` відкриває фактичну
форму після fresh context. Початкова identity копіюється **до першого await**.
Приватний source detail приховано ще під час перевірки; public retry/Close
лишаються доступними. Cold Restore переходить до відповідного торговельного
маршруту та чекає actual mounted event (abort/route/error/30s timeout fenced).

Синхронний raw capture зберігає причину, у тому числі новіше invalid порожнє
значення, baseline, original UUID/body/revision і окреме positive confirmation.
Before-send durable capture/quota gate передує бізнес-fetch. Exact retry має
`type=button` і повторює frozen body, не валідує новіше invalid введення.
Немає автоматичних дій при mount/Restore/focus або після failed GET.

Positive ACK/identity durable записано **до незалежного current GET**. Identity
не підміняє baseline revision. Поточний документ читається окремо лише для
перегляду; дві незалежні RR відповіді не є persisted immutable snapshot. При
розходженні kind/store/status/revision читання відхиляється. Явний Apply бере
поточну revision в локальний новий намір; окрема кнопка виконує дію. Confirmed
outcome блокує повтор; explicit Done прибирає локальний receipt і повертає
чинні detail callbacks або список після DELETE.

Fresh P0 `verifyRead` приховує приватні heading/body/footer. Role/store/session
зміна стирає відповідний приватний scope, resource403 зберігає інші дозволені
чернетки,503 не стирає local input. Retry лише GET. Cancel abort/generation
відсікає пізній401 до invalidation/redirect. Скасування читання знову вмикає
public access-check; warm reveal повертає фактичні controls у доступний стан.
Збережені grants, csrf/credentials, document full cache чи derived totals відсутні.

## Цільові докази

Ізольовані дані, bundled Playwright Chromium `headless:true`; без системного
Chrome, production/Sheet/full suite. Артефакти:
`/tmp/tsukenya-voucher-action-proof/`.

- `pg.log`: initial5 PostgreSQL PASS — stock/cash parity, exact replay після
  mutable status/period, DELETE tombstone/creator/privacy/RR/no-DML,
  rollback-vs-postcommit proof, реальні parallel workers: один receipt/рух/audit.
- `scalar-pg.log`: affected1 PG PASS — duplicate/wrong query identity відхилено
  до voucher projection, scalar-only context, closed post vs existing delete.
- `native-actions/actions-report.json`: terminal actual3 actions PASS —
  post/reverse/delete committed→lostACK→reload→exact retry/identity, raw blank
  newer reason, один рух/сторно; positive DELETE identity→current503→reload
  confirmed barrier без POST. Цей доказ отримано до пізнішого розширення
  readonly summary і completion callback; їх перевіряє окремий callbacks stage.
- `native-policy/policy-report.json`: actual owner→cashier під час recovery read
  hides heading/body, records erased, action writes0.
- `native-validation/validation-report.json`: first revision409→current
  changed note→explicit Apply→окрема action revision2.
- `native-quota/quota-report.json`: storage failure перед fetch, action writes0.
- `native-read/read-report.json`: terminal3 PASS — current503 hides private
  поля й зберігає unsent намір; GET-only retry; cancelled issued context401
  (transport ignores abort) не invalidates/redirects; actual session expiry
  приховує heading/body до login navigation та стирає private record, writes0.
  Під час цього affected proof виправлено stale disabled controls після reveal
  та Cancel. Інші дві проміжні відмови спричинив неправильний `page.unroute`
  harness call: mock401 лишався на наступний чинний запит. Виправлений terminal
  run пройшов; failed artifacts збережені як діагностика, не PASS.
- `native-callbacks/callbacks-report.json`: terminal1 PASS — explicit Done
  повертає actual posted detail і receipt-pricing callback; readonly current
  product caption перевірено strict decoder, додаткових action writes немає.
- `native-unknown/unknown-report.json`: terminal1 PASS — unknown503→reload→
  пізніший bound409 зберігає first UUID/body; identityfalse не absence;
  тільки exact original retry проводить дію.
- Typed decoder4 PASS (`unit.log`), scoped TS lint/Prettier PASS, own matching
  Vite build PASS (`build.log`), schema check PASS з прийнятими QA-only0025/0026
  (`schema.log`), changed JS syntax і diff-check PASS. Missing workspace-only
  `@eslint/js` у початковій локальній копії deps взято з matching canonical
  workspace без зміни package/lock. Обидва `action-confirmed-1440.png` і
  `action-confirmed-320.png`, final `native-callbacks/action-current-1440.png` та
  `action-current-320.png` переглянуто: dialog/controls fit, horizontal
  overflow assertion PASS. Unchanged P0 RecoveryPanel stories reused.

Команди:

```sh
# Схема QA включає реальні прийняті0025/0026 залежності; вони не own delivery.
DB_HOST=127.0.0.1 DB_PORT=61144 DB_NAME=tsukenya_voucher_actions DB_USER=postgres \
  /tmp/tsukenya-review-venv/bin/python manage.py test tests.test_voucher_actions --noinput
# Пароль/secret — окремі ізольовані QA змінні, не production credentials.
PYTHON_BIN=/tmp/tsukenya-review-venv/bin/python \
  QA_OUTPUT_DIR=/tmp/tsukenya-voucher-action-proof/native-actions \
  node tests/voucher-action-reload-ui.cjs
# Independent allowlisted stages з тією самою командою:
QA_VOUCHER_ACTION_FROM=policy # validation / quota / read / callbacks / unknown
npm run test --workspace frontend -- src/shared/native/voucherAction.test.ts
```

Синтаксично retargeted successful post/delete entrypoints у React
purchases/sales/stock, receipt review, erp browse/recovery і draft-revision
fixtures: тепер action dialog→explicit CTA→confirmed→Done. Старі бізнесassertions
залишені. Stale detail revision case зберігає legacy endpoint409 перевірку й
окремо доводить UI fresh preflight без blind action. **Цілі старі сімейства не
повторювалися і не оголошуються PASS.** Незмінені формули/історія/P0 shared
RecoveryPanel stories reused. Інші браузерні engines/screen readers, capacity,
усі voucher kinds у цьому native proof та повна регресія не перевірялися.

## Root integration

Інтеграція збережена разом із cash/settings/managed/initiative consumers:
п’ять текстових конфліктів об’єднано без видалення чинних редакторів і
нових cash completion fixtures. В явний full entrypoint додано всі сім
allowlisted stage та scrub QA_VOUCHER_ACTION_FROM; runner перевірено лише
з --plan. Matching frontend build, синтаксис, diff-check і статична browser
policy PASS. Один додатковий actual callbacks stage на об’єднаному коді
PASS: підтверджене проведення → explicit Done → чинні detail/price-review
callbacks, назви товарів після strict decode; додаткових бізнес-запитів немає.
Незмінені accounting/інші native proofs вище використано повторно.

### CI SQL oracle correction

Стара перевірка `payload,` помилково відхиляла SQLite JSON_TYPE/JSON_EXTRACT
із scalar expense_scope. Тепер перевіряється raw SELECT projection, включно
DISTINCT/alias; count=1, PostgreSQL JSON operator та query rejection до
projection збережені. Один змінений scenario PASS SQLite і PostgreSQL.
Бізнес-код і незмінені native/build/accounting докази не змінено/не повторено.
