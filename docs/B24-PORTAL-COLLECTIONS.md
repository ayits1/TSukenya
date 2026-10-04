# B24: обмежені списки порталу

Additive `portal-metadata-v2` (`/api/v1/portal/metadata`) містить тільки settings/project, role/networkOwner/scopeStore, CSRF, label revision і scoped domain versions. Старі v1/full endpoints лишаються compatibility. Нові tasks/ideas/планові expenses сторінки — ≤30; nearest summary — ≤5. Initiative relations читаються лише для IDs сторінки. Кожна сторінка, її count і relations — один RR READ ONLY; summary — окремий поточний знімок. Це не збережений незмінний snapshot між HTTP-запитами.

## Семантика та межі

- Використано чинні `task_visible`/`task_permissions`. Власник продовжує бачити старі manual/development задачі з foreign stores; фінансові due tasks обмежено чинним store scope. Nonowner ideas — чинний operations predicate без нової store policy.
- Development — scope != operations, включно зі старими unknown/null. Unknown stages мають явну групу. Невідомі статуси входять до total/unfinished й unknownStatus, а не маскуються під todo.
- Expenses — старий поточний каталогний план, не ERP expenses або monthly-budget lines. Variable зберігає legacy `group != fixed`. Category hints/порядок regex дорівнюють старому `budgetCategory`; Decimal суми всього набору незалежні від сторінки.
- Пошук casefold виконується серверним iterator. Видимість старих JSON перевіряється чинним Python helper. Сортування — plain-decimal legacy order (≤250 цифр у частині) з explicit zero fallback для інших кодувань, потім document path; stage filter не змінює order. Час page/count/summary **O(N)**, DB sort також залежить від N. Python пам’ять: batch200 + page30 + nearest5. Це payload/memory boundary, не O(1) чи capacity SLA.
- Runtime серверних full subscriptions tasks/ideas/expenses відхиляє виклик явно. Artifact зберігає свої full subscriptions. Native consumers беруть сторінки/підсумки без firstpage-as-full-state.

## Цільовий backend доказ

`manage.py test tests.test_portal_collections --noinput` на власній локальній PostgreSQL18 DB: 5 PASS. 65-record page/clamp/search/category Decimal parity; scoped/network owner, manager/cashier permissions; compact changed200 без collection/link scan й unchanged304≤4SQL; batch relations; readonly RR concurrent committed rename не змінює вже відчитаний count/page; current actor deactivation401. Після додавання unknownStatus/group compatibility та scopeStore — ще три affected PG сценарії PASS (один metadata, два summary/page після виправлення PostgreSQL regex repetition limit). SQLite role/paging/metadata checks також PASS; PG snapshot сценарій не замінювався SQLite.

## Consumer/recovery доказ

- `node tests/runtime-recovery.cjs`, `node tests/portal-metadata-contract.cjs`, `node tests/portal-collections.cjs`: PASS. Старі runtime cases перенесено на справжній metadata-v2/settings cache, без fake tasks snapshot; per-record revisions, GET-only retry, role/CSRF cache, malformed body, coalescing і confirmed-write barrier збережено. Окремий coordinator proof перевіряє page cardinality/context, frozen off-page pin, late401 cancel і same-role store switch.
- `node tests/managed-alerts-bounded.cjs`: PASS. Pending pin, unknown→later4xx не скидає перший action/body/UUID, strict ACK, confirmed action + failed GET вимагає лише читання; successful read звільняє pin.
- `PYTHON_BIN=/tmp/tsukenya-review-venv/bin/python node tests/portal-collections-ui.cjs`: focused **BASE** PASS. Artifacts `/var/folders/9_/xkms65w90g57nhx8n9bhp6300000gn/T/tsukenya-portal-collections-pmWWfc/`: bounded30/full65/searchwhole, retained inline input, off-page idea/task predicate, off-page expense draft не стає orphan, full category plan65.65, confirmedPOST+GET503+keyboardGETretry/onewrite.
- `QA_COLLECTIONS_FROM=tail` того самого harness: тільки unknown CREATE→page2→invalid newer input→sameUUID/body exact keyboardretry→one document і layout1440/320 PASS. Artifacts `/var/folders/9_/xkms65w90g57nhx8n9bhp6300000gn/T/tsukenya-portal-collections-T09xGM/`. Перший320 PNG виявив legacy flex стиснення task title по літерах; виправлено спільний native task row grid, перевірено readable title width≥180px, targets≥44px і PNG.
- `QA_COLLECTIONS_FROM=managed`: native lost action ACK→todo filter excludes changed task→explicit pending row pin→sameUUID/body keyboard exactretry→1 real AlertTaskAction receipt→fresh all-status row PASS. Artifacts `/var/folders/9_/xkms65w90g57nhx8n9bhp6300000gn/T/tsukenya-portal-collections-CM1xfL/`. Це окремий narrow tail, не повтор BASE.
- Native React bridge assets використано readonly з root build; каталог/labels не монтувалися. React/shared control source не змінювався. Нові filter/search/page controls — чинні native controls. Браузерні snapshots/діалоги залишають локальні чернетки; browser reload persistence не додано.
- Affected старі metadata-interception fixtures перенесено на `/metadata`; direct compatibility full-state helpers лишилися. У expenses analytical fixture більше немає fake full expenses array. Широкі старі native сімейства цілком **не повторювалися**; їх accounting/recovery assertions збережено, тут виконано лише наведені нові/змінені межі. Виробничий сервер, Sheet, scheduler, posting formulas і full suite не виконувалися.


Фінальний малий tail: strict stage predicate відхиляє bool як stage1; category/total plan display використовує Decimal strings із summary (`plannedTotal`), percentages зберігають чинний приблизний legacy UI rule. Affected summary/paging SQLite1 PASS, exact large-total decoder/money VM PASS. Readonly draft availability check позначає orphan лише після authoritative current-record `record_missing`, а не через відсутність ID на сторінці. Цей small availability hook перевірено source/contract; broad старий expenses orphan browser case не повторювався.

Native artifacts залежали лише від незміненого shared native bridge root build (root source HEAD під час завершення `ca2bf01169377a4b8df7ea424cbca2fcbc457492`; parent підтвердив shared bridge unchanged, root build також мав pending hidden-catalog changes). Каталог/labels у цих сценаріях не монтувалися; чужі commits/assets/node_modules не входять у delivery. Для повтору встановити звичайні workspace dependencies та matching frontend build, як у project skill.

Final adapter guard: document ID/revision/permissions завжди із authoritative envelope, legacy data.id не може перенаправити inline action на інший запис. Pure decoder/flatten probe PASS.


Root review follow-up: summaries на «Справи магазину», огляді операцій/розвитку і плані поруч із фактом не приховують помилку, коли є старий confirmed value. Loading/error показуються незалежно від value; попередні підсумки мають час підтвердження, явний підпис і локальний GET retry. Coordinator зберігає value лише для того самого контексту, 401/403 та role/store change очищають приватні дані.

`QA_COLLECTIONS_FROM=summary PYTHON_BIN=/tmp/tsukenya-review-venv/bin/python node tests/portal-collections-ui.cjs`: один affected native tail PASS. 503 summary після успішного читання залишає65 незавершених із видимою помилкою й «Попередні підтверджені підсумки»; keyboard retry повертає fresh стан, кількість writes0. Artifacts `/var/folders/9_/xkms65w90g57nhx8n9bhp6300000gn/T/tsukenya-portal-collections-Fnh9Uy/`. Layout1440/320 і targets44px також перевірено в цьому tail; BASE/managed/backend families не повторювалися.


## Індикація етапів розвитку: пропущений consumer, follow-up

`renderPath()` у серверному режимі більше не читає порожній full `S.tasks`: development summary має `stageDone` для1–4/unknown, зі strict integer/bounds/sum decoder. Етапи та overall — весь доступний development scope, незалежно від page/filter; старі unknown етапи явно входять до overall. Artifact full-array path збережено. Summary активується лише коли власнику показано development path, а не на operations/прихованому ideas path. Loading/error/previous confirmed caption/GET retry мають ту саму межу, що інші summary.

Один новий PG тест `tests.test_portal_collections.PortalCollectionsTests.test_development_stage_completion_uses_whole_scope` PASS (0.308s):65 рядків на3 сторінках,40+25 за етапами,20+13 done; додатковий bool-stage не стає stage1, manager summary403. `node tests/portal-collections.cjs` PASS зі strict stageDone missing/overflow/sum refusal. Решта backend matrix не повторювалася.

`QA_COLLECTIONS_FROM=development PYTHON_BIN=/tmp/tsukenya-review-venv/bin/python node tests/portal-collections-ui.cjs`: narrow actual tail PASS; overall33/65, stages20/40+13/25 наpage2; summary503 лишає видимі попередні confirmed counts і GET-only keyboard retry безwrites; після переходу наoperations refresh не читає development summary. Development і work1440/320 PNG/geometry PASS, development320 PNG переглянуто. Artifacts `/var/folders/9_/xkms65w90g57nhx8n9bhp6300000gn/T/tsukenya-portal-collections-LpEgjz/`. Початковий tail fixture мутував development після loginmetadata й правильно втрачав invalidated summary; виправлено лише порядок fixture metadata-confirmation, повторено тільки цей tail. Root додасть новийflag до свого hardened harness allowlist/full registry; власна доставка не перезаписує його lifecycle hardening.
