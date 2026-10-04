# B24: компактний стан порталу й явні читання каталогу

## Межа реалізації

Django оболонка читає `/api/v1/portal/state` замість повного `/api/state`. Контракт `portal-metadata-v1` містить тільки tasks, ideas, expenses, settings/main, project/state, їх чинні permissions/revisions, роль, мережеву область, CSRF, labelRevision і scoped stateVersions. Старий `/api/state` збережений для сумісних зовнішніх клієнтів і цільових тестових assertion helpers.

Runtime декодує новий контракт без legacy fallback. Невідомий/відсутній contract, доданий products чи некоректний validator відхиляються до зміни кешу, ролі та CSRF. ETag має окремий namespace `tsukenya-portal-v1`. Незмінений GET використовує ті самі durable domain versions і ≤4 SQL; змінений metadata GET не читає products або products × stores. GET нічого не записує. Collection products у Django runtime явно недоступна для onSnapshot; порожнього удаваного каталогу чи першої сторінки замість повного каталогу немає.

## Фактичні споживачі

| Споживач | Нове читання / поведінка |
| --- | --- |
| `server/runtime.js` і глобальні підписки `app/portal.js` | Compact metadata; products subscription тільки в ізольованому Artifact режимі |
| Операційний огляд | Lazy `/api/v1/portal/overview`: кількості, дата підсумку, plannedExpenses тільки network owner |
| «Орієнтир за каталогом» | Lazy `/api/v1/portal/catalogue-model`, лише відкрита вкладка й network owner |
| Фактична маржа останніх 30 днів | `/api/v1/portal/sales-margin`, окремий серверний Decimal розрахунок за B17 accounting dates/storno |
| Масова націнка категорії / пошуку | Поточні React фільтри → frozen `selection` повної вибірки на сервері |
| Прибирання прикладів | Owner-only paged GET examples (30), explicit revision POST examples/delete з immutable UUID receipt |
| Вивантаження всього каталогу | Явне посилання `/api/v1/portal/catalogue.csv`, StreamingHttpResponse; без browser full array/blob |
| CSRF-only managed alerts, monthly budget, initiatives | `/api/v1/session`, strict decoder; initiatives api helper також приймає AbortSignal |
| Невдале завантаження React каталогу / цінників | Явний loading/error, GET-only повтор завантаження; legacy редактор із порожніми даними не активується |
| Google Sheet / Artifact | Серверний режим показує чесну доступність ручного CSV/Excel; чинний Artifact full-array adapter ізольований і збережений |

Native ERP directory/bootstrap міграція виконується окремим пакетом; цей пакет не змінює app/erp.js. Спільна Google-таблиця не читалась і не змінювалась; B22 синхронізація не реалізована цим пакетом.

## Бізнес-формули

Каталожна модель навмисно зберігає **рівну частку товарів**, не зважену структуру продажів: `(salePrice - cost) / salePrice` для кожного видимого не-example товару з додатними cost і salePrice, потім середнє. SalePrice тут — звичайна або стара плоска акційна ціна самого товару; магазинні кампанії не підміняють цей орієнтир. Readonly legacy adapter зберігає finite numeric/comma/prefix читання cost/promotionPrice і grandfather акційні значення старої оболонки; він не послаблює validation записів чи campaign resolver. Fixed + variable — явні legacy місячні суми, не ставки. Break-even = план / середня маржа, daily /30, perStore /budgetStores. Обчислення Decimal з precision40, грошове відображення сервером до копійок ROUND_HALF_UP. Нульовий/від’ємний margin і відсутнє покриття мають окремий стан, без вигаданого позитивного результату.

Порогова дата ціни — **строго понад staleDays ×24 години**, не лише календарний день. ISO date-only відповідає UTC; ISO datetime без timezone — Kyiv; datetime із timezone використовує його offset. Невідома/некоректна дата вважається застарілою. nextChangeAt дає повтор читання після переходу порога навіть без запису. Довільні не-ISO рядки, які окремі JS рушії могли приймати через Date.parse, не інтерпретуються як підтверджена дата.

Факт 30 днів — окрема **зважена валова маржа** `gross / revenue` з проведених sale/customer_return, чинних period_documents/period_sign/voucher_contributions та Київського дня сторно. Від’ємний/нульовий виторг або margin показано явно. План не видається за факт; payout не є accrual.

## Масові ціни, повтори та права

`filtered_products` спільний для paged React каталогу й frozen pricing selection: q/name/barcode, type/category/pack, effective promotion і ERP store context. Категорію користувач обирає в чинному React ComboBox, після чого «За поточними фільтрами» охоплює **всі** matching товари, а не поточні20. Preview показує кількість/фільтри/магазин. Legacy UI було плоским product.promotion; новий descriptor використовує вже чинну React campaign-aware semantics і явно передає цей контекст.

Ліміт1000, refusal більших вибірок, старий ids/null API, приховане глобальне округлення, manual-price skip/reset, fallback pinning виключених товарів, owner/current-actor перевірки, idempotency receipt/audit і frozen lost-ACK payload збережені. Новий selection snapshot включає каталог/налаштування, фільтр, точні matchingIDs, попередні ціни та Kyivday; зміна кампанії/вибірки після preview вимагає повторного огляду. Розрахунок resolver до/після плану пакетний; normalise_product отримує old_config, тому немає settings запиту на кожен рядок.

Прибирання прикладів включає приховані examples. Кожен рядок має explicit revision; використані в accounting, рецептах, production чи історії акцій товари захищені чинним legacy_mutation. Receipt з тим самим UUID/body повертає первісний результат без другого delete/audit. Malformed/lost ACK не очищає pending intent; повтор надсилає точно той самий пакет. POST success + metadata GET failure не стає помилкою запису; користувач повторює тільки GET.

Уже відомі legacy task/idea/expense single-field lost-update обмеження не виправлені цим performance пакетом: permission/revision поля збережені для B06, але це не новий If-Match guard для всіх цих мутацій.

## Експорт і ресурсні межі

CSV з поточними campaign-aware цінами — один PostgreSQL REPEATABLE READ / READ ONLY snapshot. Права/активність актуального користувача повторно читаються перед першим yield. Касир не отримує cost/markup; includeHidden дозволено тільки owner. Formula/control-prefix клітинки захищає чинний csv_format.guarded; назви/штрихкоди/ID зберігаються. Iterator/batch100 не створює повного JSON або browser Blob, а close/cancel закриває транзакцію.

Streaming export утримує довгу RR транзакцію до завершення споживання; це ресурсне обмеження, не доказ необмеженої місткості. Summary/model — **O(N)** серверний iterator з обмеженою пам’яттю, не O(1). Pricing зберігає чинний повний catalogue snapshot для review; ліміт запису1000 не є SLA для довільного великого каталогу. Tasks/ideas/expenses compact arrays ще мають власну можливу подальшу пагінацію.

## Цільові докази

- Початкові9 `tests.test_portal_metadata` на isolated PostgreSQL: compact changed200 без product/promotion scan, ≤4SQL304/no write, scope/privacy, Decimal/equal-weight/promotion/stale boundary, paged hidden examples/revision/exact retry, CSV formula/role/RR snapshot/cancel, повний500SKU filtered pricing <20 SQL, кампанія/revision recheck/commit retry,1001 refusal.
- Додані окремі PG tests (лише нові сценарії): `test_paged_catalogue_uses_same_full_filter_helper`, `test_sales_margin_uses_accounting_period_reversal_and_exact_money`, `test_cleanup_protected_history_and_retry_does_not_duplicate_audit`, `test_summary_preserves_grandfather_legacy_read_numbers_and_nullable_stale` (разом зі зачепленим stale/Decimal parity test). Вони перевіряють catalogue page2, Kyiv сторно старого документа в30-daywindow, decimal outputs, збереження використаного товару й один audit при повторі.
- PureVM: portal-metadata-contract, runtime-recovery, runtime-managed-refresh, runtime-create-key, runtime-conditional, catalog-pricing-contract. Cached role/CSRF збережені після missing/wrong contract/extra products; confirmed-write barrier і GET-only retry працюють. Незалежне root VM рев’ю strict boundary також PASS.
- TypeScript/build frontend PASS; prettier тільки зміненого catalog-entry. Monthly budget decimal fixture адаптована до additive export і targeted PASS.
- Actual Chrome isolated18246: cleanup malformed ACK → enabled keyboard exact retry → server-clamped page; `QA_PORTAL_FROM=products` — full45 matching зі сторінки20, lazy model, Decimal UI320/1440, actual native POST200→GET503→GET-only retry1POST. Жодного `/api/state` з actual migrated shell/consumer network.
- `QA_PORTAL_FROM=module` / shared portal-module-case — unavailable catalogue/labels не активує fake empty editor; keyboard reload тільки GET; React stored hostile text escaped, opened revision price-preview blocks Save і stale PATCH409 зберігає remote cost.
- Obsolete regression fixtures оновлені до нового endpoint/DTO/cleanup protocol; їх незмінені широкі сценарії не запускались повторно. Повна регресія не запускалась, місткість production/VPS/Google Sheet не перевірялась.

Команди вузьких сценаріїв:

```sh
PYTHON_BIN=/tmp/tsukenya-review-venv/bin/python node tests/portal-metadata-ui.cjs
QA_PORTAL_FROM=products PYTHON_BIN=/tmp/tsukenya-review-venv/bin/python node tests/portal-metadata-ui.cjs
QA_PORTAL_FROM=module PYTHON_BIN=/tmp/tsukenya-review-venv/bin/python node tests/portal-metadata-ui.cjs
node tests/portal-metadata-contract.cjs
```

Браузерний harness створює власну SQLite, видаляє DB env і зупиняє свій сервер; mutation не на production. PostgreSQL перевірки використовували тільки tsukenya_portal_metadata на локальному isolated61144. Нема схеми/migration/posting/ROLE_KINDS змін.

## Поточні файлові профілі каталогу

`catalogue.csv` використовує [схему каталогу 1](CATALOG-SCHEMA.md): 20 стовпців для приватних ролей, 18 для касира. Збережені ручні/локальні умови розділені з розрахованими regular/effective цінами й кампаніями. GET та CSV зберігають чинні scope/current-actor/RR/streaming правила; шаблон імпорту має 14 стовпців і окремий авторизований download. Artifact/історичні профілі лишаються сумісними проєкціями, не поточним Django DTO.
