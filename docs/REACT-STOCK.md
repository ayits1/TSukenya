# React: складський облік

Перший торговельний React-модуль із STACK-EVOLUTION етапу 3 — фактичний
`#trade/stock`, а не демонстрація компонентів. Решта торговельних розділів,
редактор документа, проведення, поповнення закупівель і редактори рецептур
залишаються native. Міграція всієї CRM ще не завершена.

## Збережені можливості

| Можливість чинного Stock                 | Поточна реалізація                                                                                                                                                      |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Пошук товару, магазин і склад            | Server query; React Aria TextField / DirectoryComboBox, selected-ID captions                                                                                            |
| Товари за складами                       | Сторінка 30, quantity / available / reserved та одиниця                                                                                                                 |
| Весь фільтр                              | Вартість для дозволеної ролі, low / expiry counts; різні одиниці не складаються                                                                                         |
| Партії, строки придатності               | Lazy disclosure, окрема пагінація, frozen Kyiv asOf                                                                                                                     |
| CSV                                      | Повний фільтр із чинного streaming SQL/RR сервісу; cashier без вартості                                                                                                 |
| Асортимент складу                        | Окремий вибір складу, сторінки / пошук / selected-ID read                                                                                                               |
| Правила продажу та мінімуму              | Чинний POST, null успадковує каталог; 0 означає власний нуль                                                                                                            |
| Чернетки рядків                          | Ключ warehouse/product; пошук, сторінки, склади та route не стирають введення                                                                                           |
| Ревізія / конфлікт / невідомий результат | Frozen base; explicit GET і shared threeWay / ConflictComparison; Apply локальний, Save окремий                                                                         |
| Контроль операцій                        | Чинний native POST, результат і посилання на задачі; актуальний sanitized статус                                                                                        |
| Калькуляції та версії рецептур           | Чинні native редактори без зміни їхньої persistence/recovery                                                                                                            |
| Складський журнал і дії                  | Slim page30 для opening/transfer/writeoff/inventory/production; filters/status; native create/view/edit/save/post/reverse/delete; перехід у чинне поповнення закупівель |

## Контракти та інваріанти

- Окремий `contracts/trading-stock.openapi.json`, generated типи та strict runtime
  decoder. Catalogue/import contracts не змінені.
- GET `/api/v1/trading/stock`, `/stock/documents`, `/assortment`: current actor,
  одна READ ONLY RR транзакція для policy/count/page/summary; жодних нових
  posting/FEFO/reservation/COGS формул.
- `asOf` — саме frozen day SQL-запиту, включно на межі доби. Versioned endpoints
  відхиляють невідомі query keys; legacy URLs зберігають сумісність.
- POST assortment делегує чинному ledger-locked/revision-protected сервісу.
  ACK прив’язаний до warehouse/product і normalized sold/minimum, не є UUID
  receipt. GET після lost ACK показує **поточний стан**, а не авторство запису.
- Sold/minimum — консервативна атомарна група. Read не підмінює base/revision;
  невалідне нове введення не блокує GET. Зміна одиниці товару відмовляє
  автоматичному узгодженню. Cancel/late GET не змінюють новішу чернетку.
- Pending POST блокує перехід розділу через чинний `Trade.canLeave`; доступне
  нове введення зберігається. Unknown ACK забороняє blind повтор запису.
- Abort + generation + per-row request token. Чинні 401/403 прибирають приватний
  DOM, captions і CSV URLs; старий ignored-abort transport не може стерти новий
  успішний екран. Scope недоступної чернетки не показується.
- React mount/refresh повертає Promise після required reads; native saved
  refresh/detail recovery отримує failure, а не удаваний успіх. Voucher/payment
  internals не переписані.

## Цільові докази (isolated QA)

- `tests.test_react_stock`: PostgreSQL 4/4 PASS — authoritative parity,
  resource-bound ACK/revision, current-role/private CSV generator, slim journal
  без payload/children, real RR interleaving. SQLite midnight/unknown-key
  additive case PASS; початкова SQLite трійка PASS (PG case skipped).
- Unit: strict API 4 PASS; state 3 PASS + additive old401/pending POST/per-row
  finally fence 1 PASS. Read-only aggregate 13-digit money не зменшено до
  input ceiling; null і 0 різні.
- Stories: AtomicComparison і InvalidNewerRecovery PASS; WholeScreen keyboard
  pagination/lazy lots + axe PASS після keyboard access / unique table regions.
- Own frontend build/typecheck/affected ESLint PASS; native перевіряє саме
  assets цього clone, не позичений root build.
- `/tmp/tsukenya-react-stock-proof/report-primary.json`: page30/67,
  full-filter 670.00 / CSV67, keyboard pager focus, lazy lots, draft page/route.
- `report-recovery.json`: actual409, Apply без POST, separate Save;
  committed/lost ACK + invalid newer input + GET503/retry, current-state caption.
- `report-scope.json`: final ownbuild scoped manager pinned/locked store320; current cashier policy прибирає cost/edit/document DOM.
- `report-control-late.json`: actual control/result/tasklink PASS; late committed POST після route change не відкриває стару modal.
- `report-privacy.json`: actual captured ignored-abort old response/current403;
  private DOM/actions/CSV URL прибрано.
- `report-layout.json`, `stock-{1440,320}.png`, `draft-{1440,320}.png`,
  `stock-200pct.png`: no page overflow, 44px actions, readable actual controls.
- Native document callback run: real new/view/edit/save/post→readonly opening
  assertions виконані; server-callbacks.log містить PUT/POST/GET 200. Перший
  callback harness зупинився на застарілій назві recipe dialog. Повторено лише
  tail: `report-callbacks-tail.json` — обидва recipe editors, control/task link,
  replenishment→unsaved purchase-order rows PASS. Це не повтор financial suite.

Команда: `PYTHON_BIN=... QA_REACT_STOCK_FROM=primary|recovery|callbacks|callbacks-tail|privacy|layout|scope|control-late|comparison-policy node tests/react-stock-ui.cjs`.
`all` проходить основні primary/recovery/callbacks/layout/privacy стадії; `scope` і `control-late` — окремі спрямовані додаткові сценарії; partial flags потрібні лише для affected retry.
Перед spawn/hash scrubbed DB/PG/secret env, власний SQLite/DATA_DIR, awaited
SIGTERM/5sSIGKILL cleanup. QA port/proof directory можна задати окремо.

## Follow-up: comparison policy та ACK/read race

Окрема остання підтверджена policy відділена від render payload: очищення
таблиць під час refresh не означає відкликання прав. ACK перевіряє цю identity,
а не тимчасове `totals=null`. Fresh comparison GET з іншою role/store/capability
policy відмовляє до adoption; deny очищує server comparisons/private results,
але зберігає raw drafts. Apply після такого deny не змінює baseline чи введення.

Два вузькі unit regressions спершу FAIL на `90e63f6`, потім PASS:
comparison owner→manager/store1 + retained Apply fence; normal ACK під час
pending refresh + newer invalid input та справжній policy mismatch.
`report-comparison-policy.json` — лише affected native boundary: справжній
успішний scoped GET, private DOM/Apply/CSV clearing, raw draft після явного
повторного mount, без POST. Попередні PG/story/native сімейства не повторено.

## Межі

Немає повної регресії, production перевірки чи capacity benchmark. Browser QA —
ізольований Chrome / SQLite з 67 synthetic SKU; PostgreSQL доводить конкретні
read/policy/snapshot contracts. Мінімальні native callbacks зберігають чинні
фінансові guards; не повторено всі види проведення/скасування чи всі рецептурні
recovery сценарії. Пагінація обмежує page rows, а summary/CSV працюють по всьому
фільтру; SQL scan/time та downloaded CSV blob залежать від розміру фільтра.
Assortment service читає 30 карток Document.data на сторінку (історично велика
recipe в окремій картці не має нового hard cap). Поповнення закупівель лишається
чинним native сервісом із відомою окремою межею матеріалізації. Локальні
чернетки живуть у вкладці; persistence після reload не додано. Інші модулі CRM,
їхня React міграція, повна regression і deployment — окремі роботи.
