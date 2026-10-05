# Reports: межа React та обмежені розшифровки

Робоча межа: увесь `#trade/reports` — обороти (4 секції), залишки на дату
(5 секцій із зарплатними правами), чинний ABC, поточні борги, повні CSV та
переходи до джерельного документа/платежу. Редактори й проведення залишаються
на чинному Django/native шляху. Сам React workspace описується після інтеграції.

## Серверні джерела показників

`report_drilldown.py` повторно читає чинного actor усередині read-only RR.
Порядок джерел, signed contributions, сторно за Києвом та існуючі округлення
`voucher_contributions` не змінені. Manager отримує дозволений агрегат зарплати
без персональних ID/дат/документів; COGS і salary aggregate лишаються частиною
чинного результату. Описи джерел не є новою обліковою формулою.

Рядки cash/stock читаються пакетами200 вузьких movement fields та voucher
headers; payload не входить до ORM rows. У period inventory differences
розгортаються SQL scalar cursor200 й підсумовуються Decimal у приватному spool.
До contribution oracle передається лише підсумок цього документа. Product у
inventory JSON не використовується для цього агрегату; вузька опція
`json_children(include_product=False)` не декодує його та не вводить нового
обмеження на раніше ігноровані дані. Default helper behavior інших звітів
незмінний. Expense scope означає network лише для exact string `network`;
довільна вкладена ознака не матеріалізується й зберігає стару семантику store.

PageRows лишає requested/last page (до60 рядків), повна сума охоплює всі джерела.
Це O(N) scan і тимчасовий диск, не cache, SLA або доказ capacity VPS. Редактор
окремого відкритого документа лишається окремою authoritative межею.

### Цільові докази першого серверного пакета

- `tests.test_report_drilldown_bounded`: 3 нові сценарії —501 JSON children і
  точна .99 сума PostgreSQL;205 cash entries/paging/clamp/anonymous salary;
  cached actor denial і фактичний readonly RR. Whole/deferred payload guard.
- `tests.test_business_audit.SourceExplanationTests`:7 пов'язаних сценаріїв
  parity/signed components/Kyiv reversal/scope/privacy/malformed/no writes та
  реальне конкурентне читання.
- Усі10 PostgreSQL PASS (3.482s), `/tmp/tsukenya-reports-backend-pg.log`.
  Власні тимчасові роль/база прибрані. Перша спроба runner мала неправильне
  ім'я модуля й не виконала бізнесові сценарії; повторено після виправлення.
- SQLite хвиля:8 PASS,1 PostgreSQL-only skip,1 precision fixture failure:
  SQLite вже при збереженні1e14 округлює копійки. Fixture переведено на звичайну
  суму лише для SQLite; affected1 PASS0.016s,
  `/tmp/tsukenya-reports-backend-sqlite-tail.log`. Великі суми підтверджені PG.
- Python syntax перевірено. Full suite/production/browser не запускалися.

## React workspace

`frontend/src/features/reports/` та `reports-entry.tsx` підключені до чинного
`#trade/reports` через `app/erp.js`. Перенесено всі4 секції оборотів, усі5 секцій
залишків із чинними зарплатними правами, прямий `ABCReport` та поточні борги на
bounded Finance API. Native лишаються розшифровка джерел і редактор вибраного
документа/платежу. Callback передає explicit opener і чинну route/generation
межу; читання, paging, CSV та retry не проводять і не зберігають документи.

OpenAPI `trading-reports.openapi.json` генерує `reports.generated.ts`.
Runtime decoder перевіряє exact context, усі рядкові поля, money decimal strings,
ліміти, count/page, зарплатну політику та source envelope. Суми відображаються
рядковим `moneyText`, без `Number`. Показники, підсумки та CSV обчислює сервер.
Summary/rows мають один поточний snapshot у відповіді rows; окреме повторне
сканування summary на кожне читання більше не потрібне. Full CSV включає всі
рядки застосованої секції/залишків; незастосовані поля не змінюють paging/CSV.

Поточні борги мають власні фільтри й явні дії; дати періоду їх не обмежують.
503 може лишити явно позначені попередні підсумки того самого scope, але CSV та
джерела вимкнено. Malformed200 очищає дані; current401/403 очищає приватні блоки;
скасована/застаріла відповідь не змінює інший маршрут або сеанс. Новий host
починає з актуального store навіть для того самого actor. Native write refresh
перечитує борги та зберігає застосований report query.

Старі `app/erp-reports.js`, окремий `abc-entry.tsx` та їх bootstrap/static hooks
прибрані після перенесення actual consumer. Вісім старих груп metadata/rows
invariants перенесено з retired VM harness у React API unit; historical/native
UI harnesses адаптуються окремим test-only пакетом без втрати бізнес-перевірок.

### Докази frontend candidate

- Build PASS; scoped ESLint PASS;9 API/state unit PASS
  (`/tmp/tsukenya-reports-unit.log`, `/tmp/tsukenya-reports-build.log`).
- Stories: Empty/Retry Focus PASS у першому actual run; Whole Screen/Manager
  виявили stale panel id після зміни вкладки. Додано keyed TabPanel; affected2
  PASS (`/tmp/tsukenya-reports-stories-tabs.log`). Перші setup спроби до collection
  були зірвані symlink dependencies; локальна копія виправила resolution.
- Source envelope test PostgreSQL1 PASS0.129s:
  foreign requested store не підміняє scoped policy, empty intersection, exact
  contract/limit та fresh role; `/tmp/tsukenya-reports-source-context-pg.log`.
- Native whole-screen/геометрія перевіряються наступним власним пакетом;
  цей candidate не засвідчує їх, розгортання або завершення всієї міграції.

### Privacy follow-up candidate

Власний перегляд знайшов два callback gaps: current403 під час відкриття
джерельного документа тепер повертається в Reports deny, включно з явним retry;
ABC reader повторно перевіряє actor та має mode/abort fence до і після запиту.
Current403 прибирає весь workspace із приватними назвами фільтрів. Окремий
unit покриває current403 й ignored-abort late401; разом10 unit PASS.

Compatibility harness виявив, що React reset сам по собі не гарантує DOM clear
до `location.assign`. Reports session listener тепер синхронно unmount-ить root,
скидає root/element після чинного session-invalidated event. Це не змінює
скасування застарілих відповідей. Affected actual expiry proof виконує окремий
compatibility пакет; результати буде додано до остаточної передачі.

## Остаточні цільові докази

- `tests/react-reports-ui.cjs`: реальний portal/React bundle та synthetic65
  товарів/магазинів/проведень; read-only UI (лише login/details POST).
  Initialpage30/escapedname, усі9секцій,30+30+5, повний65CSV із formula guard,
  повний balancesCSV та прямий ABC пройдені в першому запуску
  `/tmp/tsukenya-react-reports-ui.log` до неточного test-only очікування категорії
  у native view. Виправлено assertion на фактичні номер/магазин/суму; повторний
  callback запуск пройшов source30/195.00 → документ та Escape opener до
  неточного accessible label кнопки закриття платежу. Source результат reused.
- Payment tail PASS (`/tmp/tsukenya-react-reports-payment.log`): actual130боргів
  → чинна форма платежу, Закрити вікно, повернення фокуса після native close
  event, жодного businessPOST. Report/artifacts:
  `/var/folders/9_/xkms65w90g57nhx8n9bhp6300000gn/T/tsukenya-react-reports-TbMXNo`.
  Один проміжний startup перетнувся з build dist; не був callback доказом.
- Remaining tail PASS (`/tmp/tsukenya-react-reports-tail.log`):1440/320 bounds
  actual таблиць, деталей, кнопок оплати/джерел; current native document403 після
  зміни ролі на сервері, currentABC403, malformed200 → disable/exportclear,
  exactpage GET retry, currentReports403 → усі приватні блоки відсутні.
  Report і переглянуті PNG:
  `/var/folders/9_/xkms65w90g57nhx8n9bhp6300000gn/T/tsukenya-react-reports-we7PWn`.
  Source/read unit10 PASS, build/scoped lint PASS. Після PNG виправлено лише
  успадкований синій колір/підкреслення CSV links, без зміни геометрії.
- Незалежний test-only compatibility пакет: source callbacks/B17 дати/CSV/
  settled layout PASS; ignored-abort cancelled401 PASS. Після синхронного
  unmount лише affected expiry-final повторено — actual beforeunload має
  summary/debts порожні, sources/exports0, після чого login:
  `/tmp/tsukenya-reports-compat-expiry-final.log`.
- Full runner зареєстрував actual harness і scrub QA_REACT_REPORTS_STAGE/PORT;
  повний режим не запускався. GitHub CI/реліз/VPS/фізичний друк не перевірялися
  й не оголошуються виконаними цим пакетом.

### Залишені межі

Reports лишаються поточними read-only snapshot на кожен запит. O(N) backend
scan та приватний disk spool не усувають потребу окремо виміряти навантаження
або проєктувати cached/background reports. Snapshot не переноситься між
сторінками; користувач бачить відповідне повідомлення. Це не SLA/capacity proof.
Native вибраний voucher/editor та його legacy money presentation не перенесені
цією міграцією; нові report/source суми точні. Облікові формули, права POST,
проведення, зарплатні нарахування та фактичні платежі лишаються серверними.

### Єдиний заголовок сторінки

Після незалежного перегляду прибрано повторний React header/intro «Звіти» та
його невикористаний CSS. Основний заголовок і вступ належать чинному shell;
React section зберігає accessible name «Фінансові звіти».
`QA_REACT_REPORTS_STAGE=heading` перевірив рівно один видимий заголовок, назву
регіону, порядок/межі вкладок та відсутність горизонтального переповнення на
1440/320. PASS, `/tmp/tsukenya-reports-heading.log`; обидва PNG переглянуто:
`/var/folders/9_/xkms65w90g57nhx8n9bhp6300000gn/T/tsukenya-react-reports-eBYya1`.
Build/scoped ESLint/syntax PASS. Дев'ять секцій, payment, privacy та серверні
сценарії не повторювались: зміни стосуються лише заголовка й CSS.

### Повторна перевірка доступу перед native діями

Доступ до окремого документа або дозволений платіж сам по собі не підтверджує
право залишатися у відкритому Reports workspace. Reports `ActionContext`
перевіряє свіжий directory bootstrap проти початкових session/actor/role/store
і локальної generation. Для джерела перевірка відбувається до voucher GET та
після GET із hydration, безпосередньо перед native DOM. Для оплати — перед
references GET та після references/hydration/P0 ensure перед відкриттям форми.
Зміна identity прибирає приватний workspace навіть коли нативний endpoint
новій ролі відповідає 200. Після зміни режиму прострочений grant не відкриває
діалог і не залишає новий режим у стані actionBusy.

Optional native guards передаються тільки із Reports. Інші voucher/payment
callers і серверні права запису не змінювалися. Це перевірка поточного доступу
під час читання, не push-відкликання вже відкритого екрана між запитами.

- Targeted state3 PASS (`/tmp/tsukenya-reports-grant-unit.log`): cashier role,
  owner store mismatch, payment identity та cancelled late grant. Після
  додавання payment opening context повторено лише affected payment2 PASS
  (`/tmp/tsukenya-reports-payment-grant-unit.log`). Попередні10 unit reused.
- Actual `grant` PASS (`/tmp/tsukenya-reports-grant.log`): на сервері owner→
  cashier; прямий sale GET підтвердив 200 без cost, а Reports не виконав
  native GET/не відкрив діалог і очистив приватні блоки. Окремо owner→
  accountant: прямий references payment GET200 дозволений, але Reports
  відмовив до native callback. Artifacts:
  `/var/folders/9_/xkms65w90g57nhx8n9bhp6300000gn/T/tsukenya-react-reports-LQwqsi`.
- Actual `grant-late` PASS (`/tmp/tsukenya-reports-grant-late.log`): owner
  preflight пройшов, voucher GET затримано; після owner→cashier повернуто
  справжню redacted sale200 відповідь. Повторна перевірка перед DOM очистила
  Reports, діалог не з'явився. Artifacts:
  `/var/folders/9_/xkms65w90g57nhx8n9bhp6300000gn/T/tsukenya-react-reports-QRqlJo`.
- Actual `payment-late` PASS (`/tmp/tsukenya-reports-payment-late-allowed.log`):
  owner preflight пройшов, references GET затримано; owner→accountant, справжній
  references GET200 містить запитаний документ. Після відповіді/ensure grant
  прибрав приватні блоки, форма не відкрилася, business writes відсутні.
  Artifacts:
  `/var/folders/9_/xkms65w90g57nhx8n9bhp6300000gn/T/tsukenya-react-reports-QQtd2O`.
  Попередній запуск не дійшов до браузера: sandbox заборонив bind локального
  сервера (`Errno1`, terminal exit1). Збережено startup failure
  `/tmp/tsukenya-reports-payment-late.log`, artifact `tsukenya-react-reports-62SgZX`;
  повторено тільки цей scope з дозволом на локальний сервер.
- Matching build/scoped ESLint/native syntax PASS. Нові stages входять у
  default actual harness; існуючий full-runner scrub stage/port збережено.
  Дев'ять секцій, геометрію, PG oracle та повний набір повторно не запускали.
