# Сумісність native Staff перевірок із React маршрутом

Тестова адаптація для прийнятого `7d640ead7846a9d9d484e91e3450fff42cd4ccf5`
і Staff delivery `2d6ccc1041c4831d29f4eb39120d6b9fb2cb9fe1`.
Локальна залежність після additive інтеграції Finance/Staff —
`e1a49ac76b21974747b4411b67c8e95454597d41`; її не потрібно переносити як
тестову доставку. Власний commit містить лише тести й цей документ.

## Збережена межа

`tests/staff-navigation.cjs` відкриває реальні вкладки «Працівники», «Табель»,
«Документи» й публічні дії React Staff. Він чекає завершеного читання, а не
викликає native dispatcher або глобальний mount. Для зарплатних документів
native Employee ComboBox вибирає видиму опцію з точним ID; assertion перевіряє
committed hidden ID, який потрапляє у native FormData.

| Consumer | Адаптація; попередні бізнесові assertions збережені |
| --- | --- |
| bounded-directories-ui | Реальні 30-row employee pages/search; неактивний pinned employee і captured terms; delayed opening |
| erp-date-boundary-ui | Публічні work/payroll дії; Kyiv date bounds і native employee choice |
| entity-draft-reload-ui | Employee Add/Edit через React; у repeated fixtures унікальні назви для точного вибору |
| shift-browse-ui | Реальні DatePicker segments; history query/date збережені після native Save; payroll selection across pages |
| ui-audit | Employee/work/payroll launchers; ізоляція env до password helper і awaited server teardown |
| work-shift-conflict-ui / multiple-work-shifts-ui | Реальні work actions/table region; B04 receipt/two-till/payroll і B06 assertions залишені; wrapper незмінений |
| workshift-draft-reload-ui | Публічне відкриття initial/update forms; reload/privacy/intent assertions залишені |
| trade-dialog-ux | Публічні дії й Employee ComboBox; 0 < units ≤ 10 через чинний shared capture codec замість вилучених HTML min/max; fixture UPDATE використовує current revision |
| directory-toolbar-ui | React filters із exact GET query IDs замість відсутніх native filter FormData; width/44px/gap/overlay/keyboard assertions залишені |
| entity-conflict-ui | Два додатково знайдені employee-table consumers; public Edit і initial malformed-payterms refusal |
| crm-ui | Додатково знайдений payroll launcher; суми 401/301, cash/reports assertions незмінені |

`trading-document-controls.cjs` знає salary document labels і Staff readiness.
Фінансові selectors і реальні native cash/payroll chooser selectors залишені.
У stale-response stress сценарії required native Employee ComboBox не має
публічного Clear. Тест навмисно очищає underlying ID через
`selectOption('', {force:true})`, як synthetic native change; це перевірка
старого callback fence, а не доказ доступної користувачеві кнопки очищення.

## Фактичні вузькі докази

Використано **власний matching tsc/Vite build** цієї залежності;
manifest SHA256 `5d27183c698d0e7491f52fb30a0f36edfb478c70b68401c483072c6d4a3d2de1`.
Build log `/tmp/tsukenya-staff-compat-build.log`.
Тільки disposable SQLite, Playwright bundled Chromium, `headless:true`.

1. `QA_DIRECTORY_TOOLBAR_ONLY=staff-1440,staff-320`:
   desktop PASS збережений у `/tmp/tsukenya-staff-compat-toolbar/report.json`.
   Цілий запуск **не PASS**: mobile Enter спочатку випередив актуальну searched option.
   Виправлено очікування у тесті. Лише affected320 повтор:
   `/tmp/tsukenya-staff-compat-toolbar-tail/report.json` — terminal PASS;
   staff320 toolbar/popup PNG переглянуто. Цей tail також завершив чинні
   native cash-dialog 1440/390 assertions (вони залишилися у скрипті).
2. `QA_WORK_DRAFT_FROM=conflict`:
   `/tmp/tsukenya-staff-compat-b06/conflict-report.json` — terminal PASS.
   Actual two409, raw/reload, local Apply без POST, окремий Save; 3 write attempts.
3. `QA_SHIFT_BROWSE_ONLY=1`:
   `/tmp/tsukenya-staff-compat-shift-browse-final.log` — terminal PASS.
   130cash/520work, старий active till через bounded lookup, DatePicker→old row,
   selected cash across pages, native320/390/1440, payroll multi-page selection
   і late native ID-clear response guard. PNG: `/tmp/tsukenya-work-history-320.png`,
   `/tmp/tsukenya-work-history-390.png`, `/tmp/tsukenya-work-history-1440.png`.
   Попередні failure logs збережені: `shift-browse.log`, `shift-browse-tail.log`,
   `shift-browse-tail2.log`, `shift-browse-tail3.log` під prefix
   `/tmp/tsukenya-staff-compat-`. Виявлено саме старі visible-select/choice-universe
   assumptions; assertions перенесені на реальні controls/committed IDs.
4. `node --check` для всіх 14 listed/helper CJS, включно незміненим multiple wrapper,
   та `git diff --check` — PASS. `rg` не знаходить старих Staff-only
   `data-trade=work-shift`, `data-directory-table=employees`, `data-kind=payroll`
   у `tests/*.cjs`.

Команди відтворення (Python через `PYTHON_BIN=/tmp/tsukenya-review-venv/bin/python`):

```sh
QA_DIRECTORY_TOOLBAR_PORT=18737 QA_DIRECTORY_TOOLBAR_ONLY=staff-320 DIRECTORY_TOOLBAR_PROOF_DIR=/tmp/tsukenya-staff-compat-toolbar-tail node tests/directory-toolbar-ui.cjs
QA_PORT=18738 QA_WORK_DRAFT_FROM=conflict QA_OUTPUT_DIR=/tmp/tsukenya-staff-compat-b06 node tests/workshift-draft-reload-ui.cjs
QA_PORT=18739 QA_SHIFT_BROWSE_ONLY=1 node tests/ui-audit.cjs
```

## Reuse і межі

Staff source PG math/scope/RR, 8 units, stories, own1440/320/read403/late401/coldrestore
докази з `docs/REACT-STAFF.md` повторно не запускали: бізнесові inputs не змінені.
Повний regression, CRM all-routes, весь B04 wrapper, date-boundary suite, усі
entity/privacy families, enlarged-text Staff toolbar і весь bounded-directory
набір **не запускали**. Точкові edits інших consumers перевірені source/syntax;
це не claim їх повного PASS. Збережено всі початкові assertions; нових production
aliases, skip або business source змін у цій доставці немає.
