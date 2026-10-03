# Рецептури: конфлікти й відновлення · 03.10.2026

## Виправлення

Форма завантажує актуальну рецептуру GET `/api/erp/recipes?product=ID`, а не копію зі старого каталогу. Відповідь містить metadata/recipe/revision; POST потребує саме прочитаної версії. Під чинним PostgreSQL ledger lock сервер звіряє revision, перевіряє recipe та записує зміну разом з audit в одній транзакції. Конфлікт повертає 409 `revision_conflict`. Дублікати інгредієнтів відхиляються; чинні правила одиниць/кількості/self-ingredient збережені.

При 409, невизначеній відповіді збереження чи помилці fresh GET форма залишає рядки й блокує небезпечне збереження. Є явне завантаження актуального рецепта; перед заміною зміненої чернетки — підтвердження. Пізній/скасований GET не змінює іншу форму чи маршрут. Підтверджений POST200 з наступним GET503 показує успішний запис і пропонує GET-only retry списку, без другого POST.

Порожній каталог пояснює наступний крок. Порожня рецептура пояснена; очищення непорожнього рецепта потребує підтвердження. Недоступний або старий self-ID залишається видимим у рядку й не підміняється порожнім вибором. UI перевіряє наявність, self/duplicates та кількість; вибраний іншими рядками інгредієнт недоступний у їхніх списках. Додавання рядка передає фокус його вибору. На200% рамка помилки повністю міститься у dialog scrollbox завдяки recipe-only scroll margin.

Це чинний HTML/JS торговельний модуль; React міграція рецептур не оголошується завершеною. Схема й проведені документи не змінені.

## Докази

- 14 endpoint tests — PASS на isolated SQLite; після додавання concurrency — **15/15 PASS на справжній disposable PostgreSQL18**, 6.803с.
- `RecipeConcurrencyTests` запускає два HTTP POST з різними authenticated editors, одним revision і різною кількістю одночасно; barrier перед справжнім ledger lock. Рівно200+409, один AuditEvent, recipe/revision переможця. PG-контейнер з випадковим localhost-портом видалено після перевірки; production не підключали.
- `PYTHON_BIN=… QA_RECOVERY_FROM=recipe node tests/erp-recovery-ui.cjs` — PASS після адаптації очікування fresh GET.
- `PYTHON_BIN=… node tests/recipes-ui.cjs` групами validation/tail — PASS: порожній каталог, self/duplicates, invalid quantity, deleted ingredient400, clear confirmation, legacy missing ID, два редактори409/draft/reload/retry, actualGET403/404, GET503, abort/late failure, confirmedPOST200→read503/GET-only retry, dirty Escape/route.
- Layout1440/390/320, усі видимі контролі≥44px, error focus — PASS. Actual Chrome200% пройшов окремий zoom-only повтор після виправлення рамки; CDP PNG переглянуто.

Helper створює власні синтетичні товари й тимчасову SQLite на localhost18224. Немає production/shared Sheet записів. Артефакти: `os.tmpdir()/tsukenya-recipes-qa/results-{validation,tail,zoom}.json`, `tsukenya-recipes-{1440,390,320,zoom-200}.png`.

Для повтору невдалого конкретного сценарію `QA_RECIPES_FROM=validation|conflict|read|layout|zoom|tail`; звичайний запуск `all`. Повний entrypoint очищає цей прапорець й включає helper; **повну регресію цього разу не запускали**. Не підтверджено screen readers, WebKit або всі комбінації бізнес-рецептів; версії виробничих партій/генеалогія лишаються B12 бізнес-пропозицією.
