# B24: обмежене читання взаєморозрахунків

Пакет від прийнятого `2adc49f`. Проводки, reconciliation, allocation,
advance/refund, reversal і pure historical calculators не змінено.

## Фактичні споживачі та контракт

| Читання | Чинний UI | Межа |
| --- | --- | --- |
| `/api/erp/references` | вибір джерела документа/розподілу платежу | 30 заголовків; повний eligible count; той самий порядок, purpose, дата, role/store |
| `/api/erp/vouchers` | журнали й native document browser | 30 заголовків; posted outstanding без child prefetch або payload |
| `/api/erp/debts` | фінанси | 30 боргів; точні повні filtered totals, due/date/search/status без змін |
| `/api/erp/advances` | аванси, вибір платежу | 30 рядків; точні повні customer/supplier totals |
| `/api/erp/debts/summary` | огляд, картка боргів | 5 найближчих оплат, `payments_count` усіх оплат та їхній точний `payments_total`; повний перелік доступний через чинний перехід «Фінанси» |
| `/api/v1/trading/settlements/statement` | `TradePayments.showStatement` | 30 операцій, повні opening/closing/debit/credit/debt/advance/age/reconciliation |

Новий statement описано в `contracts/settlement-reads.openapi.json`; native
споживач застосовує `SettlementReads.decodeStatement` до відображення.
Декодер перевіряє resource/query, поточний role/store, page/count/unique IDs,
дати та точні decimal strings. Summary теж декодується перед показом картки.
Відсутні невикористані повні `debts`, `advances` та вкладені `allocations` масиви.
Чинні дії відкриття платіжного документа й його detail не вилучені.

Параметри statement: `party`, необов'язкові `store/from/to/page`; невідомі
параметри відхиляються. Query echo містить нормалізовані `party/store/from/to`,
policy — поточні `role/store`. Старий `/api/erp/party-statement` повертає явний
410 з replacement після переключення активного consumer. Pure
`party_finance.statement_data`, `financial_browsing.current_debts`,
`legacy_debt_summary`, `legacy_advances` і `legacy_references` залишені oracle.

Кожне читання має власний **поточний** PostgreSQL READ ONLY REPEATABLE READ.
Актор перечитується всередині нього; scope перетинається з фільтром.
Після нового проведення наступна сторінка може відрізнятися. Це не persisted
snapshot і не незмінна пагінація між запитами. Вкладена PostgreSQL транзакція
дозволена лише якщо вона вже RR/serializable та READ ONLY; production guard
не вимкнено заради тестів.

## Формули й матеріалізація

Report-only `report_children.obligations/advances/json_children` повторно
використовуються для того самого decomposition, multiplicity, final money
rounding, cutoff `None`, Kyiv reversal dates та suppression legacy mapped
payments. Від'ємний історичний борг залишається від'ємним, без clamp.
Statement зберігає signed customer/supplier effect та independently signed
reversal, running saldo, age і net_documents_and_advances. Неправильний
історичний JSON/decimal відхиляється, а не перетворюється на нуль.
Відсутня/порожня дата, null, false, zero та порожні `[]/{}` зберігають стару
truthiness; непорожній nested deadline не матеріалізується як scalar.

- Заголовки та scalar children читаються пакетами 200 без ORM result cache,
  child prefetch чи повного `Voucher.payload`.
- Accumulators належать поточному пакету 200 IDs. Спожиті списки заголовків
  очищуються перед наступним пакетом та наступною фазою обчислення.
- Повний порядок/проміжні рядки — на приватному тимчасовому SQLite spool
  (directory 0700, file 0600, cache 2MiB, без REAL для грошей). Running saldo
  обходить disk cursor по 100; JSON page містить до 30 рядків, summary — до 5.
- Context managers закривають read transaction/cursors/spool; виняток прибирає
  тимчасовий каталог. Немає нових persisted записів, scheduler або міграції.

Це **O(N) source/child scans та диск O(N)**, не capacity/SLA доказ. Кожна
сторінка заново обчислює current aggregates. База може парсити/сортувати
збережений JSON; її buffers/work_mem/temp disk тут не обмежено. Кількість
доступних store IDs для reversal guard і довжина одного scalar/caption не
мають нової byte-limit гарантії. Runtime query count зростає за кількістю
пакетів, а не кожного окремого source/child. Fixed fixture бюджети 15 для
references/debts/list та 10 для advances включають fresh authentication,
BEGIN/SET/COMMIT і scalar validation queries; старі 5/6 prefetch queries не
доводили bounded materialization.

## Цільові докази

`tests/test_settlement_reads.py`: ізольовані SQLite і PostgreSQL18 на
`test_tsukenya_settlement_reads`, без production підключення.

- Паритет refs/debts/advances/summary з незміненими oracle, 65 джерел,
  legacy direct та mapped allocations/refunds; statement cutoff/reversal/
  running saldo/page/age — PASS.
- Fresh cached owner→scoped manager/cashier, foreign filter, inactive actor,
  без read writes — PASS.
- PostgreSQL interleaving: новий payment між aggregate та page не змішує
  snapshot; наступний request бачить новий outstanding — PASS.
- HTTP versioned statement + старий410 — PASS після виправлення route
  placement перед загальним `/api/v1/` dispatcher. Initial405 збережено у
  звіті; повторено лише цей уражений сценарій.
- 501 embedded JSON payments + 501 allocation children, 502 statement events:
  page30; trap на whole payload та PaymentAllocation model materialization,
  старі context/prefetch; WeakSet live Voucher objects і cursor fetchmany —
  PASS. SQLite: 203 live headers, cursor 200, 2006 streamed JSON rows;
  PostgreSQL: 203/200/2004. Артефакти
  `/tmp/tsukenya-settlement-read-proof/{sqlite,postgresql}-fanout.json`.
  Початковий probe виявив утримання попередніх header batches (502); після
  очищення списків повторено лише fanout-сценарій.
- False deadline/container parity, negative historical debt, malformed
  precision/root/child refusal, spool cleanup та inherited RR guard — PASS.
- Matching affected legacy tests: SQLite 6; PostgreSQL 10 — PASS. TestCase
  класам, що реально читають нові RR routes, повернуто TransactionTestCase
  setup; зміст їхніх money/scope/DTO assertions збережено. Один invocation
  мав неправильну назву actor test (loader AttributeError); три інші case
  пройшли, правильний actor case повторено окремо — PASS.
- `node tests/settlement-reads.cjs` — PASS: decimal strings/large aggregate,
  malformed fields/page/duplicates, stale query, policy/scope та source
  wiring actual native consumers. Native/Node syntax і `git diff --check`
  — PASS.

Успішні незмінені inputs повторно не запускалися. Нові backend cases:
PostgreSQL 10 PASS; SQLite 9 PASS + 1 PostgreSQL-only skip, сукупно цільовими
запусками. Runtime current reads sourceguard/metrics не є browser або VPS
load proof. Payments/debt-summary старі browser fixtures адаптовано лише до
нового URL і погодженої 5/count8 картки; браузер тут **не запускався**.

## Явний залишок

Старий pure/default report і detail інших модулів не оголошено bounded цим
пакетом. CSV звітів використовує попередній bounded report path і не змінений.
Trading change-domain polling/ETag і зовнішня актуалізація вже відкритих native
екранів лишаються наступним B24 пакетом. Усієї React CRM, durable cache,
posting capacity, production deployment або 0.1 цей пакет не закриває.

## Інтеграція в актуальну гілку

Базу оновлено до прийнятого `8fcf7b33546033d6212bb33162cb6766e338d469`;
перенесено лише reviewed `dac98e817484455f9783994f8d5b7da41eec7f9b`.
Конфлікти script loader/static allowlist вирішено адитивно: збережені актуальні
planning-category persistence, recovery та purchases routes; доданий settlement
script і versioned GET перед загальним `/api/v1/` dispatcher.

`tests/settlement-reads.cjs` включено до Node етапу server quick CI та explicit
full runner. Node decoder, JS/Python syntax, dispatcher/static anchors,
`git diff --check` і own frontend build PASS. Full runner виконано лише з
`--plan`: жодного повного прогону.

Один фактичний native transport сценарій
`PYTHON_BIN=... node tests/payments-ui.cjs --failure-only` PASS на ізольованій
SQLite/DATA_DIR і bundled headless Chromium: відкриття звірки через новий GET,
відображення декодованого результату, видалення старого результату після 503
та повторне читання; аналогічне очищення/відновлення списку авансів.
Лог `/tmp/tsukenya-settlement-integration-native-final.log`.

Перший запуск виявив застарілий `selectOption` у browser helper: native select
тепер прихований під React ComboBox. Helper переведено на public пошук/вибір
опції та перевірку committed ID. Проміжний Enter без фокусу на ComboBox також
не підтверджував ID; diagnostic response list був порожній — statement GET
ще не виконувався. Після виправлення лише helper повторено той самий вузький
сценарій; виробничий код через ці перевірки не змінювався. Додано артефакти
помилки DOM/response та відключено зовнішні fonts у helper.

Попередні PG/SQLite/oracle/fanout докази перевикористано: їхні входи не змінені.
Картку summary окремо в браузері цього разу не проганяли. Precision великої
суми у старому Number formatter залишається окремим підпакетом. Немає push,
PR, VPS deployment або запуску системного Chrome.

### Accepted monthly base integration

Перебазовано на прийнятий PR106. Loader/static конфлікти вирішено додаванням
settlement script зі збереженням monthly/category/recipe/work-shift recovery
та закупівель. Python/Node syntax, diff і settlement contract fixture PASS.
Frontend та його build inputs не змінені цим пакетом; matching accepted
monthly build використовується повторно. Native transport доказ вище та
PG/fanout/source review proofs мають незмінні settlement inputs.
Повну регресію та розгортання цього пакета не виконано.
