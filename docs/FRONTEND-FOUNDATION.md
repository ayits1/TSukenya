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
