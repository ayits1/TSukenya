# B06 P1 · відкриття та закриття касової зміни

База власного пакета: `9ee4d2056f973305e8da3f02ad4ee82b7ffe02cd`. Actual `#trade/sales` → «Касові зміни» відкриває `TradeCashShiftEditor`; native cash callbacks і cold launcher використовують той самий renderer. Це завершена сім’я standalone open/close, а не завершення всього P1/P2/P3.

## Межа та протокол

- Raw whitelist: account/employee/counted/note як точні рядки, включно порожніми та невалідними. P0 storage/session/quota/privacy зберігаються; до бізнесового POST записано frozen first UUID/body. Newer raw не змінює exact retry.
- Optional UUID у чинному `/api/erp/shifts` додає immutable `CashShiftActionReceipt`; no-key legacy поведінка збережена. Міграція `0025_cash_shift_action_receipts` залежить від `0024_trading_versions`.
- Після ledger lock повторно читаються active actor/роль/scope/cashier-own close. Exact receipt перевіряється до mutable active employee/status/revision checks: повтор після закриття повертає початковий ID без audit/рухів. Інший author/body з тим UUID отримує409. FK PROTECT зберігає identity історичної операції.
- Fingerprint: SHA256 canonical JSON `[actorId, normalizedRequest]`, sorted keys, exact note; UUID не входить у body hash. Open account/employee IDs нормалізовано до integer/null. Close counted нормалізовано Decimal до2 знаків, note без обрізання (до4000), shift ID та observed32hex HMAC збережені. HMAC зміни включає stored fields/status, не поточний cash balance/sales.
- Existing server cash balance, close expected/count difference, audit та `post_cash_difference` лишаються authoritative в одній транзакції. Closed period відмовляє й відкочує close/receipt/movements. Немає нового payroll або cash правила.
- Versioned recovery-context/current/identity виконуються в fresh actor READ ONLY RR. GET параметри scalar unique, mode-specific; повторні keys та close account/open id відхиляються. Identity зв’язана з creator/fingerprint, `confirmed:false` не доказ нестворення. Positive identity durably зберігається **перед** окремим current GET, без adoption baseline.
- Outer atomic + inner rollback дають bound `write_rejected` лише first live validation400/revision409; collision403/unknown/postcommit failure не дають такого доказу. Після ambiguity пізні4xx не звільняють first intent.
- Confirmed operation тільки readonly current GET/retry; жодного повторного POST. Newer invalid inputs збережені. Explicit «Завершити перегляд і оновити список» не стирає local record — його можна видалити явною дією launcher.
- Close raw reload/conflict потребує current GET і shared atomic counted/note comparison, явний local Apply, окремий Save. Current policy mismatch/401/403 прибирає приватне тіло, invalid session очищує storage. Cancel/late response/preflight fences не відкривають застарілу форму й не надсилають business POST.

## Перевірки та артефакти

Усі browser stages — власний matching build, disposable SQLite, bundled Chromium `headless:true`, без channel/executablePath; сервер/браузер закриваються. Це шість незалежних terminal stages, не цілий повтор старої Sales/native матриці.

| Stage | Terminal artifact | Доказ |
| --- | --- | --- |
| open | `/tmp/tsukenya-cash-shift-open-proof-v5/open-report.json` | raw/cold, real committed lostACK, invalid newer required field, frozen exact retry, later bound400 не очищує unknown; identity→current503→reload;1440/320/44px |
| close | `/tmp/tsukenya-cash-shift-close-proof/close-report.json` | invalid money reload, atomic Apply без POST, separate Save, lostACK/current closed readonly, рівно1 cash_difference0.13 |
| policy | `/tmp/tsukenya-cash-shift-policy-proof/policy-report.json` | actual first already-open400 correction + current role403 private hide |
| preflight | `/tmp/tsukenya-cash-shift-preflight-proof/preflight-report.json` | ignored abort/delayed session suspend→0POST; quota-before-send0POST |
| conflict | `/tmp/tsukenya-cash-shift-conflict-proof/conflict-report.json` | actual initial revision409→raw persisted/reload→Apply0POST→separate close |
| expiry | `/tmp/tsukenya-cash-shift-expiry-proof/expiry-report.json` | current actual GET401 removes private DOM/storage,0business POST |

`confirmed-open-320.png` у open directory переглянуто: читабельний readonly receipt/current і controls без horizontal overflow. Physical screen reader/інші engines/load benchmark не перевірялися.

PostgreSQL `tests.test_cash_shift_recovery`: початковий run5/6PASS, лише неправильний synthetic fixture одного тесту виправлено; affected tail1PASS (`pg-tail2.log`). Окремі scoped HTTP/read-only query case1PASS (`pg-http2.log`), actual ledger-wait cached-role revocation1PASS (`pg-wait.log`), scalar duplicate/mode HTTP query1PASS (`pg-query.log`). Логи мають префікс `/tmp/tsukenya-cash-shift-`. Concurrent identical open/close, normalized replay after close/inactive employee, author/body collisions, cashier-own guards, legacy no-key, closed-period rollback та postcommit-no-proof перевірені. Це8 цільових cases із reused успішним prefix, не новий full PG run.

Codec4PASS (`unit-final.log`), TypeScript PASS, scoped lint PASS (`lint3.log`), own Vite build PASS (`build2.log`). Shared NativeConflict «Cash Closing Terms» Story1PASS (`story2.log`),8 unselected: atomic group/radio keyboard/Apply без HTTP; shared visual implementation unchanged. Initial fixture/routing/restoration/dependency failures збережені в попередніх logs/partials; їх не названо успіхом. Final browser static guard246 files PASS без запуску, JS/Python syntax/Prettier/diff PASS; isolated `makemigrations --check --dry-run` no changes. Повна регресія/production mutations не запускалися.

Команди незалежних stages:

```sh
PYTHON_BIN=/tmp/tsukenya-review-venv/bin/python QA_CASH_DRAFT_FROM=open node tests/cash-shift-draft-reload-ui.cjs
# close / policy / raw-rejection / preflight / conflict / expiry — окремі stages
QA_SALES_FROM=cash-actions PYTHON_BIN=/tmp/tsukenya-review-venv/bin/python node tests/react-sales-ui.cjs
```

Full registry включає сім cash stages і scrub `QA_CASH_DRAFT_FROM`; explicit full pass тут не виконувався. Старі Sales cash callbacks адаптовано до explicit finish і очікування completed refresh/actionability перед keyboard Enter (економічний assert0.13 збережено). Окремий `cash-actions` terminal PASS: `/tmp/tsukenya-cash-shift-sales-compat-final/cash-actions-report.json`, рівно2 POST і cash_difference0.13. Попередні compatibility timeouts та diagnostic trace PASS збережені; final test більше не містить monkeypatch/довільного timeout. Selector не повторює Sales journal/post/refund families.

## Залишки

Standalone posting/reverse, voucher DELETE, period/fiscal/discount/settings actions — наступні окремі whole families; credentials ніколи не зберігаються. Managed tasks/initiative mutations та P2/P3 closure цим пакетом не заявляються. Не додаються нові persistence-after-other-session гарантії чи нові owner бізнес-рішення.

## Root integration after accepted PR116

Own source16a94/test-doc727f3 commits інтегровано на acceptedfb920 без старих
залежностей. Conflicts у loader, native entry та full registry вирішено
additively: ordinary/managed recovery й старі stages збережено. Root matching
frontend build67964/types94881 PASS; syntax/diff/plan-only PASS.

Affected actual `cash-actions` на інтегрованому коді terminal PASS77453:
keyboard account/employee → open → explicit finish → current close callback →
counted0.13; рівно2 business POST та один authoritative cash_difference0.13.
Артефакт `/tmp/tsukenya-cash-integration-callback/cash-actions-report.json`; лог
`/tmp/tsukenya-cash-integration-callback.log`. Endpoint/codec proofs незмінні й
використані повторно, full/production mutation не запускалися. Прийняття й
розгортання пакета ще не підтверджені.


## Root review · never-sent raw recovery

Відновлення raw без firstIntent ще не є невизначеним надсиланням. Renderer
ініціалізує ambiguity лише з наявного frozen firstIntent; після успішного явного
Apply з новим UUID скидає ambiguity. Unknown exact intent та його пізні400/409
залишаються frozen. Відхилений Apply або помилка storage не скидають прапорець.

Actual isolated `raw-rejection` спочатку відтворив дефект (before-v2): після
reload першої ненадісланої форми actual rolledback400 помилково лишав exact retry.
Після виправлення open prefix пройшов; close fixture мав помилкове поле status
замість closed_at, що виправлено лише в тесті. Final affected stage PASS:
`/tmp/tsukenya-cash-raw-rejection-fixed-v2/raw-rejection-report.json` — raw reload,
first400 correction, close explicit Apply без POST, separate close first bound400.
Усього2 спроби POST; закриття й cash movements не створені. Backend не змінено.
