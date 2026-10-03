# Залежні фільтри й пояснення журналу · 03.10.2026

## Виправлення

**Каталог і цінники.** Під час запиту нової групи `keepPreviousData` лишає попередні фасети. Раніше користувач міг обрати стару категорію/пакування й отримати хибно порожній список. Категорія та пакування каталогу тепер disabled до актуальної відповіді; категорія Studio теж враховує loading. Група, пошук і скидання лишаються доступними. Сам спільний ComboBox, контракт API та дані товарів не змінені.

**Журнал.** Основний текст пояснює українською роль/стан користувача, кількість інгредієнтів і лічильники групової зміни цін. Невідомі події/структури мають нейтральний текст; неповні payload не отримують вигаданих значень. Оригінальні JSON і action code доступні в native `details/summary`. Не підставляємо поточні назви товарів у історичні записи без історичного snapshot. HTML екранується. Мінімальна ширина назви дії усуває перенесення по літерах на 200%.

## Цільові докази

| Перевірка | Результат |
| --- | --- |
| `CatalogFilters.stories.tsx` — actual Catalog із synthetic gated API | PASS: pending залежні input/toggle disabled, батьківський вибір/пошук/скидання доступні; актуальні варіанти й keyboard commit/cancel |
| `Studio.stories.tsx`, `Loading Products` | PASS: category disabled, group enabled |
| TypeScript / production build | PASS; код друку/рендеру не змінений, попередні фізичні PDF-докази повторно використано |
| `tests/catalog-facets-ui.cjs` | PASS: actual compiled app, справжній Django GET із затримкою відповіді; каталог і цінники на 1440/320; disabled input/toggle, Tab пропускає старі категорії, актуальні фасети, Enter/Escape; 0 page errors / business writes |
| `tests/audit-details-ui.cjs`, content | PASS: 5 ролей, active/blocked, сумісні payload, рецепт 0/2, повні/часткові лічильники цін, unknown/XSS; Tab/Enter/Space/Escape й focus return |
| Той самий helper, layout | PASS: довгий JSON і нерозривний текст, 44 px summary, 1440/390/320, GET503 і keyboard retry; справжні Chrome200% |
| `tests/erp-date-boundary-ui.cjs` | PASS: браузер America/Los_Angeles, фіксований час ±30 с від Kyiv midnight, min/max/step native date, period close today400/yesterday200, work closed/future400/today200, expense closed/future400, payroll draft201, report future range200/reversed400, 320 px |

Дати вже відповідали серверу: виправлення бізнес-правил для них не потрібне. Дозволений майбутній період read-only звіту не обмежено штучно.

Команди з кореня (Python із Django-залежностями):

```sh
npm run test:components --workspace frontend -- src/features/catalog/CatalogFilters.stories.tsx
npm run test:components --workspace frontend -- src/features/labels/Studio.stories.tsx --testNamePattern 'Loading Products'
PYTHON_BIN=/path/to/python node tests/catalog-facets-ui.cjs
PYTHON_BIN=/path/to/python node tests/audit-details-ui.cjs
PYTHON_BIN=/path/to/python node tests/erp-date-boundary-ui.cjs
```

Helpers запускають тільки свої SQLite й локальні сервери: ports18228/18227/18226, scrub DB/PG environment, cleanup після завершення. У датах є реальні ізольовані POST; у facets лише GET; аудит використовує synthetic events. Production і Google Sheet у цих сценаріях не беруть участі. Для повтору тільки content/layout: `QA_AUDIT_DETAILS_FROM=content|layout`; default all. Повний entrypoint включає helpers й очищає mode-прапорець; `npm run test:full` цього разу не запускався.

Артефакти цього проходу:

- `os.tmpdir()/tsukenya-facets-qa/results.json` і `*-pending-{1440,320}.png`.
- `os.tmpdir()/tsukenya-audit-details-qa/results-content.json`, `results-layout.json`, PNG1440/390/320/error320/zoom200.
- Дати: PASS stdout helper; невдалий прохід зберігає screenshot. Команда відтворювана, не твердження про перевірку всіх часових поясів.

Переглянуто facets pending320 та audit actual200 PNG. Початковий test-name filter пропускав нову story, потім уточнено selector accessible name; pre-fix story відтворила enabled дефект, post-fix PASS. TypeScript виявив неправильний `exact` option Testing Library — виправлено лише story. Перший actual-app запуск читав стару збірку; після build helper потребував нового document URL для кожного case, бо SPA зберігала попередні фільтри. Після виправлення harness всі чотири case PASS. Це не приховані успішні прогони та не причина повторювати незмінені suites.

Межі: Chromium/macOS, а не Firefox/системний Safari або screen reader. Не змінено журналювання, права, SQL, гроші, залишки чи фізичний друк. Загальна звірка — [UI-UX-AUDIT-COMPLETION.md](UI-UX-AUDIT-COMPLETION.md).
