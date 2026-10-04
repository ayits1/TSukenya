# B24: вимірювання API і вузьке усунення N+1

## Метод і межі

Baseline: main `e0233c64b08ba0a36211dfdfc390dd6ff69a5c9c` (PR37). Python 3.14.7, Django 5.2.17, локальний PostgreSQL 18.6. Створено й видалено окрему `test_tsukenya_b24`; жодного доступу до VPS, production, backup чи спільної Sheet.

`Django Client` викликає справжні middleware, маршрути й serializers. Запити включають SQL авторизації, JSON-серіалізацію та перевірку публічних DTO касира. Послідовні заміри: warm-up + 5 samples. Паралельний probe: десять користувачів одного магазину × 5 одночасних хвиль GET у потоках одного Python-процесу. Дані: 500 SKU, 50 manual operational tasks, 10 відкритих кас, 50 чинних акційних позицій; історія — 5000 продажів, одне надходження, 5500 рядків і складських рухів, 5000 грошових рухів. Це синтетичний ORM seed для read API, а не benchmark проведення/валидації бізнес-документів.

Це **не вимір місткості робочого сервера**: немає мережі, браузера, Caddy або двох Gunicorn workers × чотирьох threads з `server/start.sh`. SQL timings включають локальне очікування процесу/потоків. P95 із п’яти samples приблизний; абсолютні мілісекунди не є SLA. `deploy/attach_gateway.py` вмикає zstd/gzip, тому raw JSON bytes не дорівнюють реальному мережевому трафіку.

Сирі результати: [b24-baseline.json](b24-baseline.json), [b24-paid-history.json](b24-paid-history.json), [b24-batched-history.json](b24-batched-history.json). Останні два використовують однаковий seed повністю оплачених історичних продажів; тільки змінений voucher-list повторено після патча. Кожний файл має hash виміряних `views.py` / `reporting.py`: git baseline сам по собі не означає відсутності робочого патча.

## Що виміряно

Медіана, послідовний HTTP-handler із SQL instrumentation:

| Endpoint / дані | SQL | Raw bytes | Медіана, ms |
| --- | ---: | ---: | ---: |
| `/api/state`, 50 SKU | 8 | 48 410 | 9.50 |
| `/api/state`, 500 SKU | 8 | 311 480 | 21.99 |
| `/api/state`, 500 SKU + історія 5000 sales | 8 | 311 480 | 20.65 |
| `/api/v1/catalog/products?limit=20`, 500 SKU + історія | 9 | 25 808 | 6.56 |
| Такий самий список, `promotion=yes` | 10 | 29 228 | 14.01 |
| `/api/v1/labels/workspace` | 2 | 268 | 1.12 |
| `/api/erp/state`, 500 SKU + історія | 12 | 6 138 | 5.38 |
| `/api/erp/stock`, 500 SKU + історія | 6 | 278 414 | 16.05 |
| Voucher page30, paid history, **до** | 63 | 12 684 | 53.79 |
| Voucher page30, paid history, **після** | 5 | 12 684 | 10.24 |

Паралельний full state poll: 50 GET, 8 SQL кожний, median 118.41 ms, P95 181.73 ms. Відповідь завжди 311 480 raw bytes. За незмінної відповіді десять кас кожні 5 s генерують 622 960 raw bytes/s, приблизно 2.24 GB raw JSON/h. Це розрахунок повторно сформованого JSON, а не замір wire bytes чи прогноз production capacity.

Історичні voucher rows не збільшили full state у цьому dataset: Document і Voucher — різні таблиці. Натомість збільшення SKU 50→500 збільшило raw state приблизно у 6.43 раза. Пагінація каталогу вже обмежує список до 10/20/50; React сам не є джерелом full catalogue poll.

## Виправлено найбільше виміряне SQL-вузьке місце

`views.handle` для `GET /api/erp/vouchers` уже має сторінку 30, але `reporting.voucher_json` викликав `obligation(v)` для кожного проведеного sale/receipt/debt_opening. У `services.obligation` відсутні пакетні inputs означають окреме читання direct settlements і allocations. Результат: базові три SQL + 30×2 = 63, навіть якщо продаж повністю оплачений.

Тепер саме **сторінка** передається через наявний `browsing.with_settlements` / `settlements.prefetched_sources`, а `voucher_json` отримує їхні готові списки. Інші виклики serializer продовжують працювати з необов’язковими аргументами `None`. `obligation`, `net_total`, `allocated_amount`, legacy single-reference payment fallback, дата/сторно, posting, locks і permissions не змінено. DTO/pagination/redaction однакові.

Результат у paid-history fixture: SQL 63→5 (−92.1%), median 53.79→10.24 ms (−81.0% в локальному замірі), raw response незмінні 12 684 bytes. Не екстраполювати ці відсотки на всі endpoints або робоче навантаження.

`tests/test_voucher_list_batch.py`, PostgreSQL: 5 PASS. Один/30/останній рядок сторінки мають ≤5 SQL; DTO звірено з окремим authoritative serializer. Перевірено paid/partial receipt, embedded paid/partial sale, unused advance (не оплачує борг), explicit allocation, legacy single-reference payment без backfill і opening debt, supplier return, скасування повернення/розподілу/платежу/source, scope касира й приховування cost/payroll. Новий network/polling контракт цими тестами не оголошується реалізованим.

## Наступний additive polling fix — лише план

### Доведений поточний контракт

- `server/runtime.js: refresh` отримує весь `/api/state`, двічі JSON.stringify для порівняння; interval 5000 ms активний лише для видимої вкладки й без паралельного поточного GET.
- Якщо snapshot не змінився, `tsukenya:data-changed` **не** надсилається: React каталог не перевантажується автоматично кожні 5 секунд. Але серверний full GET, читання JSON і порівняння повторюються.
- Коли змінюється будь-який snapshot, Catalog/Studio broad listener інвалідує каталожні queries, навіть якщо змінилася лише задача. ERP `load` додатково отримує повний legacy state.
- Поточні HMAC `catalog.revision` і `labels.revision` — optimistic concurrency/content versions. Вони не є cheap collection cursor. `Document` не має updated_at; `max(id)`/`max(voucher.id)`/audit.pk не виявляють редагування чи видалення каталогу, а глобальний audit token розкривав би приватну активність.
- `legacy_state` читає `Document.objects.all()`, включно зі службовими import/pricing run documents, які не повертає. Час росту цих службових documents не вимірювався, тож це code-confirmed follow-up, а не доведене головне вузьке місце.

### Послідовність

1. **Cheap conditional GET на чинному endpoint.** Додати opaque role/store-scoped state token і `If-None-Match` / 304. Перший GET і явний refresh після підтвердженого Save зберігають повний чинний DTO. 304 обробляється до `response.ok` / JSON decoder; зберігає кеш, не породжує data-changed, завершує refresh state. Ніколи не повторювати POST через збій read.
2. **Durable invalidation.** Окремий transactional read-version register: catalogue/pricing/references/labels/public settings/операційні tasks, магазин і фінансовий scope там, де потрібні. Mutation increments у тій самій транзакції, що й реальна зміна; rollback не змінює token. Спершу скласти повний перелік шляхів: legacy CRUD, catalog/save/delete, import і pricing commit, reference merge/archive, label save, campaign save/archive, alert lifecycle/price-review generation, ERP store identity, bootstrap/admin/import commands. Bulk writes повинні бути охоплені явно; сигнал post_save сам цього не гарантує. Облікові проведення і межі LedgerLock не змінювати.
3. **Identity й календар.** Token включає поточні role/store/price context та Kyiv effective day: акція може початись/закінчитись опівночі без запису в БД. Назва/активність магазину й label identity — окремі залежності. Ротація CSRF/сеансу або зміна role/store має повернути свіжий DTO, а не старий 304. Token HMAC, без raw IDs/sequence приватних фінансових подій. Auth завжди до порівняння токена.
4. **Race consistency.** Не присвоювати новий token старому payload. Читати token до й після формування повного DTO або використовувати узгоджений read snapshot; при зміні версії не оголошувати відповідь як нову незмінну. Не робити GET записом. 304 дозволено лише коли caller має повний snapshot тієї самої identity; scope/role зміна скидає клієнтський стан.
5. **Domain notifications.** Після сумісного conditional GET можна additive передавати domains у data-changed. Catalog/Studio ігнорують лише явно нерелевантні domains; старий event без domains означає full invalidation. Legacy controls лишаються сумісними.
6. **Cursor delta — пізніше.** Тільки після cheap unchanged path додати bounded sequence/tombstones для update/delete, scope-bound signed cursor, retention/reset/full fallback. Відсутній ID не означає видалення. Cursor старого scope не дозволяє читати або видаляти інший store snapshot. Нинішня карта всіх товарів для POS поки зберігається: проста підміна її однією сторінкою зламає barcode/search.

### Критерії приймання наступного патча

- Unchanged warmed poll: ≤4 SQL, raw body ≤1 KiB або порожній 304, без full product/promotion scan і без зміни кешу/чернетки; це **ціль**, ще не виміряний результат.
- Create/edit/delete/merge/pricing/campaign/label/alert із другої сесії стають видимими до наступного interval; failure/rollback не дає неправдивого successful update.
- Kyiv midnight campaign transition працює без mutation; scoped cashier/manager/owner не отримує cost/private settings/чужі tasks або фінансові change tokens.
- 304/malformed/401/role/store reassignment і confirmed Save + failed GET зберігають runtime recovery rules; explicit GET retry не повторює write.
- Виміряти тільки змінені endpoints на тому самому seed; наступний мережевий benchmark із Caddy/Gunicorn/браузером потрібний окремо, якщо вирішуємо capacity/SLA.

На цьому етапі немає доказу потреби переписувати React/DRF, міняти межі глобальної бухгалтерської блокади або вводити окремі сервіси.

Root після інтеграції B12/B16/B02/B20/B19 перевірив два PG сценарії: одна/30/остання позиція≤5 SQL з незмінним DTO і магазин/приховані cost/payroll для касира — PASS. Решту незмінених цільових бізнес-сценаріїв використано з агентного доказу. Django discovery включає test_voucher_list_batch у server/postgres CI та серверний етап явної test:full; окремий benchmark до CI/full не додано. Показники вище залишаються початковим baseline PR37, не новим виміром усього main після наступних пакетів.
