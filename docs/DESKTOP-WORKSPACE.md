# Оболонка та студія як робочий простір

## Контракт оболонки

`app/index.html`, `app/workspace.css` і `app/portal.js` задають спільну навігацію.
Глобального верхнього header немає. Назва застосунку й мережі — у лівій панелі;
обліковий запис, кнопка локальних чернеток та «Про застосунок» із версією/комітом —
у її footer. Навігація має власне прокручування, незалежне від вмісту екрана.
IDs `chainName`, `updated`, `accountLink`, `applicationVersion`, `applicationCommit`
збережено для чинних адаптерів. Launcher чернеток і далі додається після accountLink.

Групи навігації — semantic buttons із `aria-expanded` та `aria-controls`.
Згортання не змінює URL і не викликає переходу. За замовчуванням відкрито щоденну
роботу; активна група відкривається при першому маршруті та зміні маршруту.
Ручне згортання активної групи зберігається до наступної зміни маршруту, зокрема
після фонового оновлення даних. Boolean preferences у `tsukenya-navigation-v1`
зберігаються в localStorage; недоступне сховище або malformed JSON не блокують UI.
Автоматичне відкриття маршруту не перезаписує preference користувача.
Чинні ролі, URL та попередження про незбережені зміни залишаються авторитетними;
група розвитку прихована повністю для відповідних обмежених ролей.

При ширині ≤900 px кнопка «Відкрити навігацію» відкриває drawer. Вміст сторінки
стає inert; фокус переходить до видимого посилання й залишається у drawer при Tab.
Escape, Close та backdrop закривають його з поверненням фокуса. Account доступний
у тому самому footer. Перед відкриттям модального вікна чернеток drawer закривається.
Перехід між мобільним і desktop breakpoint переносить фокус лише якщо попередня
ціль стала невидимою. При відкликанні ролі прихований development control не
залишається ціллю фокуса; спершу прибирається inert, потім фокусується заголовок.

## Desktop Label Studio

Лише фактичний React-маршрут `#operations/tags` встановлює `body[data-layout='studio']`.
При відсутньому React-модулі та інших маршрутах атрибут прибирається.
Fixed workspace вмикається **одночасно за ширини ≥1200 px і висоти ≥600 px**:

- shell має висоту `100dvh`, а `wrap → #main → #react-labels` — flex/min-height:0;
- оболонка залишає компактний h1 та skip link; великий опис і eyebrow приховані;
- контекст магазину — компактний toolbar; `.tk-pricing-workspace` заповнює решту місця;
- вкладки/команди й нижні дії залишаються у робочій області; шари/властивості,
  списки товарів і переддрук мають власні scroll panes;
- довгі notices/context мають обмежений scroll, щоб не витісняти робочий вміст.

За меншої ширини **або** меншої висоти залишається natural document flow:
панелі перебудовуються, а сторінка прокручується без прихованого поза екраном
інспектора. Інші маршрути не отримують фіксованої висоти студії.

Чернетки, undo/redo, вибір товарів і копії лишаються у чинному React workspace.
Ця правка не змінює бухгалтерські правила, збережені фізичні mm/pt, A4,
масштаб друку, PDF raster або серверний snapshot/перевірку актуальних цін.
Екранне компонування не визначає фізичний розмір друку.

## Цільова перевірка

```sh
npm run build:frontend
QA_NAV_ONLY=1 QA_OUTPUT_DIR=/tmp/tsukenya-desktop-workspace-proof \
  PYTHON_BIN=/path/to/isolated/python node tests/labels-ui.cjs
```

Використовується лише bundled Chromium Playwright у headless-режимі,
без channel/executablePath/system Chrome. Сервер і дані — ізольовані;
це не повна регресія та не production mutation. Для перевірки PDF потрібен `pdfinfo`.
Окремий nav stage включений також у явний `npm run test:full`; звичайна розробка
використовує лише наведену цільову команду.

Вже виконано: синтаксис portal.js, diff whitespace check та `/tmp/tsukenya-shell-nav-probe.cjs`
без браузера/сервера: недоступне storage, ручне згортання/повторний render,
відкриття нового маршруту, studio/module-ready boundary, Escape/inert/resize focus,
унікальність збережених shell IDs.

**Виконано 04.10.2026 — PASS:**

- actual shell/sidebar: group toggle без URL переходу, preference reload,
  account/drafts/version footer; рольові обмеження перевірено статично/VM,
  не окремим production browser login;
- Label Studio 1440×900, 1280×720, короткий 1440×600 та 320×900:
  desktop viewport containment, власні scroll panes, natural fallback,
  видимі команди/інспектор і відсутність горизонтального виходу;
- клавіатурні вкладки, Escape/focus trap, resize із фокусом на Close/sidebar link;
- чернетка макета та вибір/копії зберігаються між вкладками й розмірами вікна,
  навігація не виконує автоматичного Save;
- фізична переддрукова геометрія A4 210×297 мм, цінник 58×40 мм,
  фактичне завантаження односторінкового A4 PDF;
- StudioWorkspace: independent panes/keyboard/output cancellation, readonly та
  bounded conflict; PricingContext ToolbarRecovery: помилка зміни магазину,
  повтор і збереження чернетки/копій;
- TypeScript, scoped ESLint/Prettier, matching production build, browser policy,
  syntax/diff checks; full runner тільки `--plan`;
- переглянуто desktop/mobile PNG. Виправлено надмірний перенос footer,
  приховування мобільних заголовків груп старим CSS та resize focus race
  (browser blur до `matchMedia`). Повторено лише пов'язаний nav stage.

Фактичний звіт і знімки: `/tmp/tsukenya-desktop-workspace-proof/workspace-report.json`,
`tsukenya-workspace-1440x900.png`, `tsukenya-workspace-1280x720.png`,
`tsukenya-workspace-320x900.png`, `tsukenya-sidebar-320.png`,
`tsukenya-workspace-ready.png`, `tsukenya-workspace-review.png` і
`tsukenya-workspace-proof.pdf` у тому самому каталозі. Це локальні тимчасові артефакти,
не файли клієнта. Зміни API, бізнес-проведень або фізичного Label renderer відсутні.

Фізичний принтер і screen reader цим переліком не підтверджуються.
