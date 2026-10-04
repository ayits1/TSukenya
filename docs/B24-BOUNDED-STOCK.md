# B24: пагіновані залишки та асортимент

Пакет від baseline `145057a`, цільові докази 04.10.2026. Робочий `#trade/stock` використовує серверні сторінки, а не завантажує всі залишки для локальної фільтрації. Облік і внутрішні виклики `reporting.stock` для контролю/поповнення не змінено.

## Контракти та межі

- `GET /api/erp/stock`: `q` (назва, до 250 символів), `store`, `warehouse`, `page`, `view=totals|lots`, необов’язковий `sort=warehouse_product`. SQL сторінка до 30 рядків; `items`, `total`, `page`, `pages`, `limit`, `view`, `summary`. Завелика сторінка переходить на останню; некоректне число/enum дає 400.
- `summary` охоплює весь поточний фільтр: кількість пар товар/склад, рядків нижче мінімуму, додатних партій, партій із терміном до сьогодні + 7 днів, дозволена вартість. Немає спільної кількості для кг і шт. Мінімум, ознака «Продається тут», придатність, резерв і нульові історичні партії узгоджені з чинним складським сервісом.
- `GET /api/erp/assortment`: обов’язковий `warehouse`; `q`, `page`, необов’язковий `sort=name`, `product` для читання конкретного ID. `rows` до 30 плюс метадані сторінки. Дозволені правила редагування та ревізії не змінено.
- `GET /api/erp/stock.csv` використовує ті самі фільтри підсумків і вивантажує весь результат. CSV 1, BOM, `;`, захист тексту від формул; кількість 3 знаки, авторитетна вартість партій 2 знаки. PostgreSQL server cursor читає порціями по 100, Python не накопичує весь експорт.
- Scope користувача перетинається з параметрами магазину/складу. Касир не отримує вартість ані в рядках, ані в підсумках, ані в CSV. Читання сторінки й підсумків має спільний read-only repeatable-read snapshot; CSV має власний snapshot на час потоку.

Пошук/зміна фільтра відразу скасовують старий GET і блокують дії старих рядків, також під час debounce. Найновіший запит визначає таблицю; пошуковий фокус і каретка зберігаються. Помилка читання лишає чернетки й дає явний повтор. Партії читаються лише після розкриття секції. Чернетки асортименту зберігають вихідну ревізію між сторінками, пошуком, складами та розділами; повернення до чернетки читає саме її ID. Свіжий GET не переписує введення й не усуває 409 автоматично.

**Незакрита суміжна залежність:** `load()` досі читає повний ERP state і legacy каталог `P`; довідники `E` потрібні чинним формам, розрахункам і підписам історії. Цей пакет їх не обрізає. Окремий наступний пакет має переключити реальні вибори/таблиці на пагіновані довідники й batch detail перед slim bootstrap. Внутрішні повні розрахунки контролю/поповнення також не оголошуються оптимізованими цим пакетом.

## Вимір

Синтетична ефемерна PostgreSQL: 100/1000 SKU, стільки ж контактів, 10/100 працівників і рахунків, один склад і партія на товар. По одному прямому service читанню; SQL count включає транзакційні команди, raw bytes — UTF-8 JSON. Це не wire size, HTTP latency, capacity/SLA чи production benchmark. [До](evidence/b24-stock-before.json), [після з хешами джерел](evidence/b24-stock-after.json), [відтворення після](evidence/b24-stock-measure.py).

| Читання, 1000 SKU | До: SQL / bytes / рядки | Після: SQL / bytes / рядки |
| --- | --- | --- |
| Залишки | 5 / 461 805 / 1000 totals + 1000 lots | 5 / 6 983 / 30 items |
| Асортимент | 4 / 177 026 / 1000 rows | 8 / 5 388 / 30 rows |
| ERP state | 316 / 263 366 / повні довідники | 316 / 263 366 / без змін |

Одиничні service samples залишків: 25,38 → 11,26 ms; асортименту: 7,70 → 5,58 ms. Вони не підтверджують стабільний latency gain. EXPLAIN на свіжих 1000 рядках без ручного ANALYZE виявив повторні join scans; metadata перенесено в grouped facts, membership пар використовує hash subplan із non-null FK. Фінальні summary/page execution samples 3,44/3,48 ms, без глобальних planner settings. SQL усе ще агрегує відповідний набір у БД; bounded тут стосується вибраних рядків/пам’яті Python і UI, а не сталої роботи БД незалежно від розміру.

## Цільові перевірки

- `tests.test_stock_browsing`: **5 PASS**, PostgreSQL 18, окрема `test_tsukenya_stock_browsing`; Decimal parity усіх сторінок із `reporting.stock`, FEFO резерв/expired/multilot/нульова партія/мінімум/sold, scope/касир/enum, selected-ID, потоковий CSV, конкурентна зміна між summary і page. HTTP сторінка ≤ 8 SQL у відповідному fixture. Перевірка конкурентного читання підтверджує старий snapshot усередині запиту та новий у наступному GET; проведення не змінено.
- Існуючі `tests.test_assortment.AssortmentTests.test_api_lists_rows_and_saves_with_revision` та `test_roles_and_store_scope`: **2 PASS** на PostgreSQL. Fixtures переведено на TransactionTestCase для явного read-only snapshot поза enclosing write transaction.
- `PYTHON_BIN=/tmp/tsukenya-review-venv/bin/python node tests/bounded-stock-ui.cjs`: **PASS** у native Chrome, ізольована SQLite, 67 SKU, справжні HTTP read/write. Останній товар, сторінки totals/lots/assortment, сума 670,00 для всього фільтра, клавіатура/фокус, чернетка поза сторінкою, fresh GET → 409 → явне прийняття, 503/повтор, abort/race/каретка, CSV усіх 67. [Збережений звіт](evidence/b24-stock-native.json).
- 1440/320 px: document width дорівнює viewport, пагінація й дії асортименту ≥ 44 px. Переглянуто native PNG у `/tmp/tsukenya-bounded-stock-proof/`: `stock-*`, `assortment-*`, `assortment-row-*`; фінальний `report.json` має `pass: true`. Це не канонічні Linux baselines.
- Node syntax змінених app/test scripts, Python compile, `git diff --check`: PASS. Наявні CRM/CSV/dialog fixtures адаптовано до нового контракту; їхні повні незмінені сценарії не запускали. Повна регресія, інші браузери, deployment та production capacity не перевірялися.

PG команда використовує лише наданий локальний QA контейнер і власний DB_NAME; credentials беруться з локального QA context, не з production. Тестовий скрипт Chrome прибирає успадковані DB variables та видаляє власні дані після завершення. Root додає новий браузерний сценарій до explicit full-check registry під час інтеграції.
