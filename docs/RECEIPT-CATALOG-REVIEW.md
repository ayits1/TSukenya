# Накладна → перегляд каталожних цін → цінники

Третій пакет issue1 §3.3. База авторського checkout — `9663dbf`
(інтеграція ready87 і пакета 2). Нових міграцій немає.

## Реальний сценарій

У підтвердженому detail надходження, зі збереженої чернетки або проведеного
документа, є кнопка «Переглянути закупівельні та продажні ціни». Вона відкриває
React/TypeScript екран, прив'язаний до ID накладної. Невідомий результат Save
накладної не є джерелом цього переходу.

1. Readonly читання показує статус, облікову дату, суму та додаткові витрати,
   історичні рядки з кількістю/одиницею/партією/ціною `.0001` і поточний каталог.
   У чернетці розподіл складської вартості ще не виконаний; у проведеному
   документі збережена складська вартість рядка показана окремо.
2. Оператор явно включає товари. Для повторного SKU обирає конкретний рядок
   накладної або вводить закупівлю каталогу вручну. Рядок можна перенести тільки
   за точної відповідності одиниці та ціни з двома значущими знаками після коми:
   `12.5000` → `12.50`; `13.1234` потребує явного введення. Перерахунку кг/шт,
   вибору останньої/середньої/landed вартості чи політики ПДВ тут немає.
3. Причина, націнка, ручна продажна ціна й підтвердження перевірки ціни задаються
   явно. Окремий серверний перегляд показує стару й нову звичайну та чинну
   продажну ціну з урахуванням ручної ціни, округлення, flat/campaign акції.
4. Лише окрема кнопка запису підтверджує підписаний план. Проведення накладної
   саме по собі не переписує закупівлю, продаж чи дату перевірки каталогу.
5. Підтверджений результат має перехід «Вибрати змінені цінники у Studio».
   Передаються тільки kind `import` і UUID квитанції. Пакет 2 заново читає чинні
   ціни: основна група — реально змінена продажна ціна, окрема явна група —
   зміни звичайної/перекресленої ціни або акційної позначки. Кількість записаних
   товарів не названа кількістю змінених продажних цін.

Облікова дата накладної і поточний день перегляду цін у Києві — різні поля.
Поточний день, а не backdated invoice date, визначає чинність кампанії.
Закупівля та звичайна ціна каталогу спільні для мережі. Явний ERP store context
визначає магазинні акції; network — окремий контекст, не мінімум магазинних цін.
Магазини обираються через спільний bounded `DirectoryComboBox`, серверний пошук
і сторінки по 30. DTO перегляду не завантажує весь довідник магазинів.
Network доступний лише актору без прив'язки до магазину.

## API, авторитетність і межі

Окремий `contracts/receipt-catalog.openapi.json` та generated TypeScript:

- `GET /api/v1/receipt-pricing/{id}` — поточне джерело, Product DTO,
  `sourceSnapshot`, підтверджений context/day/session. `?store=ID|network` явний;
  omission використовує магазин накладної.
- `POST /{id}/preview` — readonly пропозиція з `sourceRevision`, HMAC джерела,
  `priceContext`, reason та ordered entries з ID/revision, optional sourceLine
  `{id,lineKey}` і лише п'ятьма writable price fields.
- `POST /{id}/commit` — той самий незмінний payload + перевірений `snapshot`
  + `idempotencyKey`. LedgerLock, fresh actor, current role/source/context scope
  до пошуку квитанції/колізій; весь запис, price history, audit і журнал атомарні.
- `GET /{id}/results/{UUID}` — creator-only історична квитанція з повторною
  перевіркою чинних прав та scope. Read не є поточною baseline каталогу.

GET/preview/result виконуються у strict RR/READ ONLY з fresh actor. Source lines
вибираються через SQL `LIMIT 201`, перш ніж відмовити історичному документу понад
200 рядків. UI показує 20 SKU на сторінці; selected proposals максимум 200.
PriceResolver завантажує лише ID товарів джерела/пропозиції. Before/after history
спостерігає вибрані товари одним batch до та одним після запису.

Підпис охоплює source/status/line identity, actor, ordered proposal, конфігурацію,
Product revisions, current day та resolved promotion tuple. Зміна джерела,
каталогу, кампанії або дня до Save дає відмову без часткового запису. SourceLine
зв'язується за ID + UUID + product + unit; назва не є ключем. Частковий adapter
не записує довільні form metadata/reference/promotion fields.

Точний повтор повертає оригінальний результат без повторного write/audit, навіть
після новішої зміни джерела або каталогу; чинні права/scope перевіряються повторно.
Операція дзеркалюється у чинний import journal з immutable priceResult; пакет 2
читає результат сторінками по 100 і відрізняє його від current signed review.
CSV `purpose=receipt` допускає повтор SKU лише з різною партією/expiry identity;
інші purposes зберігають чинну відмову повторного SKU та precision `.0001`.

## Чернетка та відновлення

Opening baseline, локальні поля й fresh comparison розділені. Shared
`threeWay` + `ConflictComparison` зводять атомарну групу price terms/sourceLine
кожного SKU, включення товару та незалежну причину. Same-group conflict потребує
вибору; Apply лише локально приймає fresh baseline і узгоджену пропозицію.
Новий preview і Save — окремі дії. Наявний пропущений/прихований SKU не
переприв'язується за назвою; можна явно виключити його й перечитати джерело.

Pending/error нового магазину залишає попередній підтверджений caption/context
і fields; записи заблоковані до readonly read та явного Apply. Cancel,
read503/403/malformed, ignored abort/late response, close і другий409 зберігають
пропозицію та не підхоплюють revision автоматично.

Lost ACK заморожує UUID/body. Пізніший exact retry 4xx не доводить відсутність
первісного запису: intent зберігається для точного повтору або GET результату.
Новіші, навіть невалідні поля не блокують exact original/GET. Підтверджена
квитанція не усиновлює baseline й не очищає новіше введення. Перехід до Studio
з dirty полями має окреме підтвердження закриття. Немає автоматичного друку,
підготовки proof чи запису макета; існуючі copies/layout/proof fences пакета 2
залишаються чинними.

Reload не обіцяє persistence незаписаної пропозиції або unknown browser intent.
Підтверджена серверна квитанція залишається у журналі. Автовибір cost, ПДВ,
перерахунок одиниць, store-specific manual override та збільшення межі 200 не
є реалізованою бізнес-політикою.

## Manifest

- `server/erp/receipt_pricing.py` — bounded source, RR preview/result,
  authoritative atomic commit і immutable journal receipt.
- `server/erp/views.py` — additive route/static/manifest hooks і receipt-purpose
  CSV. `app/erp.js` — кнопка confirmed detail; `app/receipt-catalog-review.js` —
  лише mount/close/Studio bridge.
- `frontend/src/features/receipt-pricing/` — strict API/model, recovery hook,
  пагіновані PriceCards, bounded PriceContextControl та компоновка React UI.
- `frontend/src/receipt-pricing-entry.tsx` — окремий Vite entry.
- Shared Select має optional `portalContainer`: нативний dialog залишає options
  у своїй modal top layer; без цього параметра поведінка попередня.
- OpenAPI/generated types/generator і explicit full entrypoint доповнені;
  повний прогін під час розробки не запускався.

## Цільові докази (авторський checkout, синтетичні дані)

- **13 різних PostgreSQL сценаріїв PASS** у власних disposable test DB на
  localhost61144; не одна повторна suite. Основні 8:
  `/tmp/tsukenya-receipt-pricing-pg.log`; real ledger wait actor revocation:
  `-actor-pg.log`; batch history: `-batch-affected.log`; auth-before-collision та
  bound201: `-review-pg.log`; unit mismatch/manual proposal: `-unit-pg.log`
  (усі з префіксом `/tmp/tsukenya-receipt-pricing`). Posting/cost untouched,
  readonly trace, exact/concurrent retry, rollback, campaign/manual exclusion,
  source/unit/role/scope/CSV identity covered. Ранній batch fixture мав помилковий
  synthetic ID; виправлений лише його affected target.
- **5 unit cases PASS**, `/tmp/tsukenya-receipt-pricing-unit.log` та affected
  `-intent-unit.log`, `-context-unit.log`: cent precision, IDs/source/context/
  missing private fields, normalized preview intent, immutable ACK/ordered
  revisions, shared atomic conflict. Незмінні успіхи повторно не запускалися.
- **4 ReceiptPricing stories PASS** (FractionalCentAndKeyboard, ExactRecovery,
  UnitMismatchNeedsExplicitInput, BoundedStoreAndExplicitNetwork) та
  **1 shared Select native dialog story PASS**.
  Logs: `/tmp/tsukenya-receipt-pricing-{keyboard,unit-story}.log`,
  `/tmp/tsukenya-receipt-select-dialog.log`,
  `/tmp/tsukenya-receipt-pricing-context-story.log`; ExactRecovery PASS у
  `/tmp/tsukenya-receipt-pricing-stories.log` (інший початковий locator failure
  виправлено і повторено лише у keyboard target). Keyboard/pointer actual modal overlay covered.
- `tests/receipt-catalog-review-ui.cjs` **PASS**:
  `/tmp/tsukenya-receipt-pricing-native.log`,
  `$TMPDIR/tsukenya-receipt-review-proof/{report.json,review-1440.png,review-320.png}`.
  Actual multilot CSV → saved draft → posted receipt (catalogue untouched) →
  explicit cent source/manual proposal → lost ACK/late403 exact original despite
  invalid newer cost → GET historical result → real Studio only1 retail delta,
  excludes manual20/flatpromo11, explicit Add retains existing3 copies/24pt.
  Labels.prepare **0**, page errors **0**.
- `tests/receipt-catalog-recovery-ui.cjs` **PASS**:
  `/tmp/tsukenya-receipt-pricing-tail.log`,
  `$TMPDIR/tsukenya-receipt-tail-proof/{report.json,comparison-1440.png,comparison-320.png}`.
  Revision409, read503, unresolved same-field conflict, cancel, Apply-local only,
  unrelated fresh name retained, second409, current403/malformed, ignored abort
  late fulfill and close; two explicit rejected commits, no implicit replay.
- `tests/receipt-catalog-context-ui.cjs` **PASS**, affected bounded-choice only:
  `/tmp/tsukenya-receipt-pricing-context-native.log`,
  `$TMPDIR/tsukenya-receipt-context-proof/{report.json,context-320.png}`.
  Store pending503 preserves confirmed old context/draft12, successful store and
  network read require Apply, directory search/page purpose explicit, Escape
  focus returns, **0 writes/0 prepares**. Initial harness needed its debounce
  ready-page wait; only this target reran.
- TSC, final build, scoped ESLint, Prettier/diff checks, static browser-policy
  check PASS. Actual browser proofs use bundled Playwright Chromium headless
  and isolated SQLite; PNGs inspected at 1440/320, no horizontal overflow.
  This is no physical mobile, RAM/throughput/SLA, screen-reader or printer claim.
  No full suite, production data, Sheet, VPS, posting policy changes or deployment.


## Інтеграція з актуальним порталом

Інтегровано поверх accepted main `fc27569`. Збережено stock entry/dispatch,
entity recovery та всі наявні API generators. Незалежне рев’ю `827a110` PASS.
Повторено залежні перевірки: build/TypeScript, scoped lint,5 unit cases,
статичну browser policy, actual receipt→price review→Studio і store-context
сценарії на ізольованій SQLite у bundled headless Chromium. Desktop1440/mobile320
PNG переглянуто; горизонтального переповнення немає.

Перший context запуск зупинився на застарілому очікуванні пагінації для одного
результату. Fixture тепер очікує завершення loading та єдину опцію без footer;
повторено лише context target, успішно. Failure artifacts збережені.
Попередні незмінені13 PostgreSQL/5 Storybook/recovery докази використано повторно.
Повної регресії та production mutation-тестів не запускали.
