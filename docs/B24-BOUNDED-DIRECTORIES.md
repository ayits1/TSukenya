# B24: обмежені довідники та ERP bootstrap

## Межа пакета

Native ERP `app/erp.js`, платежі, зміни, рецептури та інтегрований React список покупців використовують новий trading API. ERP bootstrap повертає роль, поточний магазин, capabilities, CSRF та налаштування без масивів товарів або довідників. Порожні `E.stores/warehouses/accounts/employees/parties/expense_categories` залишені лише для старих HTML шаблонів: adapter перетворює їхні поля на серверні picker-и. Вони не є обрізаною першою сторінкою повного довідника.

| Дані | Фактичні споживачі |
| --- | --- |
| Товари | POS точний штрихкод/назва, товарні рядки, legacy та версійні рецептури, assortment filter |
| Магазини | ERP filters, форми документів, історія змін/звітів, admin поля, React покупці |
| Склади | stock/assortment, джерело документа та окрема ціль переміщення |
| Рахунки | фінанси/setup, документ/спосіб оплати, платежі/аванси, відкриття зміни, ціль переказу |
| Працівники | paged staff, табель, продаж/зарплата, відкриття та історія змін |
| Контрагенти | setup, fallback покупці, документи, платежі й аванси |
| Статті витрат | чинний або історично вибраний UUID у формі витрати |
| Касові зміни | доступні відкриті зміни та історично вибрана зміна |

Збережені назви рядків документа не переписуються. Для captions реквізитів читаються лише потрібні ID. Початкові ставки/відсотки табеля та ціни наявної чернетки не замінюються цінами чи умовами з нового detail-read.

## Контракт і межі читання

Окремий `contracts/trading.openapi.json`, generated types та resource-aware runtime decoder. `GET /api/v1/trading/directories/{type}` — SQL COUNT та сторінка 30 зі стабільним сортуванням, пошуком і чинним role/store intersection. `POST /directories/details` — явно read-only запит з CSRF, до 200 різних typed IDs; невідомі/чужі записи мають однакову unavailable відповідь. Read-only PostgreSQL REPEATABLE READ об’єднує count, rows та money extras в одному snapshot.

- Paged balances/payroll debt рахуються Django за ID поточної сторінки; browser не рахує суму неповного довідника.
- Product regular/sale price та чотиризначна собівартість надходять із Django. Pricing settings читаються один раз на сторінку; `revision` використовує вже завантажений resolver config.
- Exact POS lookup повертає total для неоднозначності й до 30 результатів. Кілька збігів відкривають явний вибір без зміни решти чернетки.
- CSV шаблон початкових залишків/надходження/інвентаризації читає весь дозволений набір через iterator та streaming response; він не залежить від browser cache. Формат quoted/versioned, значення захищені від spreadsheet formula injection.
- Selected metadata кеш обмежений 1200 записами; це не повний каталог і не джерело totals. Пакети гідратації до 200 ID, idle поля не завантажують option pages.
- Purpose зберігає чинні правила active party, recipe hidden, відкритої каси та cashier own cash shift. Нової загальної заборони inactive/hidden чи cross-store target немає. Вибраний історичний товар і stock labels архівного магазину читабельні; нові sale/POS choices зберігають active-store guard.

## UI та recovery

`DirectoryComboBox` використовує спільний React Aria ComboBox: окремий search text і committed ID, generation/AbortController, loading без старих результатів, SQL page footer. Native adapter зберігає оригінальний hidden select як FormData/event міст і не створює другу selection реалізацію. Selected detail error має окремий read retry, який залишає ID та новіші поля. Busy fieldset блокує відповідний React control.

Tab переводить фокус у доступну footer кнопку; Enter читає наступну сторінку й повертає фокус у input. Alt+PageUp/Down перемикає сторінки. Escape закриває popup та зберігає вибір, не викликаючи native dialog cancel. Popup монтується в dialog top layer зі стандартною React Aria viewport boundary та native containerPadding 32 px (24 px найбільший inset чинного dialog + 8 px для рамки фокуса); scrollable dialog не використовується повторно як власна boundary. Flex/border-box залишає footer в межах видимого dialog rectangle. Adapter піднімає перекрите sticky actions поле у видиму частину. Нові awaited entity/work-shift/voucher opening reads перевіряють source, generation і поточну сторінку перед відкриттям форми.

## Цільові докази

Source delivery: `774b0a5`, `e05d780`, `e407545`, `f72bbb0`; остаточний native race/layout/performance follow-up `ca66e45`. Усі зміни виконані в isolated clone від main `0550d10`; root окремо інтегрує поточні mutation scope guards та global metadata пакет.

Перевірки використовують disposable SQLite або окрему `test_tsukenya_directories` PostgreSQL БД, без production/Google Sheet.

- `tests/test_trading_directories.py`: 7 PostgreSQL сценаріїв PASS (1.636 s): 8 довідників, 66 записів/30-row pages/off-page detail; role/store/cost/salary privacy; strict payload/CSRF/no writes; money parity; exact POS ambiguity; архівний магазин; writer interleaving між count/rows з read-only snapshot. Додатковий pricing config N+1 case PASS (0.184 s): 35 товарів, 30 рядків, лише один settings/main read. Streaming CSV formula/4dp/68-row round-trip case PASS (0.290 s).
- `api.test.ts`: 4 unit сценарії PASS для typed details/request completeness та malformed page/resource DTO, including count/pages/length/duplicate IDs.
- Shared Controls + DirectoryComboBox: 12 Storybook сценаріїв PASS (3.50 s), matching keyboard, race/parent, retry та pinned inactive selection.
- `tests/bounded-directories-ui.cjs`: actual native Chrome consumer proof; окремі `DIRECTORIES_FROM=primary|tail|race|layout|zoom` повторюють тільки відповідний етап. Primary: POS ціна/неоднозначність/чернетка, setup/staff SQL pages, історичний inactive працівник зі ставкою77.89/відсотком2.345, 200 рядків двома ≤200-ID пакетами без 200 option-page GETs, 100 компонентів рецептури, React customer filter. Tail: receipt/cross-store transfer/cash target/expense/shift fields, 503 selected-ID retry зі збереженням frozen price та нової кількості. Race: три пізні opening reads після переходу на іншу сторінку. Primary7 і tail9 мають окремі PASS reports; фінальний layout2 повторений лише для dialog-boundary CSS. Layout: dialog footer keyboard, popup та видимий input на 320 px і справжньому Chrome200% (1440 window/720 CSS viewport/dpr2).
- Artifact directory: `/tmp/tsukenya-directories-proof/`; report-primary.json (7), report-tail.json (9), report-race.json (1 група/3 cases), report-layout.json (2), sale-1440/sale-320 та modal-paging-320/modal-paging-200 PNG. Chrome200% pixels отримані CDP capture, оскільки Playwright capture цього zoom context давав blank artifact.
- `npm run build:frontend`, affected frontend ESLint, `git diff --check` PASS. Обидва Chrome запуску використовують CHROME_PATH або platform resolution; Linux виконання цього пакета локально не перевірялося. Повної регресії та deployment не було.

## Відкритий суміжний обсяг

Global portal/runtime catalogue subscription та `/api/state` залишаються окремим пакетом. Native ERP не читає `/api/erp/state` і не завантажує повні E/P arrays; global shell `/api/state` може залишатися великим. Ізольовані 1/5/10 posting/detail measurements — окремий capacity пакет. Цей доказ не є VPS load benchmark, p95 або завершенням усього B24.


## Root integration після metadata

PR57 compact portal прийнято в main4eff103. Описаний вище global `/api/state` залишок стосувався вихідної бази directory proof; при інтеграції реальна оболонка використовує metadata. Повна B24 міграція звітів і resource/capacity докази лишаються відкритими.

Root незалежно відтворив unauthorized entity edit для чужого магазину, складу, рахунку й працівника. `entity_save` перевіряє refreshed actor та store scope перед revision/save; створення магазину дозволено лише власнику мережі. Чотири `tests.test_entity_scope` на ізольованому PostgreSQL PASS. Контрагенти зберігають чинний shared contract.

Native directory script додано в явний full entrypoint; цього прогону не запускали. Адитивні manifest/script конфлікти узгоджено зі збереженням metadata PortalApi, trading та native conflict entries.

Root integrated TypeScript/Vite build і layout-only native320/200% PASS після узгодження entries; `/tmp/tsukenya-root-directory-integration/report-layout.json` та actual PNG перевірені. Primary/tail business сценарії з незмінними inputs повторно не запускали. Final popup footer/hint містяться у видимому intersection(dialog, viewport).
