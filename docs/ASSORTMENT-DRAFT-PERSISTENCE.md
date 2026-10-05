# B06: відновлення асортименту товару на складі

База: accepted `b3909cd`. Ціла family — actual ReactStock, перше створення та
редагування пари warehouse/product, кілька одночасних/off-page чернеток. Це не
завершення решти B06. Same-tab/same-session P0; без нової міграції.

## Погоджений протокол

- `GET /api/v1/trading/assortment/recovery-context?warehouse=…&product=…`
  і `/current` — fresh actor усередині READ ONLY REPEATABLE READ; exact selection,
  роль/store, scalar product caption/unit/default minimum та поточний рядок.
  Невідомі historical product поля не передаються до Python/клієнта.
- `POST …/identity {request: original}` — READ ONLY, без ledger/DML. Відсутність
  квитанції не доводить rollback. Current warehouse grant перевіряється до receipt.
- `POST …/execute original`, де original має exact поля
  `{key,warehouse,product,revision,unit,terms:{sold,min_stock}}`.
  Revision nullable для відсутньої пари; min_stock null означає успадкування,
  "0" означає явний нуль; unit — спостережена одиниця, без конвертації кількості.
- Ledger → fresh actor/current warehouse scope → creator+exact hash receipt →
  mutable row/product/unit/revision validation. Protected Document prefix
  `assortment_action_receipts/<UUID>` не входить у generic legacy collections.
  Existing Decimal .001, audit і sold/min_stock формули залишаються авторитетними.
- Bound write_rejected можливий лише для першої живої rolled-back400 або
  revision409. Auth, collision, outer commit/on_commit/serialization failures
  не є rollback proof. Пізніший4xx після unknown не змінює immutable intent.

## Реальний P0 consumer

Raw sold/minimum string записується синхронно на edit до await. Окремий запис на
пару; explicit Restore/Discard, existing/unreadable record не перезаписується.
ProductDTO, stock/cost rows, grant/CSRF не зберігаються. Quota блокує write без
eviction. Frozen exact body з новим UUID зберігається до fetch; новіший invalid raw
допустимий одночасно. ACK/positive identity durable перед незалежним current GET.
Apply sold+minimum атомарний, один local persist; окремий Save створює новий UUID.
Unresolved intent забороняє Apply. Unit change забороняє автоматичне переприв'язування.

## Перевірки

Backend: 4 нові SQLite цілі + 2 зачеплені legacy checks; перший run знайшов
помилкову довжину revision у новому decoder (64 замість чинних32). Після виправлення
тільки дві зачеплені цілі PASS (`/tmp/tsukenya-assortment-recovery-sqlite-tail.log`),
інші4 докази використано повторно. Первинний red log збережено.

PostgreSQL18: 5 нових цілей PASS, exact concurrency та реальний READ ONLY RR,
creator/collision/scope, postcommit callback без false rollback proof. Через
імпорт fixture class unittest також запустив13 чинних AssortmentTests: разом18
PASS3.739s (`/tmp/tsukenya-assortment-recovery-pg.log`). Fixture import змінено на
module alias, щоб надалі не повторювати ті13 автоматично. Власна локальна база
127.0.0.1:61144, env scrub; без production. Frontend/actual consumer докази ще pending.
Повний набір і системний Chrome не використовуються.
