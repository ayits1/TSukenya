# React: закупівлі та поповнення

Реальний маршрут `#trade/purchases` використовує React/TypeScript workspace:
журнал замовлень постачальнику, надходжень і повернень та вкладку поповнення.
Це наступна частина STACK-EVOLUTION етапу 3 після складу. Редактор документа,
локальне відновлення чернеток, проведення, оплати й деталі документа залишаються
чинними native модулями. Решта торговельних екранів ще змішана.

## Межа інтерфейсу

- Спільні React Aria `DirectoryComboBox`, `Select`, `TextField`, `DatePicker`,
  `Button`; пошук, магазин, вид, стан і період обробляє сервер.
- Журнал: 30 заголовків на сторінку, без payload/lines/settlements у DTO.
- Поповнення: 30 груп; у картці максимум три товари. Детальний список групи
  читається окремими сторінками по 30 рядків.
- Пошук товару знаходить **всю групу**, а не відкидає інші потрібні товари цього
  постачальника/складу. Підсумки стосуються всього дозволеного фільтра.
- Native callbacks збережено: new/view/edit/save/post/reverse/delete,
  замовлення → надходження, надходження → повернення, дата/закриття замовлення,
  оплати та receipt → перевірка цін. React викликає існуючі редактори;
  формули грошей/запасів і write endpoints не змінені. Кнопка поповнення зі
  складу відкриває `#trade/purchases/replenishment` одразу на відповідній вкладці.
- `mount()` чекає required reads і відхиляє Promise за помилки. Після успішного
  запису й невдалого refresh повторюється читання, а не збереження документа.
- Late responses/ignored abort мають generation fence. Після route leave
  readonly prepare не відкриває старий редактор. Fresh 401/403 або інша policy
  прибирають приватні рядки, captions і дії; scoped store заблоковано в UI.

## Обмеження обсягу та повнота замовлення

Django `purchases_reads.py` використовує спільний stock SQL source, READ ONLY
REPEATABLE READ та fresh actor. SQL рахує групи/кількість/суми; Python зберігає
30 заголовків, до трьох preview на групу, cursor batch 100 або одну частину
чернетки до 200 рядків. Немає N+1 запитів залишку/останнього надходження на товар.
Ціна походить із останнього надходження того самого складу, інакше магазину;
потреба враховує придатний доступний запас та непокриті проведені замовлення.
Відсутня закупівельна ціна явно позначається.

У редактора вже є серверний ліміт 200 рядків. Тому група з 205 товарами має дві
**явні** частини: 200 і 5. Користувач обирає частину; readonly prepare повертає
всі рядки саме цієї частини. Кількість частин показана, кнопки перемикання
обмежені за кількістю, нічого не зберігається й не проводиться автоматично.
Позначка «відкрито» лише інформаційна й не означає, що документ збережено.

Група, lazy pages і частини зв'язані HMAC усього актуального складу групи,
query/scope/day. Зміна залишку, замовленого, ціни, товару або постачальника
повертає `409 replenishment_changed`: потрібно явно оновити групу. Немає
мовчазного зміщення offset чи обрізання рядків. Після проведення першої частини
слід оновити групу; вже замовлене виключається з нової потреби.

## Контракт і перевірки

`contracts/trading-purchases.openapi.json` →
`frontend/src/shared/api/purchases.generated.ts` через `npm run generate:api`.
Клієнт додатково перевіряє exact keys, policy/scope, decimal strings, сторінки,
HMAC/group identity, part/count/200 limit і повноту рядків. Money не рахується
через JavaScript Number. API складається з чотирьох GET `/api/v1/trading/purchases/`:
`documents`, `replenishment`, `replenishment/lines`, `replenishment/draft`.
Старий `/api/erp/replenishment` повертає явний `410 endpoint_retired` і replacement.
Активних app callers немає; стара Python-функція залишена лише як regression
oracle. `tests.test_purchases_routes`: narrow HTTP410/no-oracle/auth check PASS.

Цільові докази на ізольованих даних:

- `tests.test_purchases_reads`: PostgreSQL 9 PASS — parity із попереднім
  oracle, scalar journal, cursor100/headers30, 205 → 200+5 без перетину,
  current actor/scope/privacy, actual RR interleaving; SQLite semantic checks.
- Strict client 5 PASS і state 4 PASS: schema/paging/whole-group binding,
  stale403 після нового mount, policy drift, required read503, late prepare,
  відображений query проти ще не застосованого тексту пошуку; точні копійки
  й чотири знаки закупівельної ціни без Number.
- Storybook `Trading/Purchases`: два synthetic stories PASS, клавіатурні
  paging/tab/part/lazy-list та стан read failure. Компонент той самий, що в portal.
- Own frontend typecheck/build, scoped ESLint; bundled headless Chromium,
  реальні API і власні SQLite/DATA_DIR. Жодних виробничих даних.
- `tests/react-purchases-ui.cjs`: journal30/68 + number search + focus;
  lazy30/205 + focus; друга частина відкриває всі п'ять native рядків без POST;
  stale full-group409; native save/post/from-order/receipt-pricing callbacks;
  saved PUT + list503 → refresh без повторного PUT; late route fence;
  scoped manager320; fresh cashier403 clearing; layout1440/320 без overflow.
- Existing `tests/replenish-ui.cjs` PASS: minimum/available/open-order oracle,
  native draft/post87.50, covered-after-post, assortment keyboard save +409,
  no overflow1440/390/320. Оновлено selectors public React controls та пошук
  потрібного товару замість припущення про непагінований асортимент.
- Stock `callbacks-tail` PASS: реальний перехід одразу на вкладку поповнення
  й unsaved native order; `/tmp/tsukenya-purchases-stock-ingress-proof/`.
- Артефакти поточного проходу: `/tmp/tsukenya-purchases-proof/` —
  `primary`, `callbacks`, `late`, `scope`, `privacy`, `layout` report JSON і PNG.

```sh
npm run test --workspace frontend -- src/features/purchases/api.test.ts src/features/purchases/state.test.ts
npm run test:components --workspace frontend -- src/features/purchases/Purchases.stories.tsx
PYTHON_BIN=... QA_PURCHASES_FROM=primary node tests/react-purchases-ui.cjs
```

`QA_PURCHASES_FROM`: `all` (звичайний повний сценарій саме цього helper),
`primary|callbacks|late|scope|privacy|layout` (тільки потрібна стадія).
`QA_PURCHASES_PORT` та `PURCHASES_PROOF_DIR` ізолюють паралельний запуск.
Helper видаляє DB/PG/secret env перед hash/spawn, прибирає свою SQLite і чекає
SIGTERM; fallback SIGKILL через 5 секунд. Full-check registry має цей helper і
scrub flags, але повної регресії в межах міграції не запускали.

## Межі доказів

Це кодова інтеграція, не deployment. Немає production/capacity benchmark,
Linux screenshot baseline або повторення всіх облікових сценаріїв. Попередні
серверні posting/roles/money invariants збережені; їхні реалізації не переписані.
