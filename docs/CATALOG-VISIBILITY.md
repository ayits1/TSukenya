# Активні та приховані товари

Пакет повертає керування прихованими товарами в інтегрований React-каталог `#operations/products` за [issue #1](https://github.com/ayits1/TSukenya/issues/1). Товар не видаляється при приховуванні; його історія, рецептури та облікові зв’язки зберігаються.

## Контракт і права

- `GET /api/v1/catalog/products?visibility=active|hidden`: окремий режим, за замовчуванням активні. Чинні пошук, залежні facets, розмір сторінки 10/20/50 та пагінація застосовуються всередині вибраного режиму. Відповідь явно містить `visibility`; кожний Product має строгі логічні `hidden` і `canEdit`.
- `GET /api/v1/catalog/products/{id}?includeHidden=true`: лише явне читання для редактора/відновлення. Звичайний detail GET, вибір цінників та фільтр переоцінки залишаються активними. Поточний actor, cost redaction і контекст магазину перевіряються у readonly snapshot. GET не пише дані чи аудит.
- `PATCH /api/v1/catalog/products/{id}/visibility`: тільки `{revision, hidden}`. Поточна роль owner/manager/warehouse перевіряється після LedgerLock; помилковий payload відхиляється. Застаріла revision → 409, відсутній товар → 404 без відновлення запису. Метадані видимості змінюються окремо від цін і полів форми; аудит фіксує before/after і автора. Незмінний стан з поточною revision не створює зайвого запису/аудиту.
- Звичайний product PATCH не приймає `hidden`; він зберігає стан наявного товару. Фізичний DELETE лишається чинним guarded endpoint: поточна revision, актуальна роль, заборона для облікових/рецептурних/акційних зв’язків. Нового дозволу видаляти історію немає.

## Редактор та невизначений результат

Перемикач «Стан товарів» лишається змонтованим під час зміни режиму, завантаження та помилки. Попередні активні рядки не показуються під режимом прихованих. Скидання інших фільтрів зберігає режим.

Редактор показує поточний стан і окремі кнопки «Приховати товар»/«Відновити товар». Це кнопки `type=button`: навіть незавершена/некоректна нова назва не перетворює дію на збереження всієї форми. Підтверджений ACK має той самий ID, потрібний стан, актуальну revision/права й незмінні редаговані метадані. Він оновлює baseline та список, зберігаючи dirty draft; повне збереження залишається окремою дією.

409 або невизначений ACK блокує наступні записи видимості, Save і DELETE. Не відправляємо запит автоматично повторно, не перемикаємо режим каталогу й не стверджуємо успішне приховування. «Порівняти зміни» читає точний ID з `includeHidden=true`; 503, некоректний DTO/чужий ID чи нові обмежені права зберігають чернетку. Спільне three-way порівняння зберігає незалежні серверні зміни, а конфлікт того самого поля потребує явного вибору. Стан видимості сервера показаний окремо і не входить у draft ціни/назви. Apply оновлює тільки локальний baseline/draft; будь-який наступний Save або hide/restore — окрема явна дія. Повторний 409 знову вимагає current read. Cancel порівняння не записує дані й не дозволяє використати стару revision.

Revision видимості анулює поточний label proof; прихований SKU відхиляється prepare. Після відновлення потрібен новий proof. Приховування не перепроводить бухгалтерські документи, не змінює ціни й не генерує нову бізнес-політику.

Чернетка й стан recovery живуть у відкритому редакторі. Цей пакет не обіцяє зберігання незбережених полів після повного browser reload; приховані записи лишаються доступними через серверний список.

## Цільові докази

Усі дані синтетичні, сервери/БД локальні та ізольовані. Продакшн/VPS/Google Sheet не використовувалися.

- SQLite: 6 API сценаріїв + окремий labels/pricing boundary = 7 PASS. PostgreSQL `127.0.0.1:61144`, власна `test_tsukenya_hidden_catalog_review`: ті самі 6 + boundary + конкурентний hide = 8 PASS окремими відповідними stages. Перші 6 не повторювались після додавання незалежних тестів.
- Unit `visibility.test.ts`: 4 PASS — coerced/missing flags, cross-mode list, metadata-only payload, wrong/unchanged-revision/changed-metadata ACK, точний recovery ID і явний includeHidden.
- Storybook `CatalogHidden.stories.tsx`: LostVisibilityAckKeepsDraft + EmptyHiddenList PASS; ModeKeyboardAndRequestError PASS окремим affected stage після виправлення фокусу. Незмінні перші дві історії повторно не запускались.
- `tsc`, Vite build, targeted ESLint/Prettier і `git diff --check` PASS.
- Реальний Django + React/Chrome: `/tmp/tsukenya-hidden-proof/report.json`, `report-tail.json`, `report-layout.json`. Commit→lost ACK, readonly503/retry/cancel/localApply, незалежний barcode, Restore без form write, separate Save, pending/error/empty mode, зовнішні hide/restore409, same-field keyboard choice, invalid newer input, unrelated-ID refusal, current revoked role. Layout 1440/320, touch44 та відсутність горизонтального overflow. PNG: `hidden-1440.png`, `hidden-empty-320.png`, `loading-320.png`, `editor-320.png`, `actions-320.png`.

Відтворення вузького native stage:

```sh
PYTHON_BIN=/path/to/isolated/python node tests/catalog-hidden-ui.cjs
PYTHON_BIN=/path/to/isolated/python QA_HIDDEN_STAGE=tail node tests/catalog-hidden-ui.cjs
PYTHON_BIN=/path/to/isolated/python QA_HIDDEN_STAGE=layout node tests/catalog-hidden-ui.cjs
```

Для сервера `manage.py test tests.test_catalog_visibility`; PostgreSQL-only concurrency пропускається у SQLite. Фізичний мобільний пристрій, screen reader і production capacity у цьому пакеті не перевірялися. Повний regression не запускався.

## Незалежне рев’ю та інтеграція

Виправлено blocker: DTO з `canEdit=true` потребує справжніх cost/markup. Відсутні
приватні умови більше не стають вигаданим нулем у baseline; readonly cashier DTO
з null лишається допустимим. Metadata ACK додатково звіряє reference IDs: інша
прив’язка довідника не приймається навіть із незмінною назвою.

List і обидва detail GET читають конфігурацію, facets, count/items та поточного
actor в одному READ ONLY repeatable-read snapshot. Root PostgreSQL 2 PASS:
відкликана кешована роль/приватні поля і справжнє конкурентне restore між count
та page. Unit: п’ять успішних cases та окремий affected ACK case після уточнення
очікуваного українського повідомлення; tsc/build/ESLint/Prettier PASS.
Інтегрований actual редактор 320px: touch44/no overflow PASS,
`/tmp/tsukenya-root-hidden-layout/report-layout.json`; actions-320.png переглянуто.
Незмінні author API/Storybook/native proofs використано повторно. Незалежний
повторний source review не виявив блокерів.

Native harness ізолює owner/DB/settings env і чекає зупинки сервера перед
видаленням тимчасової БД. У test:full зареєстровані main/tail/layout по одному;
перевірено лише dry-run plan і syntax, повний набір не запускався.

Exact-head CI виявив одну стару api unit fixture із null cost/markup, але
canEdit=true. Уточнено її реальну readonly роль; повторено лише affected
decimal/redaction case, PASS. Нове правило strict decoder збережено.

PostgreSQL CI також виявив старі HTTP fixtures із зовнішньою транзакцією Django
TestCase. Strict catalogue GET закономірно відхилив її READ COMMITTED/writeable
контекст. Відповідні класи переведено на TransactionTestCase; для облікових
API-сценаріїв додано opt-in TransactionApiFixture зі спільною setup/HTTP логікою.
Інші AccountingFixture/ApiFixture сценарії зберігають свій попередній режим.
Root PostgreSQL 13 PASS3.570s: представник кожного мігрованого класу, незмінений
draft API fixture і явна відмова list/default/explicit detail усередині
несумісної зовнішньої транзакції. Strict production snapshot не змінено;
новий нормальний standalone GET успішний і не пише аудит. Решту підтверджених
proofs не повторювали; автоматичні exact-head CI є обов’язковими перед merge.
