# B24: спільний перегляд документа

## Реалізована межа

`viewVoucher` у `app/erp.js` тепер монтує реальний React-компонент
`frontend/src/features/document-details/`. Закупівлі, продажі, склад, фінанси,
команда, джерела звітів, історія клієнта й переходи на пов'язаний документ
користуються цим самим переглядом. Окремий демонстраційний екран не додається.

Новий контракт `contracts/trading-document-details.openapi.json` і generated TS:

- `GET /api/v1/trading/documents/{id}`: реквізити, повні підсумки, кількості
  дочірніх записів і доступні дії. Немає `payload` або прихованого масиву дітей.
- `GET /api/v1/trading/documents/{id}/rows?section=…&page=…&limit=10|30`:
  поточні реквізити й одна сторінка того самого snapshot. Вісім секцій:
  рядки, складські рухи, грошові рухи, розподіли, розрахунок зарплати,
  сировина виробництва, виконання замовлення, історія резервів.
- Повна кількість і дозволені дії не залежать від відкритої сторінки. Порожня
  секція має сторінку1/1 і total0; вихід за кінець переводить на останню сторінку.
  Неправильні/дубльовані параметри відхиляються. Інші сторінки не префетчаться.

`server/erp/document_reads.py` отримує fresh actor всередині READ ONLY RR,
перевіряє роль, магазин, вид документа та network expense перед читанням
реквізитів. Звичайний сумісний GET документа та orders GET також використовують
fresh actor у snapshot, але зберігають повний старий DTO для редакторів.
Дійсна відмова ролі/магазина через HTTP має403; недоречна для виду секція400.
Cashier не отримує собівартість/value, зарплатний документ недоступний без
відповідної ролі. Private реквізити не видаються через заборонену секцію.

## Повнота даних і гроші

Count/remaining/origin/outstanding/unallocated обчислюються для всього документа
через чинні SQL aggregates та Decimal oracle. Legacy неоднозначне походження
надходження зберігає свої правила. Posted-only lineage і reversal не змінені.
Відображення не переводить грошові decimal strings у Number; ціна12.3456 та
значення за межами точної Number арифметики показуються без втрати цифр.
Ставка × units у таблиці зарплати — серверний Decimal; accrued залишається
чинним обліковим результатом.

Історичні JSON calculations/components читаються scalar projections, SQL page
до30, cursor batches до200. Кожний вибраний JSON scalar і note обмежений
4096 символами **до транспортування з SQL**: завеликий реквізит дає явну помилку
конкретного документа. Невикористані поля, зокрема великий historical JSON,
не завантажуються і не переписуються. Допустимі falsy/missing semantics
збережені; selected malformed values не замовчуються.

## Редактори, дії та B06

Кнопки відкривають чинні native editors/actions. `documentActions` тільки
відображає серверні підказки; POST знову перевіряє актуальне право. Дані для
edit/from-order/return/payment source/receipt pricing залишаються повними.
Статуси, posting, UUID, receipts, формули й migrations не змінені.
Після rebase accepted673e84d збережено TradeVoucherActions: його scalar
ідентичність id/kind/store/revision/expenseScope передається окремим
`_documentActionSource`; loading/error прибирає її. Action context/receipt
повторно перевіряє право і версію. Це не full `_confirmedVoucher` і не B06 complete.

| Caller | Actual шлях |
| --- | --- |
| Purchases / Sales / Stock | onViewDocument → viewVoucher; явний opener перед async |
| Finance / Staff | existing native action focus bridge → viewVoucher |
| Reports | openReportVoucher з додатковим current Reports grant до/після read |
| Customers / linked source | generic `data-trade=view` → той самий viewVoucher |
| Order controls | unchanged data-id/order-revision/reservation; history окремою секцією |
| Saved document | refreshDocument → bounded viewer → separate complete GET |

`_readConfirmedVoucher` виконує незалежний guarded
`GET vouchers/{id}?purpose=recovery`, чинний NativeVoucherEditor.decodeVoucher
і fresh grant після await. Тільки цей повний DTO повертається як B06 complete.
Header, page, mutation ACK або частковий child list не підтверджують baseline.
Повний GET503 залишає durable draft і показує явне повідомлення; повторного
POST немає. Відкриття документа для звичайного читання full GET не робить.

## Privacy, скасування і клавіатура

Header/page decoder звіряє exact ID/section/page/counts/shape і роль/магазин.
Валідний HTTP200 з іншою поточною роллю/областю дає403 поза generic client catch,
щоб readable sale після owner→cashier не залишив старий приватний workspace.
Перед і після читання — fresh session grant; obsolete відповіді не змінюють DOM.
Поточний401/403 синхронно очищає вікно та workspace;503 очищає рядки/дії, retry GET.

Спільні sequence+AbortController забезпечують latest-selected document, навіть
якщо transport ігнорує Abort. Escape початкового вікна під час initial header не
може відкрити нове вікно пізньою відповіддю. Route/leave скасовує initial request.
Після закриття readonly вікна фокус повертається на живий opener, зокрема після
1440→320→1440. Переходи tabs/pages — React Aria; active page оголошується status.
Дочірні native actions у React Button явно продовжують delegated click.

## Цільові докази (ізольовані дані)

Сервер: `tests/test_document_reads.py`.

- PG6 PASS2.193s: `/tmp/tsukenya-document-pg-runner.log` — fanout501,
  historical501lines/55reservations, source205/501children, JSON501,
  cached-role/privacy, реальна RR concurrency. Окремі temporary DB/role на
  перевіреному127.0.0.1:62812; cleanup виконано.
- Affected scalar/falsy/minimum/HTTP403 tail PG1 PASS0.372s:
  `/tmp/tsukenya-document-scalar-runner.log`; SQLite1 PASS0.042s:
  `/tmp/tsukenya-document-scalar-sqlite.log`.
- SQLite semantic докази: початкові2 PASS; fixture Decimal corrected і
  affected3 PASS `/tmp/tsukenya-document-read-sqlite-tail.log`.
- Unit5 PASS `/tmp/tsukenya-document-unit.log`; доданий grant-unit1 PASS
  `/tmp/tsukenya-document-grant-unit.log`. Старі5 без змінених inputs повторно не запускались.
- Storybook Empty/Error2 PASS `/tmp/tsukenya-document-stories-final.log`;
  keyboard+a11y1 PASS `/tmp/tsukenya-document-story-keyboard-final.log`.
  Initial temporary Storybook dependency-path failure виправлено окремим QA config.
- TypeScript/Vite build PASS `/tmp/tsukenya-document-grant-build.log`;
  targeted lint/format `/tmp/tsukenya-document-{lint,format}-freeze.log`.

Actual `tests/document-details-ui.cjs`, headless bundled Chromium, temporary
SQLite. Scope через `QA_DOCUMENT_VIEW_STAGE`, full runner очищає flags і
реєструє default all; сам повний runner не запускався.

| Scope | Остаточний лог / результат |
| --- | --- |
| 1440/320,30+5, full action, точна ціна, tabs, Escape focus | `document-ui-layout-focus-final.log` PASS; PNG у `tsukenya-document-view-GYtvHQ` |
| Sales return editor, Order lines/history, Finance allocations, Staff payroll, Stock components | `document-ui-callbacks-fixture.log` PASS |
| ACK→full complete; separate full GET503→reload retains draft/no secondPOST | `document-ui-recovery-footer.log` PASS |
| Page503/retry; currentrole privateclear | `document-ui-privacy.log` PASS |
| Held initial readable sale200/cashier context, zeroPOST | `document-ui-grant-final.log` PASS |
| A→B/lateA401; initial source Escape/header held | `document-ui-opening-action.log` PASS |
| Mounted close/late401 | `document-ui-late.log` PASS |

Шляхи логів мають prefix `/tmp/tsukenya-`; PNG/JSON artifacts у локальному
`$TMPDIR/tsukenya-document-view-*`, точний шлях записаний наприкінці кожного лога.
Перші невдалі artifacts збережено: fixture party.kind; footer submit selector;
React Aria propagation; focus після resize. Після правок повторювався тільки
відповідний scope. Типи/формат не є додатковою бізнес-регресією.

## Залишається поза пакетом

Повні legacy editor/source/recovery DTO навмисно не paged: authoritative terms
потребують окремої межі. Не оголошено вирішеними Reports O(N)/cache/SLA, CRM/setup
freshness, cheap child tokens/counters, capacity/VPS, backup0.1 чи entire B24.
ReadAt — час окремого snapshot, не version token. Автоматичний polling viewer
не реєструється поверх workspace coordinator. Немає production перевірок,
нових mutation algorithms, запуску всіх браузерів або full regression.

## Інтеграція accepted673e84d і тестові споживачі

Rebase зберіг accepted initiative/managed exports, full-runner flags і
TradeVoucherActions. Matching build PASS:
`/tmp/tsukenya-document-integrated-build.log`.

Один representative accepted callback tail:
`QA_VOUCHER_ACTION_FROM=callbacks tests/voucher-action-reload-ui.cjs`
PASS, `/tmp/tsukenya-document-action-compat.log` і
`/tmp/tsukenya-document-action-compat/callbacks-report.json`:
реальний post → current → explicit Done → bounded viewer, рівно1 business write,
чинна кнопка receipt pricing. Цей результат підтверджує новий scalar action bridge;
решта post/reverse/delete lifecycle перевикористовує незмінний accepted пакет122.

Підсилено opening/late proof: тестовий fetch **явно ігнорує AbortSignal** для
versioned document reads. Software fences PASS на integrated source:
`/tmp/tsukenya-document-opening-ignored-final.log` (A→B + source Escape),
`/tmp/tsukenya-document-late-ignored-final.log` (mounted close/late401).
Попередній proof із реальним transport abort не видається за цей сильніший сценарій.

`tests/document-navigation.cjs` очікує готову актуальну сторінку й перемикає
секцію через public ARIA tab. Старі Purchases/Sales/voucher-action consumers
використовують цей helper. Detail-only hooks у ERP settings, business audit,
React Sales/Reports перенесено на versioned header; full editor/source/recovery
URL залишені. Synthetic erp-recovery mocked post status відображається також у
нових header/page fixtures. Assertions про business writes, privacy і помилки
не видалені; current deny допускає повне видалення workspace, перевіряючи весь main.

Синтаксис усіх8 адаптованих test/helper файлів PASS. Повторно **не запускались**
інші scopes erp-settings, erp-recovery, react-sales/purchases/reports, business-audit
або entire voucher-action family. Це source-adapted consumers, не нові PASS для
їхніх сімей. `tests/order-reserves-ui.cjs` належить паралельному order5 пакету:
його автору передано точний history-tab/helper delta; у цьому commit файл не змінено.
