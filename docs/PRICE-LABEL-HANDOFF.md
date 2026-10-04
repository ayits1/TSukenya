# Операція зміни цін → вибір цінників (пакет 2)

База: accepted #80/#81 `404149cf4603808f88bbb873cdc4b09b9d9c94bc`.
Це другий пакет issue1 §3.3. Третій пакет (накладна → явний перегляд закупівлі
каталогу) ще необхідний; прихованих змін закупівлі/продажу від накладної немає.

## Реальна взаємодія

- Масова націнка/округлення та атомарний імпорт фіксують **підтверджений** ERP
  priceContext. Pending/error зміни магазину не підміняється network fallback.
  Нове durable завантаження зберігає цей контекст у create intent; після reload
  діють початкові file hash/options/context і серверні chunk receipts.
- Після підтвердженого запису є кнопка «Переглянути цінники зі зміненими цінами».
  Durable журнал має її для фактично записаних рядків, у тому числі частково
  виконаного/скасованого імпорту. Кнопка відкриває інтегровану React Studio,
  передаючи лише kind+UUID, без цін/макета/proof з історичної квитанції.
- Основна група — реально змінена **діюча** ціна. Окрема явна група — лише
  звичайна/перекреслена ціна або позначка акції. Ще одна — нові товари, перший друк.
  Updated count і changed regular/effective pair count не названі retail delta.
- Користувач вибирає рядки/сторінки. Нові worker результати не додаються до пакета
  автоматично. Перелік до 1000 товарів, сторінка до 100; вибір не обрізається.
- «Прочитати поточні ціни» повертає авторитетний readonly знімок. Показані
  historical after та current regular/effective/display terms. Зміни після
  операції потребують явного підтвердження; hidden/missing не можна застосувати,
  їх можна явно прибрати з пакета.
- «Замінити вибір», «Додати до вибраних» або «Скасувати передавання» — окремі
  дії. Застосування ще раз перевіряє current ERP context і всі сторінки з одним
  HMAC. Пізні відповіді, новіший вибір/магазин, 503/403/malformed або stale409
  не змінюють поточні copies/layout. Нові товари отримують 1 копію, наявні
  зберігають кількість. Обмеження 1000 копій/500 на SKU — явна відмова.
- Apply лише змінює локальний вибір і підтверджений контекст, інвалідує старий
  proof/measurement. Чернетка макета й undo не змінюються. Save layout, перевірка
  перед друком та сам друк залишаються окремими явними діями.

## API й межі

`POST /api/v1/catalog/price-results/{pricing|import}/{uuid}/selection-preview`
— **readonly** запит з CSRF: `{ordinals:[1,...],page?:1,snapshot?:hex64}`.
До 1000 унікальних ordinal1..100000, page100; сервер clamping відповідає
`min(requested,pages)`. Response має whole-batch компактні IDs/counts/HMAC,
а current Product/terms лише сторінки100. Загальний current batch bounded1000.

Strict RR/READ ONLY, fresh actor, current role та frozen store authorization,
creator-only receipt, successful immutable outcomes. Legacy receipt без comparison
дає явну відмову, без вгадування before або backfill. Hidden/missing не вважаються
чинними товарами друку. HMAC охоплює context/day і terms/identity/state цілого
пакета; GET/preview не створюють registry/tasks/audit або каталожних записів.

Підпис selection review не є print proof. `labels.prepare` перевіряє current actor
**після** LedgerLock та заново збирає чинні товари/ціни/макет. Після read може
відбутися новіша зміна; її виявляє окрема prepare/output перевірка.

Strict TS decoders перевіряють operation+ordinal+Product identity, request page/
snapshot, context/day, decimal/promotion tuple, revisions, state/flags/counts.
Спільні operation pricing та Product validators повторно використані.
Native preview/create ACK також прив'язаний до frozen explicit store context.

## Невизначений запис

Atomic pricing/import lost ACK зберігає immutable UUID/body. Пізніший terminal4xx
не доводить, що перший запит не записався. Є окреме creator result GET читання;
404/error не очищає початковий intent. Тільки прочитаний підтверджений результат
дозволяє CTA/завершення. Це не підміняє commit ACK/його summary.
Read recovery має 30s abort і явне скасування читання без скасування intent.
Durable create/chunk/seal/apply/control intents теж не губляться після
lost ACK→4xx; інші writes/навігація лишаються fenced до exact підтвердження.

Studio draft/selection recovery тут у межах відкритої вкладки. Reload повертає
серверний durable журнал, але не обіцяє збереження незаписаного макета або
невизначеного atomic native intent у browser storage.

## Цільові докази

- PostgreSQL `PriceSelectionTests`: **5 PASS**,4.246s, власна
  `tsukenya_price_handoff_review` / localhost61144; `/tmp/tsukenya-price-handoff-pg.log`.
  Readonly/noaudit, staleHMAC409, hidden/missing, creator/role/store,101 paging+
  RR/READONLY trace; **реальний** prepare ledger wait → actor inactive/foreign store403.
- Pure selection decoder/quantity unit **3 PASS** + **2 affected follow-up PASS**; unrelated identity/page/snapshot/
  current terms/counts refusals, hidden unavailable, explicit add/replace and no truncation.
- Storybook **2 PASS**, StrictMode actual initial read, explicit add with copies,
  read503 and keyboard cancel. `/tmp/tsukenya-price-handoff-stories.log`.
- Native primary **PASS**, `/tmp/tsukenya-price-handoff-native.log` і
  `$TMPDIR/tsukenya-price-handoff-proof/report.json`: actual pricing commit
  lostACK→later403→GET CTA, context pending503/inert/cancel, real retail1 excludes
  rounded/manual/promo, dirty24pt/copies3 retained, cancel, fresh mismatch
  acknowledgment/final409/new read/explicit replace, schema81 atomic CSV import
  lostACK→later409→GET/new group/add. Labels.prepare requests **0**, page errors **0**.
- Native tail **PASS**, `/tmp/tsukenya-price-handoff-tail.log` і
  `$TMPDIR/tsukenya-price-handoff-tail-proof/report.json`: actual display-only
  regular13→14/retail11 unchanged, malformed200/403 refusal, keyboard add/cancel,
  late answer ignored; actual durable201 rows →100 committed then cancel,101
  pending excluded, new100 explicit add with prior copies intact. No prepare.
- PNG review1440/320 inspected, no horizontal overflow; tail720/root32px viewport
  setting checked (synthetic enlarged-layout proxy, **не фізичний пристрій чи
  вимірювання RAM/нативного browser zoom**). Physical/PDF rendering unchanged.
- Native VM jobs contract/recovery PASS (context ACK mismatch, late403 keeps frozen
  apply payload); atomic recovery VM PASS incl journal sync does not disable
  exact retry/read, cancel readonly retains original intent. Pricing decoder and
  schema81 parser targets PASS. TSC/build, scoped ESLint/Prettier, diff check PASS.
- Local browser initial runs needed sandbox TCP approval; Storybook symlink URL
  failed before collection, fixed with ignored private dependency copies. Fixture
  corrections were numeric blur, RAC button/keyboard locators, awaiting changed
  group/queued ACK and reading selected summary rather than visible product page.
  No production fixes or business policy changes came from these harness failures.

New native/VM targets are registered in explicit `npm run test:full`; full suite
**не запускалася**. No deploy/VPS/Google Sheet. Успішний primary не повторювався
після лише additive readonly cancel і display text: ці зміни перевірені окремими
VM/tail stages; незмінені серверні докази повторно використані.

## Follow-up: новіший запит контексту та скасоване читання

PricingContext має окреме покоління **запитаного** контексту. Вибір магазину,
повтор GET та скасування вибору синхронно інвалідовують попередній fence; старий
підтверджений контекст не доводить, що новіший запит завершився. Review перевіряє
live fence після кожного очікування і перед застосуванням; Studio та `adopt`
повторюють перевірку до інвалідації proof або зміни selection. Кешований контекст
не приймається як результат незавершеного fresh GET. Відмова зберігає обрані
рядки операції, копії та незаписаний макет; після скасування нового магазину
потрібне нове явне читання перегляду.

Native atomic import/pricing result READ має власне покоління, controller
identity та AbortSignal fence. Скасування одразу закінчує лише читання, зберігає
невизначений original UUID/body і дозволяє новий GET. Навіть fulfilment/rejection,
які ігнорують abort, не підтверджують скасований результат, не стирають помилку
новішого читання і не змінюють його busy стан. Запис автоматично не повторюється.

Цільові докази follow-up:

- `tests/price-label-context-race-ui.cjs`: реальний final signed preview A
  затриманий до нового requested B; delayed A відхилений, B503 зберігає inert
  та confirmed network. Keyboard cancel лишає операцію, copies3/draft24pt;
  потрібен fresh review, prepare/save **0**, page errors **0**,320 без overflow.
  `/tmp/tsukenya-price-context-race-native.log`;
  `$TMPDIR/tsukenya-price-context-race-proof/report.json` та context-error1440/320.png.
- Storybook `New Context Fences Pending Apply`: **1 PASS**,2 незмінені stories
  пропущені цільовим фільтром; StrictMode, delayed Apply, requested store503,
  copies3/prior2 retained і keyboard cancel. `/tmp/tsukenya-price-context-race-story.log`.
- VM `catalog-import-recovery.cjs` та `catalog-pricing-read-cancel.cjs`: **2 PASS**,
  ignored-abort late success/error після cancel і запуску нового READ; нове
  читання лишається busy, exact original intent лишається, фінансових attempts
  лише початковий+exact retry, наступне підтвердження GET-only.
  `/tmp/tsukenya-price-read-cancel-vm.log`.
- TSC/build, scoped ESLint/Prettier, JS syntax/diff check PASS. Backend source
  не змінювався; PostgreSQL та успішні broad primary/tail proofs повторно
  використані. Full suite, VPS та shared Sheet не виконувалися.

Перші нові harness runs уточнювали exact-локатор повідомлення (UI додає
пояснення про збережену чернетку); перший Storybook filter не відповідав
відображуваному імені story і не запускав тест. Фінальні цільові результати
стосуються поточного source/bundle; фізичний друк та пристрій не перевірялися.


## Інтеграція з актуальним порталом · 04.10.2026

Пакет інтегровано поверх PR86 (виправлення початкового завантаження) та P1 voucher drafts. Автоматичне злиття зберегло single-flight bootstrap, subscription cleanup і metadata identity handling. `portal-validator.cjs` PASS; matching TypeScript/Vite build PASS.

Три нові browser harness перенесені на bundled Chromium Playwright `headless: true`, без `channel`, `executablePath` та системного Chrome. Статична policy перевірила 199 файлів. Full runner видаляє успадкований `QA_ARTIFACTS`; нові сценарії вже зареєстровані, full suite не запускали.

Актуальна вузька перевірка `price-label-context-race-ui.cjs` PASS на інтегрованому коді та ізольованій базі: delayed signed Apply A відхилений після нового запиту B, B503 не підмінено кешованим A; keyboard cancel зберігає copies3 та dirty24pt; fresh review потрібний; 320 без horizontal overflow, prepare/save 0, page errors 0. Артефакти `/tmp/tsukenya-price-integration-context/`. Незмінені backend/unit/Storybook та primary/tail докази вище повторно використані; старі browser reports не оголошуються новим запуском. VPS/Google Sheet не змінювалися.
