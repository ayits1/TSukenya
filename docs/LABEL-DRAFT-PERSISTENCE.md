# B06: відновлення макета Label Studio

## Межа

Реальний `#operations/tags`: макет і реквізити, включно з незавершеним текстом
розміру шрифту. Авторитетні розміри мм/pt, версія оформлення, ціни, PDF і бізнесові
формули збережені. Цей пакет не закриває інші B06 сім’ї.

`persistence.ts` визначає whitelist; `recoveryApi.ts` — строгий transport;
`recovery.ts` підключає P0 same-tab store/controller; `Studio.tsx` і `labels-entry.tsx`
є реальними споживачами. ProductDTO, PDF, csrf, permissions і поточний context не
потрапляють у payload. P0 зберігає лише свій чинний session binding.

## Серверний протокол

- `GET /api/v1/labels/recovery-context`: fresh actor у READ ONLY REPEATABLE READ;
  owner-only context із `resource:settings/main`, role/storeId/networkOwner/canWrite.
- `POST /api/v1/labels/workspace/identity` з `{request:{key,revision,config,settings}}`:
  readonly RR, immutable creator+UUID+fingerprint receipt; `confirmed:false` не
  доводить відсутності запису. Позитивний результат містить лише appliedRevision.
- `POST /api/v1/labels/workspace/execute`: exact request; LedgerLock → fresh owner →
  creator/key/fingerprint receipt **до** mutable revision/validation. Existing apply
  validation, budget freeze, settings write та audit виконуються атомарно з receipt
  `Document(label_layout_runs/<uuid>)`. Prefix недоступний generic CRUD.
  Exact повтор повертає scalar ACK; інший body/creator — 409.
- Legacy PATCH використовує той самий apply helper й fresh owner. Workspace GET
  перевіряє fresh actor у RR; ролі друку збережені. Міграцій немає.
- Перший live 400 або revision_conflict409 має bound write_rejected proof після
  rollback. Після unknown наступні 4xx не змінюють первісний frozen intent.

OpenAPI: `contracts/catalog.openapi.json`, generated types — `shared/api/generated.ts`.

## Чернетка та взаємодія

- Raw зберігається синхронно до await/нормалізації. Неповний розмір шрифту, пробіли
  у реквізитах і нові правки можуть існувати поруч із frozen першою спробою.
- Перед відправленням UUID/body/revision записуються durable. Decoder звіряє body
  з frozenRaw; retry не збирається з нового введення.
- Cold reload пропонує **Відновити** або **Відкинути**. Codec зареєстрований і на
  інших маршрутах: загальна панель відкриває реальну студію після fresh перевірки.
- ACK або positive identity спочатку записують scalar confirmation у P0; лише
  потім виконується незалежний current GET. Після його помилки reload не дозволяє
  повторний business POST. Якщо новіший raw існує — він лишається для порівняння.
- Порівняння не приймає серверну версію автоматично. **Застосувати** змінює лише
  локальну чернетку та baseline; **Зберегти** — окрема дія з новим UUID.
  `storeNames + storeIdx` — одна merge unit; raw fontsize і typed style.size також.
- Скасування/route leave/current 401/403 і зміна binding приховують приватний
  редактор. Ігнорований Abort або запізнілий JSON/401 не підтверджують старий запит.
- Quota до send блокує запит, зберігаючи видиме введення й останній durable стан.
  Quota при ACK лишає unknown intent для identity recovery. Якщо sessionStorage
  недоступний повністю, немає fallback layout PATCH: доступні перегляд/друк,
  редагування заблоковане. Читання ролей, яким редагування не дозволене, не залежить
  від доступності P0.
- Normal Save зберігає вибраний елемент. На 320 px статус і Save мають власний рядок;
  desktop лишається в один рядок. Compact promotion rendering не змінений.

## Цільові докази

Власна реалізація почалася з fixed126 runtime46e5976; фінальна база — accepted126.
Усі mutation fixtures — одноразові локальні БД, браузер — bundled headless Chromium.

### Сервер і unit

- SQLite: `/tmp/tsukenya-label-recovery-sqlite.log` — 16 PASS, 1 PG-only skip;
  початковий loader також підхопив legacy LabelTests. Після виправлення імпорту
  незмінені legacy 11 повторно не запускалися.
- PostgreSQL: `/tmp/tsukenya-label-recovery-pg.log` — 6 PASS, 0.970 s: own4,
  scoped owner legacy save, existing parallel legacy saves. Own same-key race,
  immutable replay після новішої правки, creator/privacy, captured readonly SQL,
  fresh RR та rollback/audit також перевірені. Унікальні QA DB/role видалені;
  існуючий локальний container127.0.0.1:61144 не змінено.
- 8 унікальних unit cases PASS: початкові6 у `label-recovery-unit.log`, виправлений
  тестовий import одного merge helper — `unit-merge.log`; privacy/current JSON
  tail2 — `unit-privacy.log`; після extraction нормалізації strict frozen-body
  case — `unit-final-codec.log`. Усі файли мають префікс `/tmp/tsukenya-label-recovery-`.
- Matching build, types, scoped eslint, syntax та diff whitespace PASS.
- Storybook: `label-recovery-stories-final.log` — 2 PASS: UnfinishedFontSize і
  existing IndependentMergeAndExplicitKeyboardChoice. Перший запуск не почав
  тести через cross-clone symlink setup import; незмінні залежності скопійовано
  локально через APFS clone, без зміни lockfile. Шість інших stories не запускалися.
- Погоджені користувачем LabelPromotion stories/docs — окремий commit; їхні
  попередні 5 успішних перевірок повторно не запускалися.

### Реальна студія

`tests/label-draft-reload-ui.cjs`, selector `QA_LABEL_DRAFT_FROM`:

| Scope | Перевірено |
| --- | --- |
| raw | Empty font і реквізити → cold reload → explicit Restore → local Apply → окремий Save; один receipt |
| unknown | Втрата ACK, exact frozen body + newer invalid raw; identity підтверджено до current503; reload GET-only |
| retry | Unknown транспортна помилка → новіший empty raw → reload → keyboard exact Retry первісного body/UUID; один receipt |
| ack | Live ACK до current503, cold Restore без другого POST |
| rejected | Інший writer між current200 та execute → перший409; review/Apply без POST, новий UUID Save |
| privacy | Owner→cashier, current resource403, binding/raw erased; повернення owner не розкриває старий raw |
| guards | Route leave і public Cancel під ignored-Abort late401, 0POST, без повторного відкриття/скидання сеансу |
| quota | Storage failure до send і при ACK, exact recovery без дублювання |
| global | Cold codec на іншому маршруті, загальна панель Restore, explicit Discard; 0POST |
| session | Current non-JSON401 ховає редактор і очищає чернетку; 0POST |
| layout | Actual preview/inspector1440/320, readable status/Save, input focus, без overflow |
| storage | Недоступний sessionStorage: layout writes заблоковані, чинна підготовка друку збережена |

Артефакти: `/tmp/tsukenya-label-draft-proof/{raw-final,unknown,retry,ack,rejected,privacy,guards-final,quota,global,session,layout-final,storage-final}`.
Фінальні PNG1440/320 і окремий inspector320 переглянуті. Початковий wrapper-height
і стиснутий mobile Save були виправлені до фінального layout tail; failure PNG/log
збережені. Перший guards fixture перехопив fetch після створення API й не перевірив
очікувану гонку; final fixture встановлює перехоплення перед запуском модулів.

`tests/labels-ui.cjs` retargeted на actual execute та explicit read після409;
усі старі assertions залишені. Representative `QA_LABEL_COMPAT_FROM=save` PASS:
preview keyboard, незалежні style terms, save/reload, dirty route cancel,
конкурентне редагування й явне відкидання. Незмінний PDF/multi-page/printing tail
не повторювали. Readonly identity POST виключено з лічильника business writes у
price-context fixture. Full runner реєструє всі нові scopes та scrub selectors;
повний набір не запускався.

## Межі

Fault injection `storage` також відтворює наявні повідомлення інших native codecs
«Модуль локальних чернеток/відновлення ще не готовий» при відсутності P0. Їхні точні
тексти збережено й явно перевірено окремо; інші runtime errors заборонені. Цей пакет
не переписує чужі enrollment adapters. В усіх звичайних scopes — zero page errors.

Немає production mutation/deploy, full regression, фізичного принтера, screen-reader
або нової cross-engine матриці. Ціни, PDF та compact promotion фізичний renderer
не змінено. Інші B06 сім’ї та B24/SLA не оголошуються завершеними.
