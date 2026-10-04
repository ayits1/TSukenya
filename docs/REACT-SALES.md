# React: продажі та касові зміни

Реальний маршрут `#trade/sales` використовує React/TypeScript workspace з двома
вкладками: документи продажу та касові зміни. Це частина STACK-EVOLUTION етапу 3.
Журнал містить продажі, повернення покупців і замовлення покупців. Це кодова
інтеграція; її наявність у Git не підтверджує deployment.

## Межа міграції

- Спільні React Aria `DirectoryComboBox`, `Select`, `TextField`, `DatePicker`,
  `Button` та вкладки. Сервер обробляє магазин, вид, стан, пошук, період і сторінки.
- Продажі: 30 заголовків на сторінку; пошук за номером або покупцем. DTO містить
  лише потрібні реквізити, без payload, рядків, собівартості й розрахунків.
- Каса: 30 змін на сторінку; фільтри магазину, працівника, стану й дати відкриття.
  Дати фільтруються та показуються за Києвом. Очікувана готівка — зафіксована при
  закритті сума; розходження — серверний Decimal, фактична мінус очікувана.
- Збережено чинні native редактори документів, details/edit/save/post/reverse/
  delete, замовлення → продаж, продаж → повернення, платіжні рядки, керування
  замовленням та відкриття/закриття каси. Нові кнопки викликають ті самі функції.
  `data-document-id` лише допомагає знайти документ, не запускає native dispatcher.
- `mount()` чекає обов'язкові читання та відхиляє Promise після невдалого refresh.
  Якщо збереження вже підтверджено, повтор оновлення виконує лише читання.
  Помилка відкриття документа зберігає чинну дію повторного відкриття.
- Route/lifetime fence відкидає запізнілі відповіді, навіть якщо transport ігнорує
  abort. Fresh 401/403 або зміна policy прибирають приватні суми, підписи, пошук
  і дії. Магазин scoped користувача зафіксовано; касир може закрити лише свою
  відкриту зміну. `canClose` є UI-підказкою; сервер повторно перевіряє POST.
- Табель працівників і вибір касової зміни в native документах залишаються на
  чинних bounded читачах. `app/erp-shifts.js` та `/api/erp/shifts` потрібні цим
  користувачам і не видаляються. Native редактор, чернетки, payment/posting API,
  гроші, запас і зарплатні формули не перенесено в браузер.

## Читання та контракт

`server/erp/sales_reads.py` використовує fresh actor у READ ONLY REPEATABLE READ.
Count і scalar projection виконуються в одному snapshot, матеріалізується до
30 рядків. Журнал не завантажує Voucher instances/payload/lines; каса не
завантажує CashShift instances/note або приватні умови зарплати працівника.
Жоден новий endpoint не записує бізнес-дані.

Два GET `/api/v1/trading/sales/documents` і `/cash-shifts` описано в
`contracts/trading-sales.openapi.json`. `npm run generate:api` генерує
`frontend/src/shared/api/sales.generated.ts`. Runtime decoder додатково
перевіряє exact keys, primitive enums, policy/scope, query echo, сторінки,
унікальні ID, decimal strings і зв'язок стану зміни з її датами/сумами.
Клієнт лише форматує грошові рядки, без арифметики через JavaScript Number.
Дата запиту має канонічний ISO-формат; неіснуюча календарна дата timestamp
відхиляється навіть тоді, коли JavaScript Date нормалізує її.

## Цільові докази

- `tests.test_sales_reads`: PostgreSQL 5 PASS (0.742 s), включно з реальним
  конкурентним записом між count/projection, fresh role/store/cashier authority,
  scalar SQL, 68 документами/62 касовими змінами, точними копійками та межею
  київської дати. SQLite: чотири відповідні семантичні перевірки; RR лише на PG.
  Лог `/tmp/tsukenya-sales-pg.log`; disposable база й роль видалені після запуску.
  Після посилення ISO date validation повторено лише strict query/HTTP case
  (SQLite PASS0.010 s, `/tmp/tsukenya-sales-query.log`) і timestamp unit case
  (PASS90 ms). Незмінні PG snapshot/scalar докази перевикористано.
- Strict API/state: 6 PASS. Перевірено чужий магазин, array enum, нечислові DTO,
  точне форматування великих сум, required-read failure, stale403 після нового
  mount, policy drift, route leave та callback лише для показаної зміни.
- `Trading/Sales`: два synthetic stories PASS — клавіатурні вкладки/пагінація
  та read failure. Storybook і застосунок використовують той самий компонент.
- TypeScript/build, scoped ESLint/Prettier і синтаксис змінених JS helpers PASS.
  Full registry доповнено сценарієм та очищенням його flags; виконано лише
  `npm run test:full -- --plan`, без повної регресії.
- `tests/react-sales-ui.cjs` на власній SQLite/DATA_DIR та bundled headless
  Chromium: journal30/67, cash30/62, paging/focus/search, native create трьох
  видів, замовлення → продаж, збереження PUT → list503 → GET-only retry,
  проведений продаж із банківською оплатою → пов'язане повернення,
  відкрита/закрита каса з `cash_difference=0.13`, late response після виходу,
  scoped manager320 і fresh warehouse403 clearing без записів.
- Візуально переглянуто workspace1440 і картки320. Перевірено 44 px controls,
  ширину сторінки **та внутрішню ширину таблиці**. Старий глобальний
  `table { min-width:640px }` перекрито у sales table; суми й кнопки не обрізані.
- Адаптовано старі sales/shift test consumers до public controls. Цільовий
  `directory-toolbar-ui.cjs`, `sales-320` PASS: пошук/клавіатура/тимчасовий текст
  проти committed ID, точні фільтри GET; native cash menus1440/390 з Escape.
  Артефакт `/tmp/tsukenya-sales-directories-proof/report.json`.

Результати перевикористано після незмінних входів; невдалий helper повторювався
лише з потрібної стадії. `/tmp/tsukenya-sales-proof/` містить:

- `primary-partial.json`: успішні journal/paging/search до виправлення часової
  умови synthetic cash fixture; `cash-report.json`: наступний цільовий cash PASS.
- `callbacks-partial.json`: create/order PASS; `callbacks-tail-report.json`:
  save/refund/cash PASS після розгортання native додаткових реквізитів у helper.
  Старе слово `mixed` у цьому JSON описує один банківський платіж; джерело helper
  виправлено на `preserved`, перевірки різних payment method тут не заявляються.
- `lifecycle-partial.json`: late/scope PASS; `privacy-report.json`: privacy PASS
  після коректного reload того самого URL у helper.
- `capture-report.json`, `documents-1440.png`, `documents-row-320.png`,
  `shifts-1440.png`, `shifts-row-320.png`: фінальна геометрія після CSS-виправлення.

```sh
npm run test --workspace frontend -- src/features/sales/api.test.ts src/features/sales/state.test.ts
npm run test:components --workspace frontend -- src/features/sales/Sales.stories.tsx
PYTHON_BIN=... QA_SALES_FROM=primary node tests/react-sales-ui.cjs
PYTHON_BIN=... QA_SALES_FROM=callbacks-tail node tests/react-sales-ui.cjs
```

`QA_SALES_FROM` дозволяє `all|primary|callbacks|callbacks-tail|lifecycle|late|scope|
privacy|layout|cash|capture`; `all` — весь helper, не вся регресія репозиторію.
`QA_SALES_PORT` і `SALES_PROOF_DIR` ізолюють паралельні запуски. Helper прибирає
DB/PG/production-secret env до створення hash/server, завершує власний процес
(SIGTERM, через 5 s SIGKILL) і видаляє власні дані.

## Межі доказів

Не виконували production mutations/deployment, Linux PNG baseline, повний набір
native сценаріїв, capacity benchmark або screen-reader перевірку. Збереження,
проведення й закриття каси перевірено на ізольованих даних; їхні серверні
реалізації не змінені. Інші CRM модулі та редактори документів і далі змішані.

## Незалежне рев’ю native callback boundary

Окремий follow-up поверх exact `ba592405679b1c6835b21aa17858890073845de8`:

- Current native document detail401/403 більше не поглинається
  `openSalesDocument`: помилка доходить до `SalesModel.action` і deny прибирає
  приватні результати, фільтри й дії. Non-auth помилки зберігають чинний
  `savedRefreshFeedback` та окремий GET-only retry.
- `viewVoucher` передає optional response-live guard: перевірка після awaited
  bootstrap, до глобальної401/decode/hydration і після awaited captions.
  Obsolete GET не може відкликати новий сеанс або відкрити модальну форму.
  Для інших API callers optional guard є no-op; write/receipt/posting semantics
  не змінено.

Виконано тільки два нові actual isolated SQLite/bundled headless Chromium stages:
`QA_SALES_FROM=detail-privacy` — PASS,
`/tmp/tsukenya-sales-detail-privacy/detail-privacy-report.json` (реальне
owner→warehouse перед current detailGET: сервер403, private rows/captions/actions
прибрано, no forbidden retry/no writes);
`QA_SALES_FROM=detail-late` — PASS,
`/tmp/tsukenya-sales-detail-late/detail-late-report.json` (затриманий native
GET401 після routeleave/new successful mount: zero global invalidation,
no redirect,30 fresh rows, no modal/no writes).

Own matching TypeScript/Vite build, JS syntax/diff і static browser-policy223
PASS. Незмінені server scalar/RR/precision, strict API/state, shared stories,
layout і posting/cash author proofs вище повторно не запускались. Це read/action
boundary перевірка двох знахідок, не full regression/production deployment.
Full runner вже очищує `QA_SALES_FROM`; нових env flags не додано. Обидва stages
доступні явно; `all` включає їх у чинний helper.

## Інтеграція в accepted портал

Own source та незалежний callback fix інтегровано поверх accepted PR105.
Адитивно збережено recipe await/recovery, work-shift recovery та всі purchases
loader/routes. Shared trading readiness helper тепер чекає актуальний React
sales root та завантажені дії; portal/zoom checks використовують його для
обох migrated routes. Matching TypeScript/Vite build, JS/Python syntax,
diff і static browser policy PASS; full runner тільки --plan.
Actual integrated cash stage PASS: pages30/62, server shortage -0.13,
Kyiv times, keyboard/layout1440/320. Author PG5/unit/stories/callback/privacy
та два незалежні detail regression proofs reused за незмінних inputs.
Пакет ще не розгорнуто; бухгалтерські записи лишаються Django/PostgreSQL.
