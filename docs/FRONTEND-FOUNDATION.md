# Основа нового інтерфейсу · 01.10.2026

Новий контракт оболонки та desktop-компонування: [Desktop workspace](DESKTOP-WORKSPACE.md).

## Що вже додано

`frontend/` — npm workspace із React 19, TypeScript, Vite та Storybook. Каталог і студію цінників інтегровано в чинну оболонку; деталі — [CATALOG-MIGRATION.md](CATALOG-MIGRATION.md) та [LABEL-STUDIO.md](LABEL-STUDIO.md). Лабораторія компонентів і Storybook використовують синтетичні дані; робочий каталог записує дані через Django. Облікові екрани залишаються в `app/`.

- Спільні `Button`, `TextField`, `MoneyField`, `Select`, `ComboBox`, CSS-токени. React Aria керує взаємодією складних контролів; оформлення належить проєкту.
- `ComboBox` має два режими пошуку. За замовчуванням (`local`) повний локальний список фільтрується введеним текстом. `search="server"` показує результати сервера без повторного фільтра підрядком (слова в іншому порядку, штрихкод), тримає вибраний варіант для підпису поля та має стан «Шукаємо…». Історії: `Server Search Results`, `Server Search Loading`.
- Застосунок і Storybook імпортують однакові компоненти та CSS. Приклади не мають окремої реалізації контролів.
- Строгий TypeScript, ESLint з правилами React, Prettier, Vitest для API-межі та Storybook/Vitest для браузерної поведінки.
- Playwright: Chromium/WebKit, 1440 і 390 px, додаткова перевірка 320 px, збільшений текст, високий контраст, геометрія стрілок, пошук/скасування та фокус. Axe перевіряє доступність видимих компонентів.
- GitHub Actions автоматично виконує швидкі frontend-перевірки для відповідних змін. Повний набір із PostgreSQL і браузерами запускається окремо вручну; Dependabot готує оновлення залежностей. Workflow почне працювати після публікації цих файлів у GitHub.

## Запуск

Рекомендована версія Node — 24.20.0 із `.nvmrc`, npm 11. Локально також підтримується Node від 24.18.0 у межах 24.x. QA-образ фіксує Node 24.20.0. Всі команди нижче — з кореня репозиторію; один `package-lock.json` обслуговує обидва workspace.

```sh
npm ci
npm run dev:frontend       # http://127.0.0.1:5173
npm run storybook          # http://127.0.0.1:6006
```

Vite проксіює `/api` та `/health` на локальний Django `127.0.0.1:8080`. Не використовуйте VPS як тестовий сервер. API-клієнт має контракти health та `/api/v1/` каталогу й цінників. OpenAPI зберігається в `contracts/`; генерація — `npm run generate:api`. Облікові API залишаються серверними.

## Перевірки

Щоденний режим — цільові перевірки за [DEVELOPMENT-MODES.md](DEVELOPMENT-MODES.md). Список нижче — доступні інструменти, а не вимога запускати все після кожної правки. Повна регресія викликається окремо: `npm run test:full`.

```sh
npm run check:frontend    # типи, lint, формат
npm run test:frontend     # валідація API-відповідей, HTTP-помилки, CSRF, скасування
npm run test:components   # історії Storybook та клавіатурні сценарії
npm run build:frontend
npm run build:storybook
npm run test:visual       # зібраний Storybook + Playwright + axe + порівняння PNG
npm test                  # попередні сценарії синхронізації
```

Для локальних браузерів: `npm exec -- playwright install chromium webkit`. На macOS та Linux конфігурація використовує тільки bundled Chromium Playwright у headless-режимі; channel/executablePath і системний Chrome заборонені для автоматичних перевірок. Канонічні візуальні зразки генеруються в Linux Docker, описаному нижче. Зразки з іншої ОС не підходять для CI через відмінності шрифтів і браузера.

### Візуальні зразки

`frontend/Dockerfile.qa` фіксує середовище Playwright, Node та залежності. `scripts/frontend-qa.sh` збирає образ і запускає всі перевірки основи; режим `update` створює нові PNG у `frontend/tests/baselines/linux/`.

```sh
bash scripts/frontend-qa.sh update  # створити або свідомо оновити зразки
bash scripts/frontend-qa.sh check   # порівняти з відстежуваними зразками
```

Перед прийняттям нових PNG перегляньте їх та різницю. Зміна зразків не замінює виправлення дефекту. Тести самі не оновлюють зразки у звичайному запуску. Точна перевірка фізичного друку та перевірка зі скринрідером залишаються окремими ручними діями.

## Межі коду

```text
frontend/src/app/             # оболонка та підключення модулів
frontend/src/features/        # component-lab, catalogue та labels
frontend/src/shared/ui/       # бізнес-незалежні компоненти та токени
frontend/src/shared/api/      # транспорт, декодування, статуси помилок
frontend/.storybook/          # документація й браузерні сценарії
frontend/tests/               # геометрія, доступність і PNG
```

Компоненти не викликають API самостійно. Серверні дані та запити належать модулю; локальний стан форми — її редактору. Публічні компоненти мають невелику явну модель параметрів. Не додавайте перемикачі для десятків несумісних режимів.

## Наступні кроки

1. Початкові захисні виправлення синхронізації та пояснення моделі беззбитковості виконано; див. CATALOG-MIGRATION.md. Серверну Google-інтеграцію будувати з журналом, ідемпотентністю та координацією запусків.
2. Контракти `/api/v1/` каталогу та макетів реалізовано з версіями редагування та генерацією типів з OpenAPI. Наступні — облікові модулі.
3. Каталог і конструктор перенесено зі збереженням макетів, URL, фізичних розмірів і переддрукового перегляду. Спільні компоненти імпортуються з цієї основи.
4. Переносити торговельні модулі окремими релізами з регресіями, резервною копією та відкатом.

TanStack Query додано для каталогу та студії цінників. React Hook Form і Zod — коли з'являться складні форми й узгоджені схеми валідації. React Hook Form і Zod поки не встановлені. Для росту також потрібні вимірювання запитів, журнал помилок, перевірка відновлення резервних копій та навантажувальні сценарії конкурентних кас; вони є окремими задачами.

## Підтримка

Версії пакетів і lockfile зафіксовано. TypeScript обрано сумісний із поточним ESLint parser; номер `latest` не є критерієм сумісності. Dependabot має готувати згруповані оновлення з проходженням тестів. Node оновлюється узгоджено в `.nvmrc`, engine та Docker-образі; Playwright — разом з QA-образом і свідомим переглядом зразків.

Навичка `.agents/skills/tsukenya-development/` зберігається в репозиторії, тож її правила версіонуються разом із кодом. `AGENTS.md` забезпечує явний маршрут до неї для наступних сесій. Глобальну конфігурацію Codex не змінено.

### Джерела

- [Storybook React/Vite](https://storybook.js.org/docs/get-started/frameworks/react-vite)
- [Storybook Vitest](https://storybook.js.org/docs/writing-tests/integrations/vitest-addon)
- [React Aria ComboBox](https://react-aria.adobe.com/ComboBox)
- [Playwright: порівняння зображень](https://playwright.dev/docs/test-snapshots)

## Результати перевірки основи

01.10.2026: типи, lint і формат; збірки React та Storybook; 12 API-перевірок; 6 Storybook-сценаріїв; 32 Playwright/axe-сценарії на macOS та ті самі 32 у фіксованому Linux/amd64 QA-образі. Канонічні PNG створено, переглянуто та перевірено звичайним запуском без оновлення. На ізольованій PostgreSQL 18 пройшли всі 23 серверні тести, включно з конкурентними проведеннями. Окремо перевірено React lab на 1440, 390 і 320 px без помилок виконання.

GitHub Actions і Dependabot додано як конфігурацію; віддалений запуск ще не відбувався. Lab не замінює виробничий CRM; каталог і цінники перенесено окремо, див. CATALOG-MIGRATION.md та LABEL-STUDIO.md.

## CRM межа · 04.10.2026

Клієнтську базу на `#trade/customers` перенесено на React/TypeScript із TanStack Query та окремим OpenAPI `contracts/crm.openapi.json`. Список/аналітика мають серверний paging і рольовий scope. Створення/редагування контакту та історія залишаються чинними native діалогами. Торговельні модулі загалом ще змішані; деталі, цільові докази й межі — [CRM-CUSTOMERS.md](CRM-CUSTOMERS.md). Це кодова інтеграція, не доказ deployment.

## Фільтри довідників у торговельних формах · 04.10.2026

React bridge позначає замінений native label класом `trade-directory-field`.
Спільний toolbar розподіляє ширину між цими полями та звичайними полями дат;
на вузькому екрані поля стають в один стовпець. Mobile flex-basis стосується
лише прямих полів toolbar, щоб внутрішній React label не створював порожній
проміжок над контролом. Paged popup має читабельну мінімальну ширину з
урахуванням меж viewport і native dialog.

Цільові докази: production tsc/Vite build, scoped ESLint, Storybook
`CompactTriggerPagination` (вузький trigger, pager, Enter/Escape/focus),
`tests/directory-toolbar-ui.cjs` (actual табель/касові зміни,1440/320px,
збільшений CSS-текст, server search, native IDs/FormData і read-only history GET).
Сценарій вимірює compound control окремо від текстового input і перевіряє
відстань між підписом та полем. Новий harness використовує ізольований SQLite,
синтетичні довідники й bundled headless Chromium; payroll/business POST не виконує.
Він зареєстрований у full runner; його вузькі FROM/ONLY/PORT/PROOF змінні
очищаються перед повним режимом. Повна регресія не запускалась.

## Вибір місяця бюджету

`MonthPicker` використовує React Aria Dialog/Popover/ListBox: 12 місяців,
перемикання року, «Цей місяць», клавіатура, Escape і повернення фокусу.
Збережені місяці використовують спільний Select та українські назви;
порожній список недоступний і показує «Ще немає бюджетів».

Адаптер `shared/native/budgetPeriod.tsx` зберігає hidden `month`/`past` та ISO
`YYYY-MM` для чинної форми. Вибір не читає й не зберігає бюджет автоматично:
період відкриває кнопка «Відкрити». Legacy sync змінює лише native controls;
React-контроли отримують disabled через props. React roots прибираються під час
перемальовування або фактичного видалення форми, не під час `canLeave()`:
наступний navigation guard ще може скасувати перехід.

Цільові перевірки: `MonthPicker.stories.tsx` та `tests/budget-period-ui.cjs`
(ізольовані дані,1440/320 і збільшений текст, порожні/збережені місяці,
ISO/explicit Open, збереження чернетки, Escape/focus і навігація).
Вузький повтор підтримує `QA_BUDGET_PERIOD_FROM` або `QA_BUDGET_PERIOD_ONLY`;
ці змінні очищаються у full runner. Чинні бюджетні сценарії використовують
`tests/browser-month-picker.cjs` для вибору через справжній UI.

## Орієнтир витрат: компонування рядків · 04.10.2026

Назва й категорія, сума та група дій мають окремі місця у сітці.
На вузькому контейнері вони розташовуються послідовно; «грн» не стискається,
кнопки редагування й видалення не займають колонку суми. Пошук вирівняний
за нижнім краєм поля, пагінація витрат прихована для єдиної сторінки.
Надсилання пошуку Enter переводить фокус на кнопку пошуку: відповідь
може оновити список без очікування виходу з поля.

Цільова перевірка: `PYTHON_BIN=<venv>/bin/python node tests/expense-layout-ui.cjs`.
Ізольована SQLite, bundled headless Chromium: 1440/1024/320 px, текст200%,
довгі назви, порожній список, відсутність перетинів, пошук Enter,
відкриття редактора та Escape без запису. Перевірка включена до явного full runner.

## Компактні торговельні селекти · 04.10.2026

Довідник з однією сторінкою показує лише результати; кнопки переходу та підказка
Alt+PageUp/PageDown з'являються для кількох сторінок. Під час переходу кнопки
залишаються в DOM, щоб зберегти фокус до відповіді сервера. Пошук, повтор після
помилки, порожній результат та очищення вибору збережені.

Працівники у списках мають уточнення магазину й номера запису: однакові імена
не означають, що це дубль для видалення. Фільтр стану касових змін використовує
спільний React Aria Select; прихований native select зберігає значення FormData
та серверний контракт.

У native dialog меню лишається всередині його top layer. Його геометрія
визначається видимим прямокутником діалогу та поля: доступний простір зверху/знизу,
ширина і прокрутка результатів. Це обходить змішування document/dialog scroll
coordinates у позиціонуванні бібліотеки. React Aria керує вибором, Escape і фокусом.
В інших екранах використовується штатне позиціонування React Aria.

Цільові докази: 8 історій DirectoryComboBox, native фільтри на1440/320px,
текст200%, відкриття касової зміни на1440/390px, paging довгого списку в
прокрученому діалозі на320px та масштаб дисплея200%. Дані синтетичні, Chromium
Playwright headless; виробничих записів і повної регресії немає.

## Закупівлі: фактичний React workspace

`#trade/purchases` перенесено на React/TypeScript: bounded журнал, server search/scope,
поповнення з lazy деталями та явними частинами до 200 рядків. Чинні native
редактори/деталі/проведення й receipt → price review працюють через callbacks.
Контракт, цільові докази та межа — [REACT-PURCHASES.md](REACT-PURCHASES.md).

## Продажі та касові зміни

`#trade/sales` використовує реальний React workspace з вкладками документів і
каси, спільними Aria controls, серверною пагінацією та scalar DTO. Native
редактори й облікові дії збережені. Storybook `Trading/Sales`, focused native
підтвердження та межа перенесення — [REACT-SALES.md](REACT-SALES.md).

## Межі асинхронних відповідей

Для приватних екранів перевіряти generation/route/live visibility/abort та
підтверджений session binding після останнього awaited session, після fetch
і декодування, до глобальної401, показу даних чи прийняття ACK. У catch
також відсікати obsolete response до повторної авторизації. Поточний403
повинен приховувати private UI і запускати свіжу перевірку actor/resource.
Зміна сеансу між P0 перевіркою та business/current GET не дозволяє прийняти
чужий результат. Unknown write зберігає frozen intent для явного відновлення.
Apply змінює raw, baseline і intent одним атомарним storage replacement;
quota failure зберігає попередню цілу чернетку. Для повторних дефектів
перевіряти реальні delayed-response та revoked-access сценарії, окремо
від звичайного happy path; не замінювати їх лише strict DTO unit-тестом.

## Звіти

Робочий `#trade/reports` використовує ті самі компоненти React Aria, що й
`Trading/Reports` stories: дати, довідник, вкладки, пошук, paging. Кожна активна
TabPanel має стабільний key відповідного режиму/секції; inactive дані не
зберігаються в прихованих панелях. Таблиці на вузькому екрані стають картками з
підписом кожного поля. Native opener зберігається явно до async відкриття.
Цільова команда: `node tests/react-reports-ui.cjs`; власна ізольована SQLite,
bundled headless Chromium, синтетичні fixture. Межі та reusable результати:
[REACT-REPORTS.md](REACT-REPORTS.md). Storybook не замінює actual callback proof.

## Коротка висота dropdown · 05.10.2026

Shared ComboBox/Select popover обмежує власний overflow, а ListBox є flex child
із `min-height:0` і власним прокручуванням. Коли React Aria зменшує доступну
висоту панелі, рядки не виходять за її рамку. Paged footer зберігає окрему
область; бізнесовий вибір та focus behavior належать чинним Aria controls.

`ConstrainedDropdown` у Controls stories відтворює 160px панель із40 довгими
назвами. До виправлення containment assertion падав; після — PASS разом із
KeyboardSelection та цільовими pager/native-dialog stories. Перевірено
прокручування, пошук/вибір, Escape/focus, geometry1440px і320px зі скороченою
висотою viewport420px, production types/build та scoped lint. Усі браузерні
перевірки — bundled headless Chromium; справжню екранну клавіатуру Android
цей сценарій не запускає. Full regression і бізнесові mutation не виконували.
