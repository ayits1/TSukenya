# B06: відновлення полів статей витрат після reload

Окремий expense пакет від count delivery `2cdbdc4`, власна гілка `codex/expense-draft-reload`. Не містить пізніші root виправлення count/monthly/sales; їх інтегрують окремо. `native-expense-v1` підключено до прийнятої P0 foundation: **та сама вкладка й чинний сеанс**, явне Restore. P2/P3 загалом, browser restart/cross-device, backup0.1 не оголошено виконаними.

## Фактичні споживачі й авторитет

| Споживач | Збережені поля | Бізнес-запис |
| --- | --- | --- |
| `portal.js` inline amount/category | Raw amount/committed category, original поля/ревізія одного рядка; незалежні units | Чистий one-field PATCH з If-Match; уже незбережені інші units переходять у спільне явне узгодження та окремий Save |
| `portal.js` new-name/Create | Raw назва/група, локальний UUID, frozen перші terms/body/order | Чинний POST `/api/expenses`, LegacyCreateReceipt і creator identity |
| `LegacyEditors.edit/update/reviewCreate` для expenses | Raw name/group/amount/category, original row revision, frozen first intent | Реальний окремий expense діалог; current GET → локальний Apply → окремий Save |

`GET /api/v1/portal/records/expenses/:id`, bounded collection context і `/api/v1/portal/create-identity` залишаються existing fresh-actor/READ ONLY RR/network-owner API. Backend цього пакета змінено **лише** для static allowlist/injection модуля. Грошові Decimal validation/максимум/копійки, ролі, revisions, ledger/audit, receipt/tombstone та settings/count/optional label guards не змінено. Expense PATCH використовує власну ревізію рядка, а не count чи label token. Формули/факт/суми бюджету не зберігаються в draft.

Destructive DELETE і його existing confirm/current-read workflow **не enrolled як durable intent**; незбережені поля його старого delete-specific failure dialog не є доказом цього пакета. Успішний/невідомий DELETE не видається за відновлюваний expense PATCH. Generic tasks/ideas LegacyEditors і решта P2 залишаються окремою роботою. Artifact локальний fallback не мігрувався на серверний codec.

## Whitelist і переходи

- Strict versioned codec дозволяє тільки local record UUID/key, nullable original ID/revision, original name/group/amount/category, safe order, список units/review, незалежні raw strings, frozen first method/path/body/revision та підтвердження. Credentials/CSRF/session cookies, grants, totals/facts/cache, comparison choices не серіалізуються. P0 limits діють без truncate.
- Raw capture синхронний на input/change. Text+decimal input зберігає `1..2`, `-`, порожнє та новіше некоректне введення. Save validator окремий; comma money adapter зберігає копійки. Селект зберігає committed category/group; невідоме stored значення явно показане некоректним, а не підмінене довідником.
- До приватного DOM fresh P0 session/resource read; початковий record/route зафіксовано перед await. Body/heading і inline financial panel приховані під час перевірки. Після останнього awaited session безпосередньо перед mutation fetch: generation/hash/live/visibility/abort/session binding. Issued obsolete401 відсікається **до** invalidation/redirect.
- First UUID/body durable до fetch; storage/quota failure блокує POST/PATCH. CREATE exact retry повторює лише original UUID/body попри новіше invalid raw. UPDATE unknown не має blind retry: current read/comparison, explicit Apply та новий окремий Save з current revision. Перший expense4xx не має нового no-write proof, тому автоматично intent не звільняється; для корекції UPDATE потрібен current/Apply. Невідома CREATE спроба зберігає immutable intent до identity або явного Discard.
- Positive creator identity з original snapshot підтверджується durable **до незалежного current GET**. Current503/reload не повертає CREATE CTA. Історичний positive ID без original теж durable блокує CREATE, але не вигадує baseline/revision/three-way comparison; поточне читання лише для перегляду.
- Strict ACK прив'язаний до submitted intent. Confirmation не є current baseline; matching current ID/revision/terms + відсутність новішого raw прибирає completed record. Новіше invalid raw зберігається. Apply змінює тільки local baseline/raw, не сервер; переходить від створеного запису до його ID без залишкового CREATE alias. Наступне додавання в тій самій групі має новий UUID.
- Inline recovery відкриває enrolled units. Якщо інше enrolled поле вже має незбережений raw, наступна inline правка об’єднує units і вимагає явного current/Apply/Save без auto-PATCH; invalid raw зберігається. Незмінені інші поля disabled і не потрапляють у PATCH/merged raw. Full editor зберігає чинні atomic financial terms. Known confirmed input очищається тільки коли користувач не замінив його новішим.
- Session401/role/store/epoch зміна застосовує P0 глобальну privacy. Same-session resource403 — тільки denied record; дозволені raw/unknown intent не стираються на503/malformed. Maps перевіряють існування durable record, щоб erased RAM не розкрилася повторно. Cancel/Close/route не приймають late read/ACK/401 та не встановлюють baseline.
- Close лишає draft для explicit Restore; Restore/Apply не пишуть бізнес-дані. Орphan inline Discard прибирає і durable record, і inline map тільки після успішного storage remove; failure пояснений, raw лишається, panel повторно авторизується. Видалення draft не є серверним rollback.

## Докази, які справді виконано

Нові TS unit **6 PASS**, TypeScript/scoped ESLint/Prettier, matching build `/tmp/tsukenya-expense-draft-build.log`, syntax/diff і browser-policy PASS. Незмінений shared comparison/RecoveryPanel використовує прийняті Storybook/keyboard proofs; нової реалізації спільного control немає.

| Артефакт | Перевірений сценарій |
| --- | --- |
| `/tmp/tsukenya-expense-reload-proof/primary-partial.json` | Actual invalid inline raw → cold Restore з огляду; actual LegacyEditors full поля/Apply/окремий Save, trimmed name/копійки та unrelated row. **Primary не terminal PASS**: зупинився на obsolete201 fixture; affected ACK повторено окремо |
| `/tmp/tsukenya-expense-ack-proof/ack-report.json` | Committed CREATE200/malformed ACK → newer invalid raw/reload/same UUID/body; creator identity durable → currentGET503 → reload, один CREATE; actual1440/320/44px. `expense-320.png` переглянуто, natural flow без horizontal overflow |
| `/tmp/tsukenya-expense-inline-units-final/inline-report.json` | Actual amount blur exact one-field PATCH; committed UPDATE/malformed ACK → reload → keyboard current choice/Apply без запису → окремий current-revision Save; unrelated row/category збережені; unrelated fields disabled, Restore focus на editable amount |
| `/tmp/tsukenya-expense-privacy-proof/privacy-report.json` | Actual owner→accountant resource403: private hide/changed-session erase/no writes; actual session deletion/read401→login/storage erase |
| `/tmp/tsukenya-expense-guard-proof/guard-report.json` | First-intent quota failclosed; затриманий останній session await +pagehide → zero mutation/private hide |
| `/tmp/tsukenya-expense-cancel-proof/cancel-report.json` | Cancel затриманого resource read→obsolete401: no redirect/comparison/baseline adoption; GET-only retry показує дозволений raw |
| `/tmp/tsukenya-expense-create-apply-final/create-apply-report.json` | Confirmed CREATE → local Apply → separate UPDATE; наступне same-group Add — fresh UUID/body, не старий created ID |
| `/tmp/tsukenya-expense-discard-terminal/discard-report.json` | Actual orphan Discard: failed local removal лишає raw/видиме recovery; наступний успіх прибирає durable й inline draft, zero business writes |

Initial affected failures (201 fixture, RAC pointer radio, immediate second-Add assertion, discard reauthorization timing) збережено окремо; вони не видані за PASS. Після source змін unit-only historical-null identity залишено unit доказом, не native/production claim.

`tests/expenses-ui.cjs` ретаргетовано до text amount та actual currentGET/Apply/separateSave; інші layout/копійки/pending/delete/count/formula/roles assertions збережено. Весь старий сімейний script **не повторювався** і не оголошено PASS. Root реєструє нові independent stages у full runner; цей пакет сам full не запускав.

Незмінені backend докази reuse: `tests.test_legacy_create_identity` (creator/current actor/private expenses/safe snapshot/RR/no audit/PG one receipt), `tests.test_budget.BudgetTests.test_expense_validation_merged_patch_and_owner_access` і exact max-cent validation, `tests.test_legacy_records` (required/stale revisions/whitelist/unrelated metadata, no resurrection/current scope/readonly/PG one-winner). Немає нового backend business diff — зайвий PostgreSQL/concurrency запуск не потрібен. Це не capacity/physical screen-reader/cross-browser/offsite backup доказ.

```sh
# Disposable SQLite18285, bundled Playwright Chromium headless; awaited signal-aware teardown.
env -i PATH="$PATH" PYTHON_BIN=/tmp/tsukenya-review-venv/bin/python \
  QA_EXPENSE_DRAFT_FROM=ack QA_OUTPUT_DIR=/tmp/tsukenya-expense-ack-proof \
  node tests/expense-draft-reload-ui.cjs
# Independent changed scenario only: inline|privacy|guard|cancel|create-apply|discard.
npm run test --workspace frontend -- src/shared/native/expensePersistence.test.ts
```

Немає full suite, production/Sheet/VPS mutations, push/PR/deploy. Template count і editable expense fields мають actual enrollment; повний B06/P2/P3 через це не закрито.


## Незалежне рев’ю expense `1f2bb428` · виправлення

Власний review checkout `/tmp/tsukenya-expense-review`; frozen author clone не змінено.
Source review підтвердило whitelist, immutable CREATE/UPDATE intent, creator receipt,
durable ACK перед current GET, server revision та окремий Save. Знайдені й виправлені
такі межі:

- Resource preflight тепер прив’язано до **того самого** P0 actor/session для context,
  current та identity. До виправлення реальний повторний login між P0 check і resource
  session відкривав raw попереднього сеансу. Negative proof збережено в
  `/tmp/tsukenya-expense-review-session-before/`; після виправлення старі DOM/storage
  недоступні, бізнес-записів немає.
- Inline й manual no-stored opening перевіряють generation після кожного await;
  збережений authorize результат прив’язаний до конкретного restore signal. Поточний
  inline resource403 повторно читає P0 actor; obsolete401 після suspend/pagehide не
  перенаправляє й не стирає інші дозволені чернетки.
- Invalid amount → category раніше перезаписував units на category, робив суму
  недоступною і ламав comparison через зайвий `decimals:['amount']`. Negative proof:
  `/tmp/tsukenya-expense-review-units-before/`. Тепер raw та units зберігаються разом;
  mixed inline input вимагає явного review, metadata відфільтровано разом із keys.
- Apply копіює тільки selected units, хоча shared comparison повертає повну server
  projection. Invalid raw може пройти локальний Apply; грошову валідацію виконує Save.
  Під час comparison поля заблоковані, тому нове введення не замінюється старим snapshot.
  Cancel знову дозволяє введення. Local quota failure не встановлює новий baseline/raw.
- Strict codec відхиляє array/object замість string group, без `String(...)` coercion.

### Вузькі докази review

| Артефакт | Результат |
| --- | --- |
| `/tmp/tsukenya-expense-review-session-final/review-session-report.json` | PASS: actual новий login між P0/resource, no private DOM/old storage/no writes |
| `/tmp/tsukenya-expense-review-generation-final/review-inline-generation-report.json` | PASS: inline obsolete401/pagehide, no-stored opening/suspend, authorized retry, current403 після реальної зміни owner→accountant |
| `/tmp/tsukenya-expense-review-units-final/review-units-partial.json` | Перші **два завершені сценарії PASS**: чистий amount-only PATCH; mixed invalid raw/union/current/Apply/invalid Save/окремий valid Save. Це partial, не terminal PASS: наступний category fixture стартував до завершення refresh і отримав409; він винесений та перевірений окремо нижче |
| `/tmp/tsukenya-expense-review-category-final/review-category-report.json` | PASS: category-only committed malformed ACK, frozen exact body, current/Apply без decimal error; unrelated server name/group не замінюють raw і не потрапляють у PATCH{} |
| `/tmp/tsukenya-expense-review-apply-final/review-apply-report.json` | PASS: comparison lock, keyboard Cancel, quota failure атомарного Apply, retry Apply; zero business writes |

Останні правки після category proof стосуються лише current inline403 та блокування
полів під час comparison; їхні окремі targets пройшли, уже успішні бізнес-сценарії
повторно не запускалися. Native reports містять source/dist hashes. Full suite і
старі сімейні сценарії не запускалися. Backend/postings не змінено, тому прийняті
server/PG докази лишаються застосовними. Shared controls/CSS не змінено; це не новий
layout/cross-engine доказ. DELETE і загальне завершення P2/P3 лишаються поза цим пакетом.

TS codec tests **7 PASS**; matching frontend build (включає TypeScript), scoped ESLint,
Prettier, JS syntax/diff перевірені. Початковий ESLint не знайшов локальний workspace
`@eslint/js`; після підключення наявних lockfile dependencies scoped lint PASS,
пакети не оновлювалися. Артефакти `/tmp/tsukenya-expense-review-build.log` і
`/tmp/tsukenya-expense-review-static.log`.

Незалежні native scopes для full runner реєструються root адитивно: `review-session`,
`review-inline-generation`, `review-units`, `review-category`, `review-apply` через
`QA_EXPENSE_DRAFT_FROM` (ця змінна має бути scrubbed перед повним прогоном). Приклад
вузької команди: `QA_EXPENSE_DRAFT_FROM=review-apply node tests/expense-draft-reload-ui.cjs`.

## Інтеграційна перевірка

Пакет адитивно інтегровано поверх прийнятих React Finance/Sales і recovery count.
Matching frontend build PASS; реальний ізольований `review-apply` із цією збіркою
PASS: блокування comparison, keyboard Cancel, quota failure без прийняття raw/baseline,
окремий атомарний Apply без бізнес-записів. Артефакт:
`/tmp/tsukenya-expense-root-reviewed-apply/review-apply-report.json`.
Browser-policy, JS syntax/diff та full runner лише `--plan` PASS.
Registry містить primary і одинадцять незалежних хвостів; `ack` не повторює
покриття primary. Це реєстрація майбутнього повного прогону, а не виконання suite.
