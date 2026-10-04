# Залишкові UI-сценарії: обмежений аудит

Дата: 03.10.2026. Початковий read-only прохід перевірив допоміжні ERP-форми після успішних перевірок фінансів, бюджету й історії. Наступний дозволений патч виправив п’ять підтверджених дефектів в `app/erp.js` і `app/erp.css`; додано вузький helper `tests/erp-recovery-ui.cjs`. Серверний код не змінював, фінанси/бюджет/історію повторно не запускав.

## Початкові підтверджені дефекти — виправлено

| Пріоритет | Сценарій та доказ | Точкова зміна | Цільове приймання |
| --- | --- | --- | --- |
| P1 | Після успішного запису форма закривається, але збій наступного `load()`/`draw()` залишається без повідомлення. [`submit`, erp.js:121](../app/erp.js#L121) передає помилку вже закритому dialog; [`formError`, erp.js:103](../app/erp.js#L103) її відкидає. У браузері: mocked entity POST 200 → state GET 503; 0 відкритих форм, 0 alerts. | Відділити запис від оновлення екрана. Після успішного запису показувати «Збережено; список не вдалося оновити» з повторенням **GET**, а не POST. У refresh failure не звертатися до закритого dialog. | Ідентифікатор успішного запису збережено, помилка оновлення видима; retry виконує лише читання й не створює другий запис. Перевірити для entity та одного `simpleForm`. |
| P2 | Запізніла **помилка** запиту користувачів перезаписує новий маршрут. [`userList`, erp.js:197](../app/erp.js#L197) перевіряє generation/tab тільки після успішного GET; спільний click catch може викликати `errorPanel` вже на іншому екрані. Браузер: setup → delayed GET users → customers → GET 503; заголовок «Клієнти», замість списку — помилка users. | Такий самий captured tab/generation/dialog guard застосувати до failure, cancel GET при leave. Помилку користувачів показувати біля цієї дії з retry, зберігаючи екран. | Відповіді 200 **і** 503 старого users запиту не змінюють новий маршрут або нову відкриту форму. |
| P2 | Зміна готового товару мовчки замінює незбережені рядки рецептури. [`recipeForm`, erp.js:215](../app/erp.js#L215), `onchange`: безумовний `innerHTML=(p.recipe||[]).map(...)`. Браузер: у A змінено кількість 1 → 3; після вибору B отримано 2, жодного підтвердження. | Облік dirty саме рядків рецептури; підтвердження перед заміною. При відмові відновити попередній committed product та рядки. Dirty загального dialog не достатній: саме переключення select вже робить його dirty. | Відмова залишає A та 3; згода завантажує B та 2; перший вибір товару без змін не викликає зайвого запиту. |
| P2 | Довгий неподільний фрагмент серверної помилки переповнює dialog на 320 px. [`trade-error`, erp.css:9](../app/erp.css#L9) не має правила переносу. Сервер реально включає назви товару/рахунку у повідомлення: [`services.py:106`](../server/erp/services.py#L106), [`services.py:112`](../server/erp/services.py#L112). Probe використав error з назвою 230 символів — `dialog.scrollWidth > dialog.clientWidth`. | Додати спільне `overflow-wrap:anywhere` для торговельних alert/error/status; не застосовувати обрізання до повідомлення помилки. | На 320 px довга назва товару/рахунку в помилці повністю читається без горизонтального scroll; error focus і відновлення кнопки збереження залишаються. |
| P3 | Порожній результат пошуку клієнта показує «Поки немає записів», хоча клієнти існують. [`customersView`, erp.js:70](../app/erp.js#L70) використовує default empty text спільної таблиці. Підтверджено браузером із заповненим довідником. | Окремий текст «Клієнтів за цим пошуком не знайдено» та дія очищення пошуку; для справді порожнього довідника — текст про додавання. | Обидва порожні стани різняться; очистка відновлює список і фокус у пошуку. |

P1 означає неоднозначний результат запису; P2 — втрату чернетки/контексту або непридатне відображення; P3 — локальну ясність інтерфейсу. Це перелік конкретних доведених шляхів, а не твердження про всі ERP-дії.

## Семантичні питання, підтверджені читанням коду

- **Виправлено — користувач без прив’язки до магазину:** [`userList`, erp.js:197](../app/erp.js#L197) раніше показував «—», тоді як редактор називає той самий `null` «Усі магазини». Read-only список тепер показує «Усі магазини»; це пояснює фактичний scope без зміни прав. Role/store payload у `/users` відповідає редактору, іншої DTO-невідповідності не знайдено. Джерело контракту: [`views.py:458`](../server/erp/views.py#L458).
- **Виправлено — подробиці журналу:** `app/erp-finance.js` показує українське read-only резюме доступу користувача, кількості інгредієнтів і результату масових цін; оригінальний JSON і action code залишені в розкривних «Технічних подробицях». Невідомі або неповні дані не доповнюються припущеннями. Перевірки змісту, клавіатури, 320 px і фактичних 200% — [FILTERS-AND-AUDIT-QA.md](FILTERS-AND-AUDIT-QA.md).
- **Виправлено — рецептура:** готовий товар раніше був серед варіантів власного інгредієнта, хоча [`validate_product`, views.py:103](../server/erp/views.py#L103) забороняє таку рецептуру. Self відфільтровано у UI; серверна перевірка збережена. Приховані інгредієнти не оголошуються дефектом: ERP читає весь legacy-каталог, включно з hidden.

## Реалізація та цільовий результат

Окремий helper має власний server process, тимчасову SQLite та порт **18216**. Успішні й помилкові ERP UI POST у цьому helper перехоплені; synthetic fixtures і очищення клієнтського довідника записуються тільки до його тимчасової бази. Після завершення browser, server і база прибираються.

Команда цільового проходу:

```sh
PYTHON_BIN=/tmp/tsukenya-crm-venv/bin/python node tests/erp-recovery-ui.cjs
```

Для повтору тільки ураженої групи: `QA_RECOVERY_FROM=users|saved|documents|recipe|customers`; `tail` виконує лише рецептуру та клієнтський пошук. `QA_RECOVERY_PORT` дозволяє інший вільний localhost-порт; Chromium береться з Playwright та запускається у headless-режимі без executable override. Це окрема команда, не новий entrypoint повної регресії. Shared harness/full-check не змінював.

| Змінена поведінка | Фактичний результат |
| --- | --- |
| Shared entity/simpleForm write success → read failure | **PASS** для клієнта й ПРРО: форма закрита, повідомлення про збереження видиме, ID entity 999 збережений, фокус на alert. Enter на retry робить другий GET і рівно одну POST загалом; після успіху фокус на status. |
| Custom voucher save/post та existing post action | **PASS**: draft save, save+post та existing post → state GET 503 показують ID й результат «збережено» або «проведено». Enter retry виконує тільки GET: одна save POST та/або одна post POST на дію. Save 200/post 422 лишає форму й note, повертає фокус error та відновлює submit; прямо повідомляє «Чернетку № N збережено. Проведення не підтверджено». |
| Users loading/error/retry | **PASS**: статус завантаження, локальна помилка, клавіатурний retry, `aria-busy` прибрано після відповіді; unscoped owner показаний як «Усі магазини». |
| Users cancel/stale 200 і 503 | **PASS**: Escape скасовує GET (перевірено `requestfailed`), відкладений handler завершується; після переходу на clients і відкриття нової форми старі success/error не змінюють маршрут, нову чернетку та її error. |
| Recipe switching/dirty | **PASS**: перший вибір без prompt; відмова зберігає A/3, згода завантажує B/2; доданий рядок теж потребує підтвердження. Готовий B відсутній серед власних інгредієнтів. |
| Long token server error | **PASS**, 320 px: помилка з 230 неподільними символами переноситься повністю, `scrollWidth <= clientWidth + 1`; кількість 2, error focus і відновлений submit збережені. PNG `tsukenya-recovery-error-320.png` у `os.tmpdir()` переглянуто. |
| Customer search | **PASS**: no-result та справді порожній довідник мають різний текст; Enter на очищенні відновлює список і фокус у search. |
| JavaScript | `node --check app/erp.js` і `node --check tests/erp-recovery-ui.cjs` — **PASS**; page errors у цільових сценаріях відсутні. |

Перший combined helper зупинився на додатково знайденому focus race: queued `close` event форми забирав фокус із нового refresh alert. Close listener тепер відновлює opener лише коли поточний фокус у body/закритій формі. Повторено тільки `saved`; потім виконано невиконаний `tail`. Users повторено окремо після посилення доказу скасування GET: замість часової паузи helper чекає `requestfailed` і завершення відкладеного handler. Document групу додано після виявлення аналогічного custom voucher/post path; вона пройшла окремо. Перший запуск цієї групи зупинився на неоднозначному helper selector `#main .panel` у фінансах; його уточнено до `first()`. Після PASS уточнено тексти confirmed save/posted та повторено лише document групу з exact-count перевірками. Повного suite не запускали.

Цей результат покриває shared `submit` для entity/simpleForm, custom `voucherForm.onsubmit` та existing `post-voucher`. Він підтверджує recovery після failed state GET; failed detail GET після успішного draw перевірено наступним [ERP settings/recovery проходом](ERP-SETTINGS-RECOVERY-QA.md); реальний save/post network-ambiguity не моделювали. UI не називає відхилене або непідтверджене проведення успішним. Реальний conflict, серверні права, screen reader, forced colors, 200% і physical printing цим helper не перевіряються. Серверні бухгалтерські сценарії та попередні фінансові/budget/history PASS залишаються окремими доказами.

## Що перевірено початковим read-only проходом

Окрема тимчасова SQLite, localhost **18216**, headless Chrome, 320 px. Успадковані змінні PostgreSQL прибрані; синтетичні fixtures записано лише до тимчасової бази. Усі UI POST-відповіді перехоплено: створення клієнта, рецептура, період, ПРРО і користувач **не виконували реальних mutation-запитів**. Сервер, browser context і тимчасову базу прибрано після завершення.

| Форма | Перевірені негативні стани | Результат |
| --- | --- | --- |
| Користувачі | Late failed GET після переходу; editor POST error, логін 80 символів | Late failure — дефект вище; editor error залишає логін, фокус у error, кнопка відновлена, 320 px без overflow |
| Клієнт | Порожній пошук; successful POST + failed refresh | Підтверджено обидва дефекти вище |
| Рецептура | Product switch після зміни кількості; POST error; довга неподільна помилка | Product switch та overflow — дефекти; при error кількість і фокус збережені, submit відновлений |
| Обліковий період | POST error, причина понад 360 символів | Чернетка причини збережена, error focus, submit відновлений, 320 px без overflow |
| ПРРО | POST error після вибору required | Режим збережений, error focus, submit відновлений, 320 px без overflow |

У probe уточнювали тільки тестові передумови: відкриття mobile navigation, reload для вже активного URL, `.repeat()` для довгої JS-строки. Після збою повторювали тільки невиконаний хвіст або довгі значення. Жодної повної регресії чи live/VPS-перевірки не запускали.

Локальні артефакти цього проходу (не є постійними CI baseline):

- `tsukenya-next-users-stale-320.png` — заголовок клієнтів зі старою users-помилкою;
- `tsukenya-next-recipe-error-320.png` — довга помилка рецептури;
- `tsukenya-next-ui-results.json` — останній вузький long-error/period probe;
- temporary harness `/tmp/tsukenya-remaining-ui.cjs`, narrow modes `NEXT_FROM=remaining` та `NEXT_FROM=long`.

PNG/JSON лежать у каталозі `os.tmpdir()` поточної машини. Production дані, паролі та sessions не включені.

## Мінімальне наступне покриття

1. **Виконано:** bounded `tests/erp-recovery-ui.cjs` перевіряє змінені сценарії без повторення фінансів/бюджету/історії. Custom voucher write/read та post-voucher recovery теж виконано окремою `documents` групою.
2. **Виконано наступним isolated проходом:** реальні users conflict409/403, create/edit200 та завершення target session401. Доказ — [ERP-SETTINGS-RECOVERY-QA.md](ERP-SETTINGS-RECOVERY-QA.md).
3. **Закрито цільовими перевірками 03.10:** рецептура — недоступний/порожній каталог, self/duplicate, два editors409/draft recovery, fresh GET і revision contract, справжня паралельність PostgreSQL. Докази та межі — [RECIPE-RECOVERY-QA.md](RECIPE-RECOVERY-QA.md).
4. **Виконано наступним isolated проходом:** period draft rejection/rollback, close/reopen/reset; fiscal real save та відповідний required/optional стан свіжої sale-форми. Окремий server/UI date-boundary probe лишається поза цим доказом. Див. [ERP-SETTINGS-RECOVERY-QA.md](ERP-SETTINGS-RECOVERY-QA.md).
5. **200% негативних users/period/detail виконано** в наступному проході. Screen reader/forced colors для цих негативних станів лишаються неперевіреними. Раніше успішні перевірки інших екранів не є доказом для них.

## Уточнення основного звіту

[`UI-UX-AUDIT.md:9`](UI-UX-AUDIT.md#L9) описує **базові** 100 станів на 1440/390 px. В [`tests/ui-audit.cjs:45`](../tests/ui-audit.cjs#L45) axe запускається лише на 1440; геометрія — на обох ширинах. Це не покриття long/error/320 для всіх допоміжних форм. Основний звіт уже визнає потребу такого наступного проходу.

Старі пункти [`UI-UX-AUDIT.md:67`](UI-UX-AUDIT.md#L67) та [`UI-UX-AUDIT.md:83`](UI-UX-AUDIT.md#L83) про ledger/journal/debts pagination слід позначити як історичні: вони виправлені й перевірені в розділі [`«Фінансові списки»`](UI-UX-AUDIT.md#L103). Не переносити їх до нового списку невиправлених дефектів. Фінансовий PASS не скасовує окремі shared submit/read lifecycle дефекти, описані вище.


## Звірка покриття

Межі дат перевірено окремим `tests/erp-date-boundary-ui.cjs`: Europe/Kyiv по обидва боки півночі при іншому часовому поясі браузера, native date min/max, фактичні серверні відмови й успіх. Дефекту не знайдено; нової бізнес-політики не введено. Залежні фільтри каталогу/Studio та читабельність журналу виправлено. Остаточна матриця маршрутів, доказів і меж — [UI-UX-AUDIT-COMPLETION.md](UI-UX-AUDIT-COMPLETION.md).
