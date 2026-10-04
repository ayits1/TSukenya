# ABC-аналітика товарів

## Робоча межа issue #1

У `#trade/reports` є третій режим **ABC товарів**, інтегрований React-екран, а не лабораторний макет. Початкові магазин і період передаються з чинних фільтрів торговельного звіту. Після успішного читання ABC той самий магазин/період зберігається при поверненні до оборотів. Пошук, клас і аналітичні межі живуть лише в браузерному перегляді. Нових persisted settings, моделей чи облікових проведень немає.

ABC використовує лише проведені в системі `sale` та `customer_return`. Сам по собі звіт не імпортує касові вигрузки, не підтверджує їх повноту й не визначає відсутність старих закупівель. COGS — фактичні збережені `VoucherLine.cost`; нульова собівартість не доводить ні помилку, ні наявність документального підтвердження. Створення імпорту касових продажів залишається окремою межею первісного плану.

## Значення та класи

- Облікова дата документа — `Voucher.date`. Сторно віднімається за київською датою `reversed_at`, повернення — своєю обліковою датою. Відсутній час скасування зберігає чинну відмову звітів; його не вгадуємо. Дата завершення не пізніше сьогодні в Києві.
- Кожний рядок додає `period_sign × (+1 продаж / −1 повернення) × quantity/amount/cost`. Документ, проведення й сторно якого цілком усередині одного періоду, має нульовий напрям і не створює окремого SKU у звіті. Чернетки виключено. Списання/інвентаризація не є продажами.
- Агрегування за стабільним product ID, включаючи приховані зараз товари. Назва — з першого за PK внескового рядка проведення; це історичний підпис, а не каталог на дату. `hiddenCurrent` — **поточна** ознака каталогу (explicit true), не історія приховання. JSON hidden проектується SQL boolean, не переноситься як необмежене вкладене значення.
- Знаменник — сума **позитивного чистого виторгу** SKU. Нульові й від’ємні SKU мають `unclassified`, без частки й накопичення. Від’ємні суми/кількості не обрізаються. Показано загальний чистий виторг, позитивний пул, від’ємний виторг, COGS, валовий прибуток і counts покриття.
- Сортування за точним Decimal-виторгом спадно, потім stable ID. Рівний виторг — одна група. Якщо накопичення **до групи** менше A, вся група A; інакше якщо менше B — B; решта C. A може перевищити свою межу, навіть перший великий SKU лишається A. Не розриваємо нічиї за назвами.
- 80/95 — лише початкові **аналітичні** query/UI значення. Валідація `0 < A < B < 100`, до двох десяткових знаків. Це не рішення власника про бізнес-політику.
- Classification обчислюється до пошуку й class-filter. Фільтр не змінює знаменник, клас чи summary. Shares/cumulative DTO мають чотири десяткові знаки; класи рахуються до округлення. Дуже малий позитивний внесок може мати displayed share `0.0000` й однакові rounded before/after.
- Одна збережена одиниця дозволяє суму quantity (3 dp). За різних історичних одиниць `unitConflicted=true`, `quantity/unit=null`; конвертації чи довільного додавання кг до шт немає. Порожня збережена одиниця явно підписується як невказана.

## API та поточні права

Контракт `contracts/trading-abc.openapi.json`, generated `frontend/src/shared/api/abc.generated.ts`; runtime decoder у feature `api.ts` перевіряє DTO, exact requested context, date/threshold/scales, справжні enum/string, page30/pages/itemcount, duplicate IDs, coverage/class counts і relationships. Malformed JSON200 теж protocol error.

- `GET /api/v1/trading/reports/abc`: `from/to/store/aThreshold/bThreshold/q/class/page`, JSON максимум 30 items; page понад кінець clamped. `q` до250 символів, SQL literal `%/_/\`; клас `A|B|C|unclassified` або порожньо. Summary цілий для контексту.
- `GET /api/v1/trading/reports/abc/export.csv`: ті самі умови без page; **вся вибірка**, включаючи рядки інших сторінок. Пошук/клас застосовуються до повної вибірки, classification не перераховується. UTF-8 BOM, semicolon, quoted cells, CRLF. Metadata містить scope/period/thresholds/generatedAt/coverage/policy. Formula guard для текстових ID/назв/одиниць і scopeName; signed money/quantity лишаються числовими.
- Поточні owner/manager/accountant та існуючий scope фінансових звітів. Scoped користувач бачить свій магазин; foreign explicit store дає порожній доступний перетин, не назву/суми чужого магазину. Network selection лишається network навіть при одному доступному магазині.
- Fresh actor всередині readonly RR; export перевіряє його знову при фактичному початку генератора. Немає кешування ролей, ledger/audit writes або нових cost-visibility правил. Це поточний незалежний snapshot кожного read, не збережений стан «що було відомо на ту дату»; наступний page/CSV може змінитися після нового проведення.

## Пам’ять, тимчасовий диск і межі

`VoucherLine` scalar projection/iterator200 без завантаження всіх дочірніх рядків voucher. Приватний `Spool`: каталог0700, файл0600, SQLite disk temp, cache2MiB, Decimal collation (без float/REAL sorting). Python тримає поточний агрегат/рядок, cursor100 та чотири class totals. Групи нічиїх індексовано на диску; довга група не створює Python list. Весь CSV не накопичується: StringIO очищується між рядками.

ORM/aggregation O(внескових рядків), disk O(SKU); сортування на диску. Пошук може сканувати disk агрегати. Existing `stores_for` має список доступних магазинів. Кожне читання заново рахує контекст; RR тримається протягом CSV-stream. Це не SLA, не доказ capacity VPS і не гарантія часу/вільного диска. Тривалі exports/timeouts/temp-disk quota є окремими operational питаннями. Normal completion, exception і закриття stream прибирають приватний spool.

## UI відновлення та доступність

Дата через чинний DatePicker; магазин через чинний bounded DirectoryComboBox; threshold/search через спільні поля, class через спільний Select. Недоступний збережений store не підміняється мережею мовчки: користувач явно очищає/обирає доступний контекст і натискає «Показати ABC».

Під час читання filters/paging/CSV blocked. При503 показано лише попередній підтверджений контекст **того самого store**, зі старими явними датами/thresholds; нова чернетка не губиться, CSV disabled. Retry — GET початкових невдалих read умов.403 і protocol/malformed200 прибирають private results.401 очищає їх перед переходом на вхід. Generation/Abort fences не дозволяють late results/late401 після leaving ABC. Дії читання не створюють записів. CSV URL завжди з confirmed filters, а не незастосованої чернетки.

## Відтворювані цільові перевірки

Без full regression, production або Google Sheet. PG localhost61144, власна база `test_tsukenya_abc_review`.

- `tests/test_abc_reports.py`: 12 distinct methods. Перші8 PG PASS (`/tmp/tsukenya-abc-pg.log`): actual receipt/sale/return parity, before-tie/custom thresholds/filter-independent summary, Kyiv reversal/hidden/mixed/draft, zero/negative/invalid thresholds/no writes,65 pages/fullCSV/exact Decimal/literal search/0600/cancel cleanup/querycount<15, financial role/store/export currentactor, READ ONLY/RR і concurrent insert snapshot. Три нові methods — scope CSV formula, SQL scalar malformed nested hidden, stream-error cleanup — цільово PASS у follow-up хвилях (`/tmp/tsukenya-abc-pg-followup.log`, `/tmp/tsukenya-abc-pg-context.log`). Змінений caption повторно перевірено лише affected role/CSV methods. Fresh-actor CSV preflight (cached old profile не відхиляє чинний дозволений accountant) — один окремий PG PASS `/tmp/tsukenya-abc-pg-actor.log`.
- API unit:4 початкових PASS +1 additive malformedJSON/impossible-class case PASS. Storybook3 початкових PASS (`/tmp/tsukenya-abc-story.log`),2 нових Empty Coverage/Unavailable Store PASS (`/tmp/tsukenya-abc-story-tail.log`). tsc/lint/build/Prettier/diff — власні змінені inputs.
- `tests/abc-reports-ui.cjs`: actual native Reports→React→Django, disposable SQLite, synthetic65 SKU, real login; external font requests blocked for reproducible local QA. No production mutation. Default whole feature flow; `QA_ABC_FROM=recovery|late|layout` дає вузькі підетапи без full matrix.
- Перший native етап (third-mode keyboard/page30/search/page2/full65 CSV) PASS до виправленого harness locator: `/var/folders/9_/xkms65w90g57nhx8n9bhp6300000gn/T/tsukenya-abc-proof-2ZPZpW/report.json`. Цей файл має final pass=false, бо дві alert nodes були ambiguous для old locator; успішні перші stages збережені як такі, не названі повним pass.
- Recovery/range/layout/shape200 PASS до виправленого harness transport assumption: `/var/folders/9_/xkms65w90g57nhx8n9bhp6300000gn/T/tsukenya-abc-proof-XoLFdw/report.json`, також final pass=false через late-stage wait; успішні stages/PNG повторно не запускались за незмінних branches.
- Окремий late/current-real-role tail повністю PASS: `/var/folders/9_/xkms65w90g57nhx8n9bhp6300000gn/T/tsukenya-abc-proof-UwgOql/report.json`; transport, захоплений API до mount, справді ігнорує AbortSignal, late401 не змінює route; fresh server role403 прибирає private results. Full proof використовує generation, не лише aborted fetch.
- Final classC keyboard/filter і readable viewport coverage/row layout1440/320/200% PASS до косметичного узгодження CSV-link зі спільними токенами: `/var/folders/9_/xkms65w90g57nhx8n9bhp6300000gn/T/tsukenya-abc-proof-PV7F9q/report.json`. Після цієї зміни повторено тільки affected layout-stage: `/var/folders/9_/xkms65w90g57nhx8n9bhp6300000gn/T/tsukenya-abc-proof-Ccdzdw/report.json` PASS. Підписи/кнопки/стрілки й coverage/рядки переглянуті через PNG; звіти не є виміром фізичного мобільного пристрою.

Native harness зареєстровано в explicit `npm run test:full`, але його не запускали. Успішні stages перевикористовуються за незмінних входів; повтор відбувався лише для невдалого або affected підетапу.


## Root інтеграція та незалежне рев’ю

Незалежне read-only рев’ю exact author e68e625: PASS, п'ять finding закрито
(CSV scope formula, передача from/to, malformed JSON protocol, class counts,
SQL hidden scalar). Фінансові формули й source після інтеграції з accepted #74
не змінилися; source diff порівняння порожнє. Root tsc/Vite build PASS.
Один affected actual layout tail після інтеграції PASS: classC через клавіатуру,
повні denominator/buckets, 1440/320/200% та coverage/rows viewport screenshots.
Артефакти: `tsukenya-abc-proof-yuzBki` у системному tmp; root переглянув320 PNG.
Незмінні PG/unit/Story/інших native докази повторно використано.

Harness очищає connection/credential/settings variables до password helper,
пінує isolated settings/SQLite, відхиляє невідомий stage, рано помічає exit
серверу і чекає його зупинки. Full registry містить base+layout (late/recovery
вже входять до base), очищає QA_ABC_FROM/PORT. Syntax і dryrun перевірені;
фактичного test:full, production чи Sheet змін не було.


Root follow-up після прийнятого #76: merge конфлікт стосувався лише списку
очищених QA flags у full registry, усі hidden/collections/ABC stages збережені.
Source diff ABC backend/API/component/harness/contracts порівняно з976ea3a порожній.
Оскільки #76 змінив глобальний metadata runtime, виконано тільки affected actual
native late/privacy tail: PASS, `tsukenya-abc-proof-iAywYG` у системному tmp.
Збережений shell період, late401 після leave не перенаправляє, актуальна role403
очищає private results; тільки GET, без page errors. Решту proofs повторно
використано. Dryrun full-plan PASS, фактичний full не запускався.
