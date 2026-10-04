# B24: обмежені списки порталу

Additive `portal-metadata-v2` (`/api/v1/portal/metadata`) містить тільки settings/project, role/networkOwner/scopeStore, CSRF, label revision і scoped domain versions. Старі v1/full endpoints лишаються compatibility. Нові tasks/ideas/планові expenses сторінки — ≤30; nearest summary — ≤5. Initiative relations читаються лише для IDs сторінки. Кожна сторінка, її count і relations — один RR READ ONLY; summary — окремий поточний знімок. Це не збережений незмінний snapshot між HTTP-запитами.

## Семантика та межі

- Використано чинні `task_visible`/`task_permissions`. Власник продовжує бачити старі manual/development задачі з foreign stores; фінансові due tasks обмежено чинним store scope. Nonowner ideas — чинний operations predicate без нової store policy.
- Development — scope != operations, включно зі старими unknown/null. Unknown stages мають явну групу. Невідомі статуси входять до total/unfinished й unknownStatus, а не маскуються під todo.
- Expenses — старий поточний каталогний план, не ERP expenses або monthly-budget lines. Variable зберігає legacy `group != fixed`. Category hints/порядок regex дорівнюють старому `budgetCategory`; Decimal суми всього набору незалежні від сторінки.
- Пошук casefold виконується серверним iterator. Видимість старих JSON перевіряється чинним Python helper. Сортування — finite numeric legacy order з zero fallback, потім document path; stage filter не змінює order. Час page/count/summary **O(N)**, DB sort також залежить від N. Python пам’ять: batch200 + page30 + nearest5. Це payload/memory boundary, не O(1) чи capacity SLA.
- Runtime серверних full subscriptions tasks/ideas/expenses відхиляє виклик явно. Artifact зберігає свої full subscriptions. Native consumers беруть сторінки/підсумки без firstpage-as-full-state.

## Цільовий backend доказ

`manage.py test tests.test_portal_collections --noinput` на власній локальній PostgreSQL18 DB: 5 PASS. 65-record page/clamp/search/category Decimal parity; scoped/network owner, manager/cashier permissions; compact changed200 без collection/link scan й unchanged304≤4SQL; batch relations; readonly RR concurrent committed rename не змінює вже відчитаний count/page; current actor deactivation401. Після додавання unknownStatus/group compatibility та scopeStore — ще три affected PG сценарії PASS (один metadata, два summary/page після виправлення PostgreSQL regex repetition limit). SQLite role/paging/metadata checks також PASS; PG snapshot сценарій не замінювався SQLite.

Consumer/recovery/native proof додається після завершення інтеграції. Виробничий сервер, Sheet, scheduler, posting formulas і full suite не виконувалися.
