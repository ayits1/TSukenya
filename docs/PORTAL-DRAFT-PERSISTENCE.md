# Задачі, ідеї та видалення статей витрат: локальне відновлення B06

База пакета: `9f2adf8ad97332a608866fe51e9c00f936c96cbd`. Це звичайні Django portal consumers, а не керовані сповіщення, проєктні задачі або Artifact sync. Дані перевірок ізольовані; розгортання та повна регресія не виконувалися.

## Реальні точки входу

| Consumer | Покриття |
| --- | --- |
| `#operations/work`, `addWork` | Назва й дата як raw draft; CREATE із незмінними UUID та першим тілом |
| `#development/tasks`, `addTask` | Назва й етап розвитку, включно незавершеним введенням |
| `#development/ideas`, `addIdea` | Назва, подальше повне редагування опису й рішення |
| З обраної ідеї → окрема звичайна задача | Перший CREATE зберігає `ideaId`, UUID та ціле початкове тіло |
| `LegacyEditors.edit/update` звичайної задачі/ідеї | Повний редактор, inline status/reaction; UPDATE після 409 або невідомого ACK відновлюється читанням |
| Чинний DELETE задачі або статті витрат | Заморожена спостережена ревізія; після невідомого результату немає повторного DELETE |

`portal-draft-recovery.js` завантажується перед `legacy-record-editor.js` і `portal.js`. Native entry додає `NativePortalPersistence` до чинних exports. Codecs `native-portal-record-v1` та `native-portal-delete-v1` зареєстровані в наявному `NativeDraftRecovery`; збережені business permissions чи credentials у payload не копіюються.

## Межі відновлення

- Raw поля захоплюються до валідації; quota failure забороняє бізнесовий fetch. Відновлення після reload — явна дія користувача в тому самому tab/session.
- Перший CREATE зберігається до fetch. Окрема кнопка `type=button` повторює саме його UUID/тіло навіть при новіших невалідних required полях. Пізніші 4xx після невідомого результату не очищують intent.
- Позитивна guarded identity квитанція зберігає підтверджений ID до незалежного current GET. Це не нова UPDATE baseline. Після GET503/reload CREATE більше не повторюється.
- UPDATE не повторюється автоматично. Current GET, чинні права й identity → спільне three-way порівняння → локальне Apply → окремий Save з поточною ревізією. Для задач назва/статус/дата/етап, для ідей назва/опис/рішення зберігають чинну семантику.
- DELETE missing — спостереження відсутності, а не доказ автора видалення. Немає resurrection чи replay. Якщо запис існує та змінився, Apply приймає лише поточну baseline; потрібне нове окреме підтвердження DELETE. Definite успішний DELETE закриває редактор та прибирає його локальний запис.
- Поточний GET `records/recovery-context` працює в READ ONLY RR із fresh actor. Missing manager task потребує серверного scope witness квитанції; клієнтський магазин не доводить доступ. Старі відсутні задачі без witness відмовляються без вигаданої baseline.
- Приватні поля та заголовок приховані до current grant. 503/malformed read зберігає локальні дані за закритою формою й явним GET retry. Зміна session/role/scope та current403 проходить чинну P0 revalidation. Запізнілий canceled/obsolete401 перевіряється до decode/global invalidation.
- Inline directory authorization не перериває відкриту native modal. Після її закриття поля inline знову проходять авторизацію. Route change зберігає raw для явного відновлення; pending write блокує вихід.

Receipt mutation path, гроші, posting rules, серверні права, managed alerts та initiative actions не змінені. Editable expense recovery використовує свій уже чинний codec; новий expense adapter охоплює лише наявний DELETE. Нова кнопка видалення ідей не додається.

## Цільові докази

`tests/portal-draft-reload-ui.cjs` має окремі stages через `QA_PORTAL_DRAFT_FROM`. Browser — bundled Chromium, `headless:true`, own matching frontend build і disposable SQLite. PostgreSQL — окрема тестова БД, не production.

| Stage / перевірка | Фактично перевірено |
| --- | --- |
| `raw`, `raw-tail` | Порожня required назва/дата/етап, cold explicit Restore; три ordinary entry points; route retention без business writes |
| `create`, `later` | Committed CREATE/lostACK, invalid newer title, frozen exact retry після пізнішого 400; ID-before-current503/reload, один створений запис |
| `edit`, `edit-unknown` | Реальний UPDATE409 і committed lostACK PATCH; newer raw/reload, shared Apply без PATCH, окремий Save |
| `delete`, `delete-conflict`, `expense-delete` | Реальні task/expense DELETE lostACK; current missing без replay; stale DELETE409 → Apply без DELETE → окреме підтвердження |
| `inline` | Реальні task status, idea reaction та idea→ordinary task lineage |
| `privacy` | Quota-before-fetch, warm503 private hide/raw retained, public read retry, реальне owner→manager current403 |
| `layout`, `opening` | Shared keyboard comparison 1440/320, 44px radios, second409; canceled current GET і obsolete opening ignored-abort401 без session invalidation |
| `PortalDraftContextTests` | PostgreSQL 4 PASS: READ ONLY/no audit, cached actor/current role/scope/is_active, managed readonly, server witness для missing manager task |
| `portalPersistence.test.ts` | 4 PASS: strict raw/baseline/intent/resource/path/body binding, confirmed ID окремо від baseline, whitelist без privileges |
| Node | Чинні `runtime-create-key.cjs` та `legacy-create-identity.cjs` PASS; receipt transport/oracle не змінено |

Core stages виконані окремими цільовими запусками, не одним повним regression pass. Перші невдалі спроби та affected retries збережені в локальних logs/artifacts; PASS не приписується невиконаним старим family stages. Зокрема unknown UPDATE виявив suspension race при одночасному metadata refresh; фінальний affected stage перевірив повторну авторизацію й окремий Save.

### Старі fixtures

- `legacy-create-identity-ui.cjs` (wrapper `runtime-create-key-ui.cjs`): obsolete RAM recovery selectors замінені actual P0 inline/dialog controls. UUID/ціле тіло/invalid newer fields/known original/malformed identity/tombstone assertions збережено. Explicit recovery спершу читає квитанцію; підтверджений UUID не потребує другого бізнесового POST.
- `legacy-records-ui.cjs`: actual P0 gates, public retry/cancel, shared comparison, status readonly; write counters беруться після завершення першої спроби. Приватне редагування після actual403 не заявляється.
- `portal-collections-ui.cjs` `tail`: cross-page frozen intent → identity-first confirmation, один запис, zero repeated CREATE. Інші collections/managed/summary stages не змінено.

Shared UI компоненти/three-way алгоритм не змінювалися: використовуються чинні NativeConflict fields та React Aria controls. Storybook повторно не запускався; для нового actual consumer виконано meaningful keyboard/320 geometry proof. Фізичний print, credentials/settings, destructive actions інших сімейств, cross-tab/device persistence, повна B06 P1/P2/P3 матриця та повна CRM React migration не оголошуються завершеними цим пакетом.

### Артефакти та точні хвости цієї доставки

Core reports/PNG: `/tmp/tsukenya-portal-draft-proof/{stage}-report.json`, окремі viewport PNG; `comparison-320.png` переглянуто. PostgreSQL log: `/tmp/tsukenya-portal-context-pg-final.log`; codec log: `/tmp/tsukenya-portal-codec-final.log`; matching own build: `/tmp/tsukenya-portal-build-final.log`. Фінальні lint/format/static-policy logs мають префікс `/tmp/tsukenya-portal-`.

Compatibility виконано лише зачепленими хвостами:

| Команда/прапорець | Результат і межа |
| --- | --- |
| `LEGACY_CREATE_STAGE=primary LEGACY_CREATE_FROM=tasks` | PASS: operations + development task CREATE, invalid newer title/later400/frozen body/key/one record. `/tmp/tsukenya-portal-compat-primary/primary-report.json` |
| `QA_LEGACY_ACK_ONLY=1` | PASS: null/array-revision ACK refusal, GET-only review, no repeated PATCH, exactly-one confirmation/actual DELETE200. `/tmp/tsukenya-portal-compat-ack/ack-report.json` |
| `QA_COLLECTIONS_FROM=tail` | PASS: cross-page frozen intent, one authoritative task, identity-first recovery/no second POST. `/tmp/tsukenya-portal-collections-tail.log` |
| `LEGACY_CREATE_STAGE=boundary` | PASS: unavailable transport remains unknown; wrong original terms actually intercepted/refused; canceled late identity; confirmed expense current scoped denial. `/tmp/tsukenya-portal-compat-boundary/boundary-report.json` |

Старі `primary` idea/expense/tombstone, `tail`, `layout` та решта legacy-records stages адаптовані source-only, без повторного запуску цілого старого сімейства. Їхні функціональні межі мають нові targeted core докази (`inline`, `expense-delete`, `create`, `privacy`, `layout`); це не окремий PASS кожного старого stage. Default wrapper/full registry не отримали skip; повний explicit запуск надалі виконує всі свої stages.

Початкові FAIL logs збережені: `/tmp/tsukenya-portal-edit-unknown{,-final,-final2,-final3}.log`, `/tmp/tsukenya-portal-compat-{primary,ack,ack-final,ack-final2,boundary,boundary-final,boundary-final2,boundary-final3}.log`. Partial reports містять пройдені prefix assertions до помилки; їх не названо whole PASS. Фінальні retries перевіряли тільки відповідний stage. Fixture repairs: завершений PATCH перед sampling counter; завершений DELETE замість transient private hide; реальний malformed interceptor completion; current-read CTA після confirmed identity; explicit reload між незалежними fixture cases.

## Інтеграція з прийнятою основною гілкою

Пакет інтегровано поверх прийнятого `9ee4d20` (PR114). Збережено React Reports
із PR113, відмову від старого ABC entry та trading freshness із PR114. Конфлікти
у loader і full runner вирішені додаванням нового модуля та його stages; чинні
модулі й scrub-параметри не замінюються старою версією.

Source codec, recovery adapter і read-only context байт у байт відповідають
перевіреному delivery. Їхні незмінені цільові докази повторно використовуються.
Для нового складу модулів виконано matching build із перевіркою типів і окремий
реальний CREATE recovery сценарій. `test:full -- --plan` перевіряє лише перелік
етапів; повна регресія в цій інтеграції не запускалася.
