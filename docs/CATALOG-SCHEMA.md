# Схема файлового обміну каталогу 1

## Джерело та профілі

`contracts/catalog-exchange.schema.json` визначає сталі поля, українські заголовки, порядок, aliases, точність і приватність. Django читає цей registry; `node scripts/generate-catalog-schema.mjs` створює classic/CommonJS `app/catalog-schema.js` та [таблицю полів](CATALOG-SCHEMA-FIELDS.md). `--check` відхиляє їхній drift. Registry не обчислює ціни й не надає прав: це робить Django.

| Профіль | Стовпців | Призначення |
| --- | --- | --- |
| `exchange` | 14 | Поточний шаблон імпорту CSV/XLSX |
| `export` | 20 / 18 для касира | Редаговані умови + шість довідкових полів; закупівля й націнка відсутні для касира |
| `artifactBase` | 12 | Сумісна CSV-база Artifact зі старими заголовками |
| `artifactGS` | 15 | Сумісна Google-таблиця Artifact зі старими заголовками/порядком |

Перший заголовок поточних файлів містить ` [Каталог TSukenya 1]`. У CSV після нього стоїть окремий ` [TSukenya CSV 1]`: [версія транспортного екранування](CSV-FORMAT.md) не змінена. Marker перевіряється в усіх заголовках: переставлені колонки підтримуються, повторена/невідома позначка та повторене редаговане поле блокують файл до preview.

## Ціни, присутність і метадані

- Порожня клітинка не передає поле й зберігає чинне значення. Явні `0` закупівлі/націнки передаються. Export залишає відсутню закупівлю/націнку порожньою, не підміняє її нулем/default.
- «Автоматична» явно передає `manualPrice=false`; ручна ціна має бути порожньою, сервер очищає override за чинним правилом. «Ручна» передає `true`; додатну ціну перевіряє сервер. Порожній режим не вимикає чинний ручний override.
- **Націнка у позначеній схемі — процентні пункти:** число `0.5` означає `0.5%`, а `7` — `7%`. Стовпець XLSX має числовий формат, не Excel percentage. Текст `0.5%` також читається як `0.5`. Сумісний зовнішній файл без позначки зберігає старе трактування Excel raw `0.07 → 7%`; це окремий legacy adapter.
- «Акція товару» та її ціна — локальні збережені умови. Кампанія, поточна магазинна ціна та ознака чинної акції — окремі довідкові результати.
- «Звичайна ціна (лише перегляд), грн» не є ручною ціною. «Діюча ціна (лише перегляд), грн», чинна акція, ціна за100г, дата й прихованість не імпортуються. UI називає пропущені довідкові поля.
- Exact довідкові заголовки розпізнаються перед legacy aliases. Існуючий зовнішній alias «Звичайна ціна, грн» лишається ручною ціною; новий розрахований стовпець має іншу назву. Старий server export без нової позначки не оголошується поточним editable snapshot.
- ID — текстовий селектор оновлення, не поле перейменування. Чинні ID/name/unknown-ID guards залишаються. Штрихкод і ID зберігають початкові нулі.

Обидва серверні імпортери (атомарний і великий) використовують той самий browser parser. Preview/commit, revisions, snapshots, exact UUID retry, price/unit guards та історія залишаються чинними. На Artifact позначений current-файл використовує цей parser і explicit mode/zero adapter; старі Google headers, sync/default/unknown-ID policies не переписані. Live Sheet не читали й не змінювали.

## Актуальний шаблон та історичні джерела

`data/catalogue-template-v1.xlsx` створено `scripts/build-catalog-template.mjs` через bundled Artifact Tool. Перший аркуш має 14 заголовків registry, два явно синтетичні приклади, table/filter, text barcode/ID, закріплені заголовок/перший стовпець, numeric/list validations та окремі пояснення. Приклади потрібно замінити або видалити.

Actual Django «Товари й ціни → Імпорт → Завантажити шаблон XLSX» веде на GET/HEAD `/api/v1/catalog/template.xlsx`. Сервер перечитує current actor у readonly snapshot, дозволяє чинні edit-ролі, не приймає параметрів і повертає private/no-store файл. Docker копіює registry та current XLSX; classic schema script завантажується перед importer/portal.

`data/baza-tovariv-template.xlsx` лишається історичною книгою із38 заповненими рядками; CSV від29.09.2026 та seed adapter не переписані. Їхню стару ширину не виправляють вигаданими ID/націнками. ERP voucher templates і Label Studio CSV мають власні бізнес-поля й не входять у цей каталоговий профіль.

## Цільові докази · 04.10.2026

- Registry generator `--check`, `tests/catalog-schema.cjs` — PASS: 14/20/18/12/15 profiles, exact readonly priority, modes/blank/zero/ID, duplicate/unknown-version refusal, CSV escaping, actual Artifact current parser/plan. Canonical numeric/text `0.5`, explicit `0.5%`, unversioned Excel numeric `0.07` перевірені окремо.
- `tests/catalog-import-parser.cjs`, `tests/csv-format.cjs`, `tests/sync-sim.js` — affected PASS; unrelated сценарії не повторювали після стабілізації їхніх входів.
- `tests.test_catalog_schema` — 3 PASS на ізольованих SQLite та PostgreSQL18. Actual export→Node parser→preview→commit/exact retry: automatic/manual/local promotion/campaign/zero/readonly/private fields; download current actor; workbook headers/text/panes/validation і SHA256 історичних джерел. Preview не пише аудит; exact retry не додає записів.
- Після додавання missing-vs-zero та fractional0.5 повторено лише змінений PG roundtrip метод: PASS, `/tmp/tsukenya-catalog-schema-pg-fraction.log`. Націнка0.5 лишається0.5 після commit; відсутні cost/markup лишаються відсутніми. Після додавання SHA256 історичної XLSX повторено лише workbook метод на SQLite: PASS.
- `tests/catalog-schema-ui.cjs` — actual disposable SQLite/Chrome download через Tab/Enter, bytes checked-in XLSX, lazy XLSX parse→Django preview2 rows,1440/320/no horizontal overflow/44px: PASS. Артефакти `/var/folders/9_/xkms65w90g57nhx8n9bhp6300000gn/T/tsukenya-catalog-schema-ui-Jo2rcL/report.json` та `download-{1440,320}.png`, `preview-{1440,320}.png`.
- Вузький `QA_SCHEMA_FROM=fraction` перевіряє actual XLSX numeric0.5→preview request markup0.5, без повторення layout матриці. Остаточний harness також відкидає успадковані DB/PG/POSTGRES/settings/password параметри перед hash helper, задає `server.settings`, має explicit readiness timeout і awaited SIGTERM/5s SIGKILL cleanup. PASS із синтетичними успадкованими invalid DB/settings/POSTGRES параметрами: `/var/folders/9_/xkms65w90g57nhx8n9bhp6300000gn/T/tsukenya-catalog-schema-ui-eSzqLS/report.json`.
- Workbook render `/tmp/tsukenya-catalog-schema-proof/template-prices.png` та `template-instructions.png` переглянуто; таблиця, поля й пояснення читабельні. Це Artifact render/XML structure, не відкриття у native Excel.

### Межі доказів

Server source baseline — accepted `0e30c6b` з own schema diff. Native harness використовував compiled `frontend/dist` через тимчасовий symlink на root build: останній вузький запуск — root `fb2ceae` (P0 boundary), ширша layout перевірка — той самий borrowed root dist до його фіксації. Це не повністю matching frontend build бази76; перевірені template/parser/native DOM/server шляхи, без твердження про весь React application. Symlink/dependencies/session artifacts не доставляються.

Не перевірено native Excel/LibreOffice save/reopen, production deployment, live Sheet або повну регресію. XLSX numeric0.5 та external raw0.07 перевірені на фактичному застосунковому adapter; автоматичне визначення Excel percent-format у current workbook не додається. Ціноутворення й права не розширені. Generator/Node/native сценарії додані у майбутній явний full entrypoint; повний набір тут не запускали.
