# B21 — інтерфейс збереженого імпорту

Інструмент відкривається в «Товари й ціни» → «Імпорт товарів із CSV або Excel». Чинний атомарний preview/commit лишається для файлів до1000 товарів у межах попереднього payload. Файли з більшою кількістю рядків, понад5МіБ або понад1МіБ parsed payload переходять до окремого серверного запуску. Максимуми:100000 товарів,50МіБ сирого файлу та окремо50МіБ канонічних даних,200 записів/1МіБ на запит,16КіБ на запис. XLS/XLSX, як і раніше, читає перший аркуш.

## Послідовність

1. Обрати файл, перевірити трактування стовпця «Ціна» та націнку нових товарів.
2. «Завантажити для перевірки»: створити один незмінний запуск і послідовно передати порції. Завантаження можна зупинити після поточного запиту. Це не скасування серверного запуску.
3. Серверний worker зіставляє каталог і перевіряє весь файл. У картці показані окремо прогрес, заплановані дії й фактичні результати. `indexedPaths`, коли сервер його надає, — кількість записів каталогу, не рядків файлу.
4. «Застосувати перевірений план» передає видимий `planRevision`. Порції застосовуються окремими транзакціями. Скасування подальшої роботи залишає уже застосовані товари та незастосовані рядки.
5. Журнал містить тільки імпорти поточного активного автора з чинною роллю owner/manager/warehouse. Немає обходу для адміністратора. По30 запусків у журналі, по100 рядків результату на сторінці. Сервер повторно перевіряє права на кожне читання та запис.

## Повтори та перезавантаження

- Create/chunk/seal/apply мають окремий незмінний intent. Timeout, втрачений ACK чи некоректний успішний DTO залишають тільки «Повторити початкову дію»; інші команди запису заблоковані. Дані, UUID, зміщення та planRevision не перебудовуються під час повтору.
- Читання результату не є повторним застосуванням. Навіть якщо worker завершився, невідомий apply ACK підтверджується точним повтором збереженого запиту. Для resume після втрати відповіді спершу читаємо чинний стан; уже поновлений запуск не отримує ще один resume.
- Підтверджений create ACK із помилкою наступного GET зберігає номер. Окрема кнопка повторює тільки читання; новий create, відкриття іншого запуску та перехід журналом заблоковані до підтвердження цього читання. Resume/cancel ACK також мусить відповідати запитаному UUID.
- Після reload відкрийте журнал та запуск. Для незавершеного uploading знову оберіть початковий файл. Перевіряються SHA256 **усього** сирого файлу, кількість parsed rows, незмінні опції та кожен вже завантажений chunk за read-only receipts. Ім’я/кількість/спільний префікс самі не підтверджують файл. Інший суфікс або normalized prefix відхиляється до POST. Підтверджені порції повторно не записуються.
- Запуски без `sourceHash` не мають безпечного відновлення файлу: можна скасувати й створити новий. Хеш сирого файлу — клієнтський fingerprint; серверні inputHash/planRevision обчислюються незалежно.
- Локальний незавершений intent живе в відкритій вкладці, не обіцяє reload survival. Після reload діє серверний журнал і перевірка початкового файлу.

## Читання та фокус

Пошук/фільтр/сторінки працюють через GET. Кожен DTO перевіряється під час виконання: статуси, UUID/хеші, boolean capabilities, nullable поля, decimal strings, межі page та counts. Detail додатково має відповідати запитаному UUID. Abort і request identity не дозволяють старій відповіді підмінити нову картку. Помилка GET залишає підтверджену картку/файл, блокує подальші команди до успішного читання й фокусується на поясненні. Читання має30с deadline та окреме скасування.

Автооновлення — лише видимий queued/running запуск: раз на5с, до60 циклів, після чого явне ручне оновлення. Закритий disclosure, інший маршрут, прихована вкладка, pending command або GET помилка зупиняють poll. Журнал не завантажується кожним poll; поля локального файлу не перемальовуються. Для історичних atomic receipts без відомого часу написано «Додано до журналу», без вигаданої дати проведення.

## Цільова перевірка

```sh
node tests/catalog-import-parser.cjs
node tests/catalog-import-jobs.cjs
npm run generate:api
npm exec --workspace frontend -- tsc --noEmit
PYTHON_BIN=/tmp/tsukenya-review-venv/bin/python node tests/catalog-import-jobs-ui.cjs
# Повтор лише незавершеного/зміненого сценарію:
QA_IMPORT_FROM=partial PYTHON_BIN=/tmp/tsukenya-review-venv/bin/python node tests/catalog-import-jobs-ui.cjs
QA_IMPORT_FROM=read-recovery PYTHON_BIN=/tmp/tsukenya-review-venv/bin/python node tests/catalog-import-jobs-ui.cjs
```

Докази на ізольованій SQLite та локальному Chrome, synthetic data:

- VM PASS: строгі malformed DTO; межі200/1МіБ/16КіБ; усі4 lostACK immutable retries; GET-only результат; wrong full-file suffix та changed normalized prefix; create ACK → GET503 → GET-only recovery.
- Основний браузерний сценарій пройшов усі assertions до доданого незалежного partial case: реальні create/chunk/seal/apply зі втратою відповідей; pause після400/1001; reload і збережені receipts без prefix POST; неправильний суфікс відхилено; оригінальні readonly options; actual worker1001 продукт, два однакових apply запити; повторний reload GET-only; rows page100; GET503/error focus; keyboard Enter/Tab,1440/320 і еквівалент200% (720 CSSpx/32px base text), без horizontal overflow. Подальший partial case спершу зупинився на помилці **QA**: worker викликаний до ACK apply. Успішний основний етап з незміненими inputs повторно не запускався.
- Виправлений окремий `QA_IMPORT_FROM=partial` PASS:201 рядок, actual apply100 → explicit cancel →100 products retained/101 pending, без apply/resume післяcancel.
- Змінений `QA_IMPORT_FROM=read-recovery` PASS: confirmed create ACK → GET503 → одна read retry → той самий файл/один create; delayed GET → cancel preserves card/options, old response discarded.
- Parser PASS: збережений1000 atomic boundary, opt-in1001 та100001 rejection. Type generation/tsc, JS syntax та diff whitespace PASS.

Артефакти цієї сесії: `/tmp/tsukenya-import-jobs-native/{wide,narrow,zoom200}.png`, `/tmp/tsukenya-import-jobs-native-partial/report.json`, `/tmp/tsukenya-import-jobs-native-read/report.json`. Основний report містить останній QA partial timeout, а не помилку завершеного імпорту; наведені вище assertions і незалежний partial report явно розділені.

Це не production capacity/SLA100000, не native-phone memory і не screen-reader proof. CSV/XLSX поки читаються в пам’ять браузера; bounded API uploads не означають streaming parser. Shared controls не змінювалися, Storybook не дублює native DOM. Worker не запускався на VPS, застосунок не публікувався; запуск scheduler та фінальні серверні performance boundaries належать окремому серверному пакету B21.
