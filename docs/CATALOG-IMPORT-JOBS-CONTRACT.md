# B21: збережені великі імпорти та журнал — серверний контракт

Це технічні правила реалізації. Вони не розширюють бізнес-права. «Власник імпорту» — його автор `run.owner_id == user.pk`, а не адміністратор із доступом до чужих запусків. Читання та команди дозволені лише активному автору з поточною роллю owner/manager/warehouse. Перед записом і поверненням збереженого ACK сервер повторно перевіряє актора після `LedgerLock`.

Малий імпорт до 1000 рядків зберігає чинні preview/commit та атомарний DTO. Великий має незмінні вхідні рядки, збережений план, перевірку всього файлу та окремі транзакції запису до 100 рядків. Завершені пакети залишаються записаними при помилці або скасуванні наступного: **це не атомарний імпорт усього файлу**.

## HTTP

Префікс `/api/v1/catalog/import`. Чинні cookie/Origin/CSRF. UUID у нижньому регістрі; невідомі поля відхиляються. GET нічого не записує.

| Маршрут | Вхід / результат |
| --- | --- |
| `POST /runs` | `{idempotencyKey,fileName,expectedRows,defaultMarkup?,sourceHash?,genericAs?}` → незмінний `{ok:true,id,status:'uploading',expectedRows,sourceHash,limits}`. `id == idempotencyKey`. Той самий автор і точний запит повертають старий ACK; чужий автор404, змінений запит409. |
| `POST /runs/{id}/chunks` | `{offset,entries}`; offset — кількість уже завантажених рядків, entries1..200 із чинними `{line,id?,revision?,values}`. ACK `{ok:true,id,offset,count,uploadedRows,chunkHash}`. Точний повтор старого пакета повертає старий ACK навіть після seal; інше тіло під старим offset409; пропущений offset409. |
| `GET /runs/{id}/chunks?page=1` | `{items:ChunkAck[],total,page,pages}`,100 на сторінку, offset за зростанням. Для перевірки вже завантаженого префікса після reload. |
| `POST /runs/{id}/seal` | `{}` → незмінний `{ok:true,id,inputHash,status:'queued',phase:'indexing'}`. Усі заявлені рядки мають бути завантажені. Сервер фіксує вхідний відбиток і цінову конфігурацію. |
| `POST /runs/{id}/apply` | `{planRevision}` → незмінний `{ok:true,id,planRevision,status:'queued',phase:'applying'}`. Лише готовий валідний план. Точний повтор повертає старий ACK навіть після завершення; нова версія409. Зміна налаштувань до першого підтвердження409. |
| `POST /runs/{id}/resume` | `{planRevision?}` → актуальний Run. Лише failed/blocked. Застосування потребує початкової planRevision. Вхідні рядки та курсор не змінюються. |
| `POST /runs/{id}/cancel` | `{}` → актуальний Run. LedgerLock дочікується поточного пакета; подальші записи зупиняються, попередні залишаються. |
| `GET /history?mode=atomic\|chunked&page=1&status=...` | `{items:Run[],total,page,pages}`,30 на сторінку; mode без фільтра показує обидва режими. Тільки запуски автора. |
| `GET /runs/{id}` | Run без додаткової обгортки. |
| `GET /runs/{id}/rows?page=1&status=...` | `{items:Row[],total,page,pages}`,100 на сторінку, ordinal за зростанням. |

`sourceHash` — optional64hex SHA256 сирих байтів файлу; новий UI завжди надсилає та перевіряє його **для всього файла** після reload, перш ніж дописувати ще не завантажений суфікс. Лише ім’я, кількість рядків або збіг старих chunks не доводять тотожності суфікса. Відсутність sourceHash у стороннього старого клієнта не дає UI підстав відновлювати файл: потрібен новий запуск. Це технічний клієнтський відбиток; сервер не стверджує, що отримав сирий файл. Авторитетні `inputHash` і `planRevision` сервер обчислює сам.

`genericAs` — optional `cost|price`, незмінні метадані парсера; сервер не переінтерпретовує через нього бізнес-поля. `defaultMarkup` — optional десятковий рядок до32 символів, застосовується лише до нових товарів. Після reload UI відтворює початкові, заблоковані для редагування опції.

`chunkHash` = SHA256 UTF8 канонічного JSON **повного** `{offset,entries}`: recursive sorted keys, `ensure_ascii=False`, separators `(',',':')`, без NaN. `inputHash` — серверний накопичувальний SHA256-ланцюжок відбитків усіх рядків у порядку ordinal. Матеріал planRevision накопичується в тій самій транзакції, що й перевірка чергових100 рядків; завершення не перечитує весь файл.

## DTO

```json
{
  "id":"00000000-0000-4000-8000-000000000001", "mode":"chunked",
  "fileName":"Каталог.xlsx", "expectedRows":1200, "uploadedRows":1200, "inputBytes":350000,
  "sourceHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "genericAs":"cost", "defaultMarkup":"40",
  "inputHash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "planRevision":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "status":"ready", "phase":"validating", "progress":{"done":1200,"total":1200},
  "counts":{"created":0,"updated":0,"skipped":0,"conflicted":0,"failed":0,"invalid":0,"pending":1200},
  "planned":{"create":1100,"update":90,"skip":10},
  "canApply":true,"canResume":false,"canCancel":true,
  "createdAt":"2026-10-04T10:00:00+00:00","updatedAt":"2026-10-04T10:02:00+00:00",
  "startedAt":"2026-10-04T10:01:00+00:00","finishedAt":null, "error":null,
  "limits":{"maxRows":100000,"uploadRows":200,"workerRows":100,"maxEntryBytes":16384,"maxTotalBytes":52428800,"maxChunkBytes":1048576}
}
```

```json
{
  "ordinal":1,"line":2,"status":"planned","action":"update","id":"coffee",
  "revision":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  "currentRevision":null,"values":{"name":"Кава","cost":"11.23","markup":"30","unit":"шт"},
  "regularPrice":"15.00","salePrice":"14.50","error":null
}
```

Run status: `uploading/queued/running/ready/invalid/completed/completed_with_issues/blocked/failed/cancelled`. Phase: `uploading/indexing/validating/applying/finished`. Row status: `uploaded/planned/invalid/created/updated/skipped/conflicted/failed`. Action: `create/update/skip/null`. `id/revision/currentRevision`, ціни, `sourceHash/genericAs/defaultMarkup/inputHash/planRevision`, початок/завершення можуть бути null. `values` завжди об’єкт: це нормалізований попередній перегляд, а **не сирий вхідний рядок**; до перевірки й у старій атомарній квитанції він `{}`. Ціни — десяткові рядки або null.

Counts показують фактичний результат, planned — окремий попередній план. Pending включає uploaded/planned. Зміна каталогу/конфігурації/ефективної ціни після плану → conflicted. Відмова поточного валідатора → failed із `apply_validation_failed`. Некоректний рядок під час планування → invalid із `invalid_import_row`; будь-який такий рядок блокує apply всього плану. Технічна помилка пакета відкотить усі його товари, outcomes та audit разом; Run стає failed із загальним `worker_failed`, без traceback/host/секретів. Позбавлення прав автора → blocked/`access_revoked`, без записів; resume можливий лише з чинними правами. Error завжди `{code,message}` або null; message українською.

## Незмінність і відновлення

- Run UUID та ACK create/chunks/seal/apply зберігаються. Старий ACK не означає поточний стан — після нього клієнт читає Run через GET. Заборонено автоматично створювати новий запуск після втрати відповіді.
- Worker читає персистентний курсор, забирає lease із UUID/expiry та перевіряє його після LedgerLock і перед commit. Старий працівник після перехоплення lease не може записати пакет. Завершені рядки не застосовуються повторно.
- Усі повторені номери/нормалізовані назви/штрихкоди перевіряються SQL-запитами для всього run, а не лише поточного chunk. Індекс каталогу будується частинами200; неоднозначні або змінені під час планування збіги відхиляються.
- Shared normalise_product, unit guard, barcode/name guard, авторитетні Decimal/ціни та аудит чинні перед кожним записом. Новий product ID = UUID5(runID,line), як у малому імпорті. Рецептури/hidden/залишки/кошти/Sheet не змінюються неявно.
- EffectivePriceRevision включає Київську дату і контекст. Перехід дати/акції/магазину, який змінює цей відбиток, дає явний conflict; worker не переузгоджує план сам. Зміна конфігурації при плануванні потребує нового run, а не перегляду старого входу.
- Малі успішні імпорти дзеркаляться в журналі в існуючій транзакції, без зміни старого ACK. Міграція0017 потоком додає лише валідні історичні `import_runs/UUID` з відомим автором. Некоректні квитанції не підставляються під іншого користувача. Старий receipt не містить час/filename/sourceHash/values: у нього порожня назва, startedAt/finishedAt=null, createdAt — час внесення в журнал, **не вигаданий час імпорту**.

## Ресурси та запуск

До100000 рядків; upload200; validation/apply100; catalog index200; raw entry16КіБ; chunkJSON1МіБ; сумарний канонічний вхід50МіБ. Перевищення явно відхиляється, без обрізання. Вибір довідників для рядка використовує relevant legacy values і всі explicit записи до5000/2МіБ; перевищення — явна помилка. Читання старих каталожних документів для перевірки назв/одиниць потокове, без Python-масиву всього каталогу. PriceResolver спостереження обмежено поточними product paths; це зберігає цінові правила та audit.

```sh
python manage.py process_catalog_imports --once
python manage.py process_catalog_imports --run UUID --max-steps 100
```

Одна команда без параметрів виконує один обмежений крок; `--once` теж один. Планування scheduler/VPS — окрема робота, її тут не запускали. Алгоритмічне обмеження пам’яті не є заміром production capacity: послідовний Unicode name/unit scan і кількість магазинних price observations можуть впливати на час. Тест1001 SKU підтверджує цей сценарій, не гарантує SLA для100000 товарів чи VPS.
