# B06 P1: manifest native редакторів і reload transitions

Початкова база реалізації — `1a62781` (P0 integration); пакет інтегровано поверх `db76a37` з виправленням початкового завантаження порталу. Це manifest імплементації; **P1 загалом ще не завершено**. P2/P3 не підмінюються цим пакетом.

| Реальний consumer | Whitelist capture / identity | Restore / read / confirmation boundary | Стан та докази |
| --- | --- | --- | --- |
| `erp.js:voucherForm` → `erp-voucher-recovery.js:create` | Raw named voucher fields, stable line_key/reference_line, payments, payroll selections; original baseline/revision; frozen first UUID/body; confirmed ID; postUnknown | Fresh session + kind/store policy; frozenCREATE identity окремо від current GET; original raw input зберігається, Save після reload existing/confirmed/unknownUpdate лише після явного review/Apply; unknown post тільки status GET | Реалізовано initial family; primary partial, barriers, post, postDraft, cold, privacy (див. нижче) |
| `erp-payments.js:form` → той самий recovery | Raw amount/note/date/context, explicit allocation rows/source IDs, pinned reference; initial key/body окремо від newer invalid strings | Не переобчислювати allocation за поточними боргами; current source policy/read, exact retry initialbody; Apply локальний, Save окремий | Реалізовано тим самим codec/machine; payment частина tail-partial, explicit allocations capture; економіка розподілів не змінювалась |
| `erp-production.js:attach` в voucher form | Explicit immutable approved terms/version і raw planned/actual components/expiry reason; legacy frozen recipe; ready/pending state не перетворюється на authority | Hydration з frozen version, fresh access/immutable version read; source snapshots не remap за назвою товару; browser не обчислює COGS | Реалізовано всередині voucher family; production-report: invalid quantities, stable line UUID та frozen immutable version |
| `erp.js:entityForm` / native entity adapter | Explicit raw all5 resources/contact/rate, original baseline, durable first UUID/body/revision | Fresh RR context + creator-bound receipt/tombstone, currentGET/Apply окремо; unknown UPDATE без blind replay; cold/warm privacy | Реалізовано окремим entity package; targeted proofs і частковий primary чесно описані у `ENTITY-DRAFT-PERSISTENCE.md` |
| `erp.js:workShiftForm` / native workShift | Employee/store/cashShift raw terms+units, original revision/key/body | Fresh RR salary-role context; frozen CREATE receipt/identity; confirmed ID/current read/Apply/Save; UPDATE unknown readonly recovery; P0 raw/privacy | Реалізовано workShift family; докази/часткові native межі в [WORK-SHIFT-DRAFT-PERSISTENCE.md](WORK-SHIFT-DRAFT-PERSISTENCE.md) |
| `recipe-editor.js:open`, `erp-production.js:recipeForm` / native recipe | Raw components/approved-version reason/output, old catalog/revision, first key/body | Legacy unknown update readonly compare; approved CREATE exact receipt; Apply без POST | Реалізовано обидва modes; див. `RECIPE-DRAFT-PERSISTENCE.md` |
| `planning-category-editor.js` / native planningCategory | Mutable name/active, immutable UUID/semantic/aliases, first body/key | Independent category dialog; creator identity підтверджено до currentGET, явний Apply/окремий Save; raw/context privacy | Реалізовано category family; exact coverage у `CATEGORY-DRAFT-PERSISTENCE.md`, monthly/template ще відкриті |
| `monthly-budget.js` / native monthlyBudget | Month/store/ID, ordered stableUUID rows, raw revenue/amount/rate; original terms/key | Facts/history не editablecache; remove-v-change явно; confirmedGETbarrier | Відкрито; наступний P1 пакет |
| `budget-template.js` / native budgetTemplate | Raw count/expense fields, independent count/optional label revision guards, first body | Count revision не label token; current GET, separate Apply/Save | Відкрито; наступний P1 пакет |

## Спільні переходи, які має довести кожна сім'я

1. Явний raw capture синхронно на input/change та після програмних add/remove/select/apply переходів; Save-validator окремий. Credential/cache/permission grants не серіалізуються.
2. До send: first body/key/revision та newer raw input одним durable record; quota failure блокує fetch. Unknown після втрати ACK/reload → тільки той самий firstkey/body, type=button не валідовує новіші required fields.
3. Підтвердження write → confirmed identity/read barrier. GET/list503 ніколи не приводить до нового POST. Unknown→пізніший4xx не стирає original intent; receipt identity read окремий від current revision.
4. Unknown post → status GET до original document; не PUT нові поля й не автоматичний post. Якщо сервер лишив draft, окреме явне post перевіреної revision.
5. Cold reload → доступна користувачу кнопка/route відновлення, fresh current session і resource policy, explicit Restore без бізнес-write. Existing/confirmed stale baseline потребує окремого current GET/Apply/Save.
6. Close recovery dialog зберігає вже відновлений editor. Lifetime/session fences приховують його; повернення до тієї самої живої форми після focus допускається лише після fresh same-session resource policy. Це не cold reload autoRestore і не autoSave.
7. Discard/confirmed success cleanup явні; pending intent іншої форми не стирається через resource403. Late reads/render/navigation не монтують приватне введення після cancel/revocation.

Цільові докази initial family: actual CREATE committed→lostACK→reload→explicit Restore→newer invalid input→exact original retry/identity; existing PUT ambiguity→reload→currentGET/Apply; confirmedSave→list/detail503→reload→GETonly; save+postUnknown→reload→statusGET; allocation/source IDs і production terms/stablelinekeys preserved; session401/role/store loss; клавіатура/вузький320 та широкий1440. Незмінені economics/ledger докази повторно не запускати.


## Реалізована межа initial family

`GET /api/erp/vouchers/recovery-context` підтверджує fresh actor/kind/store/expense-scope у реальному READ ONLY REPEATABLE READ. `editing.canEdit=false` через raw date, закритий період чи inactive store **не є відмовою у перегляді**: форма лишається для дозволеного читання/введення, а actual Save/Post проходять чинні серверні перевірки. Existing ID читається через чинний `?purpose=recovery`. Збережена виробнича версія перевіряється окремим read та не замінюється новішою.

Live перша достовірно відхилена CREATE спроба має новий additive HTTP400 proof `{error,write_rejected:true,request_key,kind}`. Wrapper охоплює лише `save_voucher` після rollback його atomic block; Conflict409, authorization403 та збій DTO після commit не отримують proof. Strict decoder прив'язує proof до frozen kind/key конкретної спроби. Лише live machine, який ще не мав unknown, може звільнити intent і дозволити корекцію. Після unknown/reload будь-який наступний400 лишає original intent. Proof не доводить глобальну відсутність ключа; `identity.confirmed=false` так само її не доводить.

Warm return використовує спільний `RecoveryController.verify`, fresh session та ті самі resource403/global401/role/store і late-cancel правила, **без повторного renderer Restore**. 503/malformed не стирають записи. Public gate приховує body/footer/private heading; лишає GET-only retry та Close. Cold restore з іншого маршруту очікує тільки відповідний actual `tsukenya:trading-mounted {tab}`; bootstrap/draw failure, abort, зміна маршруту та 30-second timeout завершують очікування. Listener прибирається; перед DOM і після async renderer перевіряється Signal. Після провалу same-route mount можна явно перечитати розділ/відновити, без business write.

Явний whitelist охоплює business named fields, committed directory IDs, stable line UUIDs, reference-line IDs, payment/allocation amounts і джерела, payroll IDs, immutable production terms та raw quantities/reasons. Тимчасовий текст пошуку directory combobox і позиція скролу не серіалізуються та не перетворюються на committed ID. Відновлення не підставляє поточні ціни/борги/норми замість frozen полів. Credentials, csrf/session cookies, full catalogue/cache, COGS/results і permission grants не зберігаються. До200 lines/payments/allocations, до1000 raw payroll IDs та загальні P0 byte/node/record limits — failclosed без truncate.

## Фактичні цільові докази

Артефакти: `/private/var/folders/9_/xkms65w90g57nhx8n9bhp6300000gn/T/tsukenya-native-draft-proof/`.

- `primary-partial.json`: 2 actual expense cases CREATE committed/lostACK/reload/exact same UUID/body/no duplicate та local GET/Apply/separate Save/confirmed read cleanup. Початковий primary зупинився на виправленій payment account fixture; **це не terminal full primary PASS**.
- `tail-partial.json`: actual payment committed/lostACK/reload/invalid newer fields/later closed-period4xx/exact body/readonly identity. Tail зупинився на іншому post case, який далі перевірено окремо; не full tail PASS.
- `barriers-report.json`: terminal 3 cases — unknown existing PUT + GET503→GET retry→explicit Apply→separate Save; quota before-send blocks financial fetch; confirmed CREATE + bootstrap503→reload confirmed-ID/currentGET barrier.
- `post-report.json`: terminal Save+Post committed/lostACK→reload→status GET posted; один CashEntry, no PUT/repost, newer local note readonly.
- `postDraft-report.json`: terminal unknown post remained draft + separate server edit→reload/status GET→explicit current revision2 POST; no PUT of newer local note, один CashEntry.
- `privacy-report.json`: terminal actual renderer1440/320, ordinary focus GET authorization without repeated Restore; warm resource503 hides private body/footer/heading and leaves public GET retry/Close; retry same local form; actual session401 erases records/no write.
- `cold-report.json`: terminal overview→explicit Restore→authorized finance renderer; failed bootstrap terminates pending; cancelled/navigation late mount rejected.
- `production-report.json`: terminal actual approved recipe renderer, empty invalid output/planned/component quantities + stable line UUID after reload; newer approved version does not replace the frozen original; no business write.
- `validation-report.json`: terminal first actual closed-period400→correct amount after permitted reopen→one CREATE, no stuck rejected-intent loop. Later4xx after ambiguity is covered separately by payment proof.
- `native-draft-1440.png` та `native-draft-320.png` переглянуто; restored expense modal fits width, controls use existing44px system. Physical screen readers/other browser engines не перевірялися.

Backend: `tests.test_voucher_drafts` initial PG2 PASS (0.301s); changed future-date boundary test alone PG1 PASS (0.158s); new `test_first_create_validation_proof_is_bound_and_not_emitted_after_commit` PG1 PASS (0.132s), including deliberately failed serialization after committed CREATE without no-write proof. Own isolated `tsukenya_native_drafts`, no production mutation.

Typed raw/domain decoder initial4 PASS; new rejected-proof/key/MAX_SAFE_INTEGER test PASS; after stricter key binding affected ACK fixture retargeted and single ACK test PASS (other4 earlier successful inputs reused). Shared async renderer and warm verify denial/cancel/session-change targeted2 PASS. TypeScript, changed TS lint, generated trading types, own matching Vite build, JS syntax and diff checks PASS. P0 RecoveryPanel visual states unchanged; reused P0 Storybook/keyboard proof, no repeat of unchanged broad family.

Native commands (disposable SQLite18273, matching frontend build; bundled Chromium Playwright headless, без channel/executablePath; browser/server закриваються у finally):

```sh
PYTHON_BIN=/tmp/tsukenya-review-venv/bin/python QA_OUTPUT_DIR=/private/var/folders/9_/xkms65w90g57nhx8n9bhp6300000gn/T/tsukenya-native-draft-proof node tests/native-draft-reload-ui.cjs
# Affected independent stages; validate before creating temp/server:
QA_NATIVE_DRAFT_FROM=barriers # or payment/post/privacy/cold/production/validation/postDraft/opening
# same command with that explicit variable; tail is legacy partial-family option.
```

В explicit full registry додано base та незалежні barriers/cold/production/validation/postDraft/opening stages. Успадкований `QA_NATIVE_DRAFT_FROM` видаляється; кожен окремий stage отримує власне значення. План перевірено через `npm run test:full -- --plan`; повну регресію під час цієї інтеграції не запускали. Unchanged money/ledger/concurrency/posting tests reused; algorithms/locks не змінювалися. P1 entity/workShift/recipe editor/category/monthly/template та P2/P3 **залишаються відкритими**; shared codec enrollment цих сімей не замінює.


## Інтеграційне рев’ю · 04.10.2026

- Знайдено й усунено гонку звичайного New/Edit: `voucherForm` зберігає контекст маршруту/покоління/modal **до** перевірки сесії та відкидає застаріле відкриття після відповіді. Це також захищає payment delegation. Cold restore зберігає перевірку abort signal.
- `opening`: сценарій із затриманою сесією та переходом Фінанси → Закупівлі відтворив дефект до правки (1 зайва modal); після правки PASS, бізнес-запитів на запис 0. Артефакти `/tmp/tsukenya-native-integration-opening{,-before}/`. Незалежне рев’ю підтвердило закриття зауваження.
- Поточні scoped unit: 19 тестів voucherPersistence/recovery PASS; TypeScript і matching Vite build PASS. PostgreSQL `tests.test_voucher_drafts`: 3 PASS на окремій тестовій базі.
- Browser-policy: 193 файли PASS, жодного системного Chrome. Report записує actual git HEAD та ознаку незакомічених змін замість застарілої константи бази.
- Інтегрований `cold-report.json` PASS: відновлення з огляду, bootstrap503 та скасування пізнього монтування. `/tmp/tsukenya-native-integration-cold/`.
- Інтегрований `primary-partial.json`: 4 завершені кейси витрати/платежу/exact retry/GET-Apply-Save/posted-once. Фінальний privacy case зупинився через дві тестові чернетки; його ізоляцію виправлено, окремий `privacy-report.json` PASS (3 кейси, 1440/320, GET-only retry, session401). Повторно успішні фінансові кейси не запускали; **цілий primary run не оголошується PASS**. Артефакти `/tmp/tsukenya-native-integration-primary/` та `/tmp/tsukenya-native-integration-privacy/`; обидва актуальні PNG оглянуто.

## Recipe editors · 05.10.2026

Обидва реальні режими спільного `TradeRecipeEditor` підключені до P0. Raw whitelist, stable component UUIDs, frozen approved CREATE, legacy unknown UPDATE comparison, confirmed read barrier та fresh privacy описані з окремими цільовими доказами в [RECIPE-DRAFT-PERSISTENCE.md](RECIPE-DRAFT-PERSISTENCE.md). Це не закриває інші ще відкриті сім’ї B06.
