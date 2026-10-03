# Допоміжні ERP-форми та відновлення подробиць

Дата: 03.10.2026. Обмежений наступний прохід після `UI-UX-NEXT-COVERAGE.md`. Попередні успішні recovery/finance/budget/history групи не запускали. Початкові зміни застосунку обмежені `app/erp.js`; наступний окремий layout-прохід змінив тільки `app/erp.css`. Серверні бізнес-правила перевірено без їх редагування.

## Виправлені UI-дефекти

1. `refreshDocument` оновлював список, але failed detail GET називав збоєм списку; retry повторював тільки state GET і не відкривав подробиці. Тепер помилки списку й подробиць розрізняються. «Відкрити документ повторно» виконує тільки GET конкретного документа, зберігаючи поточний список і результат попереднього запису.
2. Прямий `view` після закритої форми передавав read error у вже закритий dialog, де `formError` його відкидав. Captured source/tab/generation guard тепер показує локальне повідомлення зі збереженим списком. Помилка читання у вже відкритому dialog залишається в ньому.
3. Prepend feedback + `preventScroll` залишав сфокусовану помилку поза viewport після натискання нижнього рядка таблиці. Feedback тепер прокручується у видиму область. У helper перевіряються **видимі межі** alert, а не тільки `activeElement`.

`retryDocumentDetail` не робить POST/PUT, не перемальовує список і не застосовує запізнілу помилку до нового маршруту/форми. Панель прибирається лише після фактичного відкриття потрібного dialog. `viewVoucher` повертає відкритий dialog для цього підтвердження; stale success повертає без відкриття.

Основні точки: [`savedRefreshFeedback`](../app/erp.js#L104), [`refreshDocument`](../app/erp.js#L117), [`retryDocumentDetail`](../app/erp.js#L122), `view` у `act`, `viewVoucher`.

## Ізоляція й команда

```sh
PYTHON_BIN=/tmp/tsukenya-crm-venv/bin/python node tests/erp-settings-ui.cjs
```

Helper створює власну SQLite й server process на **localhost:18216** та прибирає їх після завершення. Успадковані PostgreSQL-параметри видалені. Усі реальні mutation-запити нижче спрямовані тільки на цю тимчасову базу; production/VPS/Google Sheet не використовували.

- `QA_SETTINGS_FROM=users|period|fiscal|detail|zoom|detail-zoom` — одна конкретна група для повтору; default `all` — лише перелічені нові стани.
- `QA_SETTINGS_PORT` — інший вільний localhost-порт.
- `CHROME_PATH` — executable локального Chrome.
- Helper уже включено у `scripts/full-check.mjs`; entrypoint очищає `QA_SETTINGS_FROM` і `QA_SETTINGS_PORT`. Цільовий прохід не запускав повну регресію.

## Фактичний результат

| Сценарій | Доказ і результат |
| --- | --- |
| Users conflict | **PASS**, справжній POST409: дубль існуючого `settings_manager`; форма, логін і пароль залишаються; error focus, submit restored, 320 px без горизонтального overflow. Сервер повертає generic uniqueness message з transaction rollback. |
| Users403 | **PASS**: UI POST із неправильним CSRF дійсно відхиляє сервер403, зберігаючи форму/фокус. Окремо авторизований scoped manager отримує реальні403 на users GET і POST; це доказ owner-only permission, без підробленої JSON-відповіді. |
| Users success / session revocation | **PASS**: реальні create200 та edit200; username існуючого користувача read-only. Cashier має заданий store. Зміна ролі на warehouse робить старий target session нечинним (GET state401); owner session лишається200. Новий login працює з попереднім паролем і новою роллю та одним належним магазином. |
| Period rejection | **PASS**, справжній POST400 через draft на дату закриття: дата/причина збережені, фокус на error, submit відновлений, 320 px без overflow. `closed_through` після rollback лишається null. |
| Period close/reopen/reset | **PASS**: blocking draft видалено реальним isolated DELETE200; повторний close200 встановлює вчорашню дату, нова форма показує її. Reopen із порожньою датою200 повертає null; нова форма показує порожню дату. |
| Fiscal / sale form | **PASS**: реальні required/optional POST200 змінюють авторитетний `fiscal_required`. Свіжа sale-форма має потрібну `required`/`valueMissing` семантику; обов’язкове поле видиме. Повторно відкрите налаштування показує збережений режим. |
| Save then detail GET failure | **PASS**: expense реально збережено один раз, після успішного state/list read detail GET отримує503. Новий saved ID є у списку; повідомлення про failed details видиме та сфокусоване. Enter retry читає лише detail GET і відкриває справжній запис із збереженою note. Рівно одна POST, два detail GET. |
| Initial view / late retry failure | **PASS**: початковий failed view GET лишає список і повідомляє read error, без неправдивого «збережено/проведено». Відкладена retry503 після переходу до clients і відкриття нової форми не змінює нову note/error/route. |
| 200% | **PASS**, фактичний persisted Chrome page zoom: window1440, CSS viewport720, devicePixelRatio2. Real users409 і period400 зберігають чернетку, фокус, submit; dialog/page не мають горизонтального overflow. Detail503 з неподільним текстом230 символів переноситься, alert повністю видимий, GET retry доступний, список збережений. |
| Syntax / runtime | `node --check app/erp.js`, `node --check tests/erp-settings-ui.cjs` — **PASS**; page errors у наведених сценаріях відсутні. |

Перший запуск усіх **нових** груп пройшов. Наступні повтори обмежувалися `zoom`/`detail-zoom` для нової зміненої negative geometry та перезахоплення PNG: стандартний Playwright screenshot у persistent context із zoom200 дав порожній растр. Для цих артефактів використано `Page.captureScreenshot` через CDP, як у чинному `layout-ui.cjs`. Перегляд PNG виявив offscreen alert; після scroll fix повторено лише `detail` та `detail-zoom` з visible-bounds перевіркою. Users/period/fiscal повторно не запускали після detail fix, оскільки їх inputs не змінені.

Переглянуті локальні артефакти у `os.tmpdir()`:

- `tsukenya-settings-users-200.png` — actual200 users409;
- `tsukenya-settings-period-200.png` — actual200 period draft rejection;
- `tsukenya-settings-detail-320.png` — saved write / failed detail GET;
- `tsukenya-settings-detail-200.png` — initial view error із довгим текстом, видимий alert та retry.

Це доказ конкретних станів, не канонічні cross-browser baselines. Screen reader, forced colors, WebKit, PostgreSQL concurrency та непевний network outcome проведення цим helper не перевірялися. Перевірка fiscal підтверджує налаштування й форму; зовнішній ПРРО-сервіс не підключали та продаж не проводили.

## Окрема спостережена область

**Виправлено окремим вузьким CSS-патчем.** Початково actual200 (CSS720) залишав сім ERP document columns і ділив дату/магазин на дрібні фрагменти. Тепер `app/erp.css` визначає named container тільки для wrapper voucher table за специфічним `Контрагент / працівник`; debts/chooser/history не зачіпаються; коли **фактична ширина таблиці ≤900 px**, кожен документ стає карткою з підписаними полями. Це залежить від доступного content після sidebar/padding, а не від одного viewport breakpoint. Дата — nowrap; document/counterparty/actions займають повну ширину картки, а на content≤340 сума теж займає повний рядок. Табличні column headers visually hidden, але лишаються в DOM і native Chrome AX role; інші ERP таблиці не змінено.

Власний read-only helper:

```sh
PYTHON_BIN=/tmp/tsukenya-crm-venv/bin/python node tests/erp-document-layout-ui.cjs
```

Окрема тимчасова SQLite, localhost18216 (`QA_DOCUMENT_LAYOUT_PORT` для іншого порту), три синтетичні документи з довгими українськими назвами магазину/контрагента та сумами21.99/21999.50/987654.32. ERP mutation-запити не виконували; fixtures записані безпосередньо до ізольованої бази. Settings/ERP suites не повторювали.

| Viewport / режим | Фактична table content width | Компонування | Результат |
| --- | --- | --- | --- |
| 1440 | 1102 px | Сім колонок | PASS |
| 1024, sidebar видимий | 734 px | Картки | PASS |
| 768 | 678 px | Картки | PASS |
| 720 | 630 px | Картки | PASS |
| 320 | 258 px | Картки, сума на повну ширину | PASS |
| Actual200%, window1440 / CSS720 / dpr2 | 630 px | Картки | PASS |

У кожному стані: три records збережені; page/table без horizontal overflow; дата одним рядком; довгі назви й суми читаються; date/store pair і full-row counterparty/document мають очікувану геометрію; native «Дата» columnheader лишається у Chrome AX; «Відкрити» має touch target≥44 і клавіатурний фокус; 6 px margin зберігає весь focus ring усередині clipping wrapper. Enter відкрив справжні read-only подробиці документа, Escape повернув фокус. Переглянуто PNG `tsukenya-documents-1440.png`, `-720.png`, `-320.png`, `-200.png` у `os.tmpdir()`. Actual200 PNG захоплено через CDP. Після першого PASS marker звужено з generic «Документ» до voucher-only «Контрагент / працівник», а для кнопки зарезервовано focus ring margin; повторено тільки цей document-layout helper, він теж PASS з додатковою перевіркою horizontal focus ring bounds. `node --check tests/erp-document-layout-ui.cjs` і `git diff --check` — PASS. Workspace CSS, сервер, production, full suite, commit/deploy не змінювали. WebKit/screen-reader це окреме компонування ще не підтверджують.

## Серверний контракт, перевірений читанням

- [`views.py users`](../server/erp/views.py#L456): owner-only; uniqueness →409, save/update в transaction, [`PortalSession.delete`](../server/erp/views.py#L470) для target.
- [`views.py period`](../server/erp/views.py#L447): завершена дата, required reason, draft rejection і transaction rollback.
- [`views.py fiscal`](../server/erp/views.py#L475), [`reporting.py state`](../server/erp/reporting.py#L68): авторитетний required mode; UI читає свіжий стан.
