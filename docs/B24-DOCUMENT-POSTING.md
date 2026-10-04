# B24: деталі документів і очікування проведення

## Метод та відтворення

Облікова база коду: `be48a4a`. Python 3.14.7, Django 5.2.17, PostgreSQL 18.6 на локальному `127.0.0.1:61144`. Скрипт [benchmark_voucher_posting.py](../scripts/benchmark_voucher_posting.py) створює випадкову власну `qa_tsukenya_b24_document_<uuid>` через Django test runner і видаляє її після виконання. Приймає лише opt-in і фіксовані локальні connection settings; production, VPS, Sheet і попередні QA-бази не використовуються. Пароль і ключ Django передати через середовище локальної QA, не зберігати у звіті.

```sh
DB_HOST=127.0.0.1 DB_PORT=61144 DB_NAME=tsukenya_b24_document_detail \
DB_USER=postgres python scripts/benchmark_voucher_posting.py \
  --run-local-pg --output /tmp/b24-documents.json
# Після serializer-only правки повторювати тільки detail:
DB_HOST=127.0.0.1 DB_PORT=61144 DB_NAME=tsukenya_b24_document_detail \
DB_USER=postgres python scripts/benchmark_voucher_posting.py \
  --run-local-pg --detail-only --output /tmp/b24-document-details.json
```

Справжній `Django Client` проходить HTTP routing/middleware/session/role/store guards. Seed надходжень і продажів також виконується HTTP create/post, а не штучним додаванням проведених фінансових фактів. Сто SKU; деталі надходження/продажу на 1/30/100 рядків, власник та касир. Кожний detail: warm-up + п'ять незмінних читань. SQL counter включає auth і DTO. Окремі п'ять хвиль для 1/5/10 власників одного магазину, власна унікальна UUID на кожний документ: create → post → exact create retry → exact post retry; 30 рядків на надходження.

Це **локальний синтетичний probe одного Python-процесу**, не capacity/SLA production: немає Gunicorn, браузера, Caddy, реального мережевого RTT чи виробничих даних. П'ять samples для кожного послідовного випадку дають приблизний P95, а не статистично надійний перцентиль. Потоки й SQL trace впливають на абсолютний час. Вікно PostgreSQL узгоджено з іншими агентами; їхні PG-перевірки завершено до baseline. Після правки повторено лише detail та один змінений HTTP retry scenario; незмінні конкурентні хвилі не повторювались. Цільовий retry test почався вже після створення after-artifact.

## Сирі артефакти

- [b24-document-baseline.json](b24-document-baseline.json): git head `f3136ad`, hash кожного `server/**/*.py` та harness, усі request rows, SQL таблиці/кількість/час, DTO hashes, request lock sample counts/spans.
- [b24-document-batched.json](b24-document-batched.json): git head `f6689d0` **з робочим serializer patch**; фактичні source hashes записані у файл. Hash `services.py` однаковий до/після. `concurrency=[]` означає свідоме повторне використання незмінного попереднього posting proof.

Baseline JSON після вимірювання спроєктовано у компактний формат: порожні `pg_stat_activity` polls замінено їх кількістю й сумарним/медіанним SQL часом. Кожний poll зі справжнім server `Lock` залишено як `[at_ms,sql_ms,waiting]`; формат задано в `waiting_samples_format`. Request rows не вилучалися, заміри не повторювалися. Harness надалі одразу виводить цей самий формат. Тому baseline hash harness описує саме версію, яка виконала замір, а не пізніше форматування артефакту. Секретів, SQL params чи реальних товарів у звітах немає.

## Деталі до/після

Медіана HTTP handler, ms; однакові синтетичні товари/кількість, але незалежні UUID/час створення документа. Повні DTO до/після додатково звірено у тестах зі збереженим незалежним попереднім serializer на **тій самій** fixture; raw DTO hash між двома окремими runs не є доказом рівності через часові поля й UUID.

| Документ / роль | Рядків | SQL до → після | Медіана до → після, ms |
| --- | ---: | ---: | ---: |
| Надходження / власник | 1 | 13 → 10 | 9.42 → 6.81 |
| Надходження / власник | 30 | 129 → 10 | 114.65 → 11.85 |
| Надходження / власник | 100 | 409 → 10 | 493.41 → 16.95 |
| Продаж / власник | 1 | 12 → 10 | 10.39 → 7.00 |
| Продаж / власник | 30 | 99 → 10 | 92.86 → 12.08 |
| Продаж / власник | 100 | 309 → 10 | 381.72 → 16.25 |
| Продаж / касир | 1 | 12 → 10 | 9.37 → 5.79 |
| Продаж / касир | 30 | 99 → 10 | 65.76 → 12.14 |
| Продаж / касир | 100 | 309 → 10 | 344.39 → 15.59 |

Виявлено 3 SQL на рядок продажу та 4 на рядок надходження: повторне `v.lines.get()`, дві окремі суми quantity/amount пов'язаних рядків; надходження додатково `receipt_source`. Тепер тільки рядки **цього документа** завантажуються один раз; один grouped aggregate за їх ID рахує quantity+amount проведених наступних документів, а завантажені рухи з lot повторно використовуються для DTO й визначення походження. Не читається весь каталог/журнал; розмір відповіді все ще відповідає кількості рядків документа, пагінацію самих рядків цей патч не вводить.

B11 lineage збережено: рівно один positive non-reversal annotated movement; legacy fallback — рівно один рядок цього SKU і один unannotated movement. Декілька кандидатів означають `origin_known=false`. Негативні та reversal movements не є origin. Posting `receipt_source(strict=True)` не змінено; Decimal/JSON string контракти, поля/порядок DTO та cashier redaction збережено. Orders мають власні додаткові читання — для них не заявляємо 10 SQL.

## Create/post/exact retry baseline

Медіана ms; `ledger SQL` — тривалість `SELECT erp_ledgerlock FOR UPDATE` у драйвері. `service` — обгортка оригінального save/post у views, `handler` включає HTTP guards і serializer **після** сервісу.

| Виконавців | Дія | SQL | Handler | Service | Ledger SQL |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1 | Create | 198 | 178.45 | 78.33 | 0.86 |
| 1 | Post | 353 | 323.23 | 176.79 | 0.85 |
| 1 | Exact create retry | 132 | 155.22 | 5.89 | 0.87 |
| 1 | Exact post retry | 133 | 144.70 | 4.95 | 0.60 |
| 5 | Create | 198 | 330.08 | 252.33 | 134.98 |
| 5 | Post | 353 | 829.92 | 706.30 | 483.34 |
| 5 | Exact create retry | 132 | 463.45 | 222.03 | 215.00 |
| 5 | Exact post retry | 133 | 209.65 | 9.42 | 3.68 |
| 10 | Create | 198 | 563.65 | 465.80 | 383.34 |
| 10 | Post | 353 | 1539.62 | 1381.95 | 1201.94 |
| 10 | Exact create retry | 132 | 1178.81 | 667.28 | 653.35 |
| 10 | Exact post retry | 133 | 566.90 | 29.36 | 14.39 |

Throughput повного циклу чотирьох HTTP запитів: 1/5/10 виконавців — **1.25/2.53/2.51 документів/s** (5/25/50 унікальних документів), **5.01/10.12/10.02 HTTP запитів/s**. Wall time включає thread setup/barrier idle та proof queries поза виміряними handler; це не чистий `post` throughput.

`pg_stat_activity` observer на іншому connection опитує тільки випадкову власну QA DB з delay 2ms після SQL. Реальна poll cadence повільніша через SQL (~1.05/1.15/1.13ms median) та планування. Він підтвердив server Lock states для post: 0/5, 25/25, 48/50 запитів; відсутність sampled lock не доводить відсутність короткого wait. `ledger_select_ms` включає очікування **і** normal query/driver/thread scheduling. Sample span — нижня спостережена частина інтервалу, не точна тривалість блокування. `service_less_ledger_select_ms` — різниця виміряних spans, не CPU time. Observer додає навантаження; не називати ці величини точним PostgreSQL lock-only latency.

Найбільше підтверджене serializer-вузьке місце прибрано. При 5→10 виконавцях throughput цього baseline майже не зріс, а очікування глобального accounting ledger lock зросло. Авторитетні межі ledger/atomicity/idempotency не змінюємо за одним синтетичним probe. Подальший capacity висновок потребує окремого заміру після serializer patch на реальному deployment topology; він цим пакетом не заявлений.

## Цільові докази

`tests/test_voucher_detail_batch.py`, PostgreSQL: **6 PASS** (без повтору вже успішних незмінених тестів). Перший прогін виявив тільки помилки test-oracle imports і fixture lot/expiry; повторено лише відповідні невдалі сценарії.

- Реальні posted 1/30/100 receipts/sales: постійна кількість запитів, повний DTO збігається з попереднім serializer.
- Supplier/customer partial returns і їх reversal; fulfilment purchase/customer orders рахує тільки проведені наступні документи.
- Annotated multilot, unannotated legacy ambiguity, застарілі metadata рядка, negative/reversal exclusions.
- Cashier cost/value redaction, чужий direct document 403, повторний read після відкликання ролі 403.
- Real HTTP create/post/exact retry повертає той самий DTO, posted timestamp і ID: один рядок/рух, два audit events.
- Baseline concurrent 80 різних документів: повтори не створили зайвих рядків/рухів/audit; один posted timestamp і той самий line DTO на кожний документ.

Django discovery `manage.py test tests` у server/postgres CI та явному full-check автоматично включає новий test module. Benchmark навмисно opt-in і не доданий у CI/full. Повний набір, production rollout або мережевий benchmark не запускалися.
