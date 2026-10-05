# Похідний complete result cache звітів · B24

База: accepted `78c24e7`. Це приватна похідна проєкція поточних авторитетних
Django/PostgreSQL даних, а не збережений незмінний бухгалтерський знімок.
Формули `period`, `balances`, `report_children`, хронологія бонусів і ABC лишаються
спільними. Нових моделей/міграцій і правил проведення немає.

## Джерела й ключ

| Образ | Frozen 0029 ресурси | Приватні залежності |
| --- | --- | --- |
| period | reports_period | reports_salary тільки owner/accountant: late-return bonus/WorkShift/payroll chronology |
| balances | reports_balances | reports_salary тільки owner/accountant: зарплатні борги й чинні employee captions |
| ABC | reports_abc | поточний hidden товару, проведені рядки/сторно, store captions |

0029 охоплює direct/bulk/rollback, old/new store audience, target cash/stock
transfer, allocation source/payment/settlement та reverse Employee→історичні
CashShift/payroll/WorkShift магазини. Manager не вибирає salary counters; cashier
не має доступу до звітів. Frozen 0024/0029 не змінюються.
`require_reversal_dates` додатково виконується перед КОЖНИМ hit: historical reversed
без дати має відмовити навіть для nonfinancial kind без stamped movements.

HMAC ключ приватний: schema/code hash, DB namespace, fresh actor PK/role/profile
store, requested/effective store scope, нормалізовані accounting dates та ABC
thresholds, current Kyiv day, дозволені scoped counters з явними zero keys.
PG xmin — додатковий discriminator, не абсолютна ідентичність після restore чи
wraparound. TTL обмежує життєвий цикл; після DB restore потрібно видалити саме
цей приватний cache namespace перед його повторним використанням.
Page/q/section/ABC class — читання повного образу, не частини ключа. Mutation,
pricing guards і permission grants не користуються цим кешем.

## Читання й публікація

Кожний summary/page/CSV входить у READ ONLY REPEATABLE READ, повторно читає actor
і scope, перевіряє integrity та counter key; cold build і ключ одного RR. Hit не
сканує voucher lines, cash/stock movements чи payload children. SQL counter+guard
reads залишаються. SQLite працює без persistent cache (той самий oracle), бо її
outer test transactions/flush не є гарантією durable counter identity.

Образ містить усі доступні цьому actor рядки й summary. Частковий build ніколи
не hit. 0700 namespace, 0600 файли, O_NOFOLLOW і inode check; payload/credentials
не потрапляють у назву ключа чи public token. Один constant publication lock
між процесами; читачі мають shared file lease. Закритий/fsync build атомарно
rename на тому самому filesystem без другої копії. Eviction не видаляє активний
reader/build. Failed/cancelled build прибирається; generator close звільняє RR
і file lease. TTL expiry не повертає stale image.

## Технічні межі (не SLA)

Complete image ≤128 MiB; namespace published+reserved build ≤512 MiB, ≤32
published files, TTL 300 s, lock wait ≤2 s. Worst image reservation BEFORE build;
active readers, що заважають резервуванню, дають retryable 503. SQLite journal
вимкнений для disposable derived build; ordering indices створюються до вставки,
не застосовується SQLite REAL для грошей. SQLite page limit охоплює таблиці та
індекси; query plan перевіряє відсутність external sort scratch.
Cold/read action deadline 120 s, PostgreSQL statement timeout 30 s (або вже
встановлений коротший timeout — він не послаблюється). Deadline кооперативний:
перевіряється на рядках/SQLite progress/publish; не може перервати OS fsync чи
простій мережі всередині syscall. PG statement timeout є серверним. CSV повертає
ВСІ рядки обраного фільтра з одного COMPLETE image; timeout після початку stream
обриває CSV, не підміняє його успішним partial result. Клієнт має повторити export.
O(source rows) cold build і O(image rows) full filter/export лишаються; немає
100k latency/cursor/cache/capacity completion claim. Cache не scheduler/service.

## Налаштування й межа відмови

Це операційні safety budgets, а не бізнес-правила чи прогноз швидкодії: 128 MiB
обмежує одну похідну проєкцію, 512 MiB/32 files залишає місце кільком активним
контекстам із резервом cold build, 300 s обмежує retention. `REPORT_RESULT_CACHE_*`
IMAGE_BYTES/TOTAL_BYTES/FILES/TTL/LOCK_SECONDS/ACTION_SECONDS/STATEMENT_SECONDS
можна налаштувати тільки вниз від цих caps; bytes/files — цілі числа.
`REPORT_RESULT_CACHE_DIR` задає private scratch base; ENABLED=False вимикає
persistent cache зі збереженням oracle. Значення мають бути однаковими у web
workers. Перед зменшенням budgets або зміною secret/DB restore — звільнити readers
і очистити цей derived namespace; невідомі/чужі temp directories не очищуються.
512 MiB — per DB namespace, не гарантія сумарного диска всіх тестових DB/старих
secret namespaces на хості. SQL cache2MiB і fetch100/ORM200 лишаються bounded
buffers; cache не додає full payload materialization.

`generated_at`/`generatedAt` — час побудови COMPLETE image. При unchanged hit
результат перевірений у свіжому RR, але цей час не переписується. Поля/grants із
current/debt detail не кешуються як дозвіл. Malformed local image дає 503 без
stale/partial fallback; він НЕ переписується до TTL expiry (або явного purge).
Після expiry незалочений образ можна видалити/побудувати знову. При client abort
до першого byte WSGI може не повідомити Python: обмежена cold build може
завершитись і опублікувати COMPLETE derived image; бізнес-записів немає. Generator
close після першого byte реально закриває RR/file lease. Scheduler не додано.

## Докази

Цільова межа: PG miss/hit no-source-scan, period/balances/ABC oracle/page/full
filtered CSV parity; actor/store/revocation, direct/bulk/rollback invalidation,
manager salary token independence; RR concurrent writer/publish, cancellation,
quota reservation/active lease, exact Decimal order й cleanup. Старі незмінені
accounting/date/late-return oracles повторно не запускаються без concrete gap.


Фактичні incremental proofs (не full regression):

- 4 file tests terminal PASS: exact `.98/.99` Decimal order, literal search,
  0600/shared lease, reservation BEFORE build/active-reader refusal, 64KiB peak,
  failed/cancelled build без partial, deadline/TTL; corrupt-image refusal+expiry
  відпрацьовано окремим affected terminal PASS.
- Actual PG endpoint65 test terminal PASS: period/balances/ABC owner oracle;
  page2, search64 matching rows, FULL filtered CSV64 і exact Decimal sums; hit
  `period/balances/populate` mocked to raise on any source rebuild, no DECLARE
  source cursor; SQL plans усіх period/balance секцій та ABC/groups без TEMP B-TREE.
- PG worker2 terminal PASS: два незалежні connection publishers — один build,
  тотожний complete результат; streaming close відпускає lease/RR; окремий Python
  process із тим самим configured secret+DB namespace читає той самий HMAC image
  із source builder забороненим. Secret не логувався.
- PG timeout/capacity1 terminal PASS: HTTP503 + Retry-After, no partial image,
  реальний pg_sleep з server statement timeout, наступний GET200, caller-owned
  RR shorter timeout5ms збережено.
- Commit/bulk/rollback/caption/manager-private-salary/actor-revocation та RR writer
  targets PASSED у incremental PG5 command (4 PASS, 1 тодішній timeout failure);
  залишились незмінними, reuse. Timeout closing command вище виправив actual
  failure. Початковий PG4 мав assertions OK, але exit1 на teardown через threaded
  connections; НЕ terminal PASS. Explicit connections.close_all та worker2
  closing proof завершили teardown. Нового full/100k/browser/production не було.
- Початкові affected legacy Decimal-order/ABC-tie SQLite targets PASS (reuse);
  py_compile/diff-check/makemigrations --check --dry-run PASS, нової schema немає.

Локальні synthetic proof logs/own-source hash manifest:
`/tmp/tsukenya-report-cache-proof/manifest.json`. Public doc не містить business
exports чи credentials. Packet1 freshness/contracts, cursors/tombstones/100k
capacity та повний B24 залишаються окремими відкритими межами.
