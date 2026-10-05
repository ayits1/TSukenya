# Контактні операційні задачі · B26

Інтегровано на main093c53b для PR/CI після незалежного review; merge/deploy
цього пакета та завершення всієї B26 ще не оголошені.
Залежність — прийнятий Customers/Reports freshness і `0029_customer_report_versions`;
власна міграція `0030_contact_tasks`. Фінансових проводок, loyalty/provider правил
та воронки продажів цей пакет не створює.

## Фактичний маршрут і права

`#trade/customers`: задачі в картці контакту та окрема «Контактні задачі» черга.
Обидва читачі мають сторінки30, повні підсумки поточного фільтра, пошук,
стан/архів/виконавця/строки/прострочені та журнал сторінками30.
Прострочення — `due_on < Kyiv today` лише для `todo/doing`.
Магазин обов'язковий для створення; мережевий читач може переглядати всі дозволені
магазини, scoped читач — лише свій. Пошуковий текст виконавця/клієнта не є ID.

READ/WRITE: owner, manager, accountant у чинному store scope. Cashier/warehouse:
403 без notes/counts/task token; чинне читання контактів/покупок не розширено.
Нова задача потребує `Counterparty.kind=customer`; неактивність сама не видаляє
історію. Існуючі задачі, їх history/current та creator replay зберігаються після
перекласифікації контакту в supplier. Новий unsent контекст для supplier відхиляється.
ID/contact/store/creator immutable в API; тільки title/note/due_on/assignee/status/
archived редаговані. Архів не видаляє історію. Стани: todo, doing, done, cancelled;
це операційний стан задачі, не етап продажу. Виконавець — активний owner/manager/
accountant свого або мережевого scope; незмінений уже неактивний виконавець лишається
в історичному записі, з явним caption.

## Авторитетний контракт

`server/erp/contact_tasks.py`: кожен write під LedgerLock перечитує current actor;
після fresh actor/scope перевіряє immutable creator-bound receipt **до** поточної
ревізії/змінних правил. CREATE ID і request_key UUID; PATCH має власний request_key
та observed revision. Успіх атомарно зберігає task, ContactTaskOperation original,
ревізію і нормалізований audit before/after. Колізія UUID/чужий creator — conflict;
немає admin bypass автора receipt. Hard DELETE не передбачений; архів — звичайний
ревізійний UPDATE. completed_at належить серверному переходу done.

OpenAPI `contracts/contact-tasks.openapi.json`; runtime decoder і generated types
окремі від фінансового CRM DTO. Шляхи:

- GET/POST `/api/v1/crm/contact-tasks` — сторінка/створення.
- GET/PATCH `/api/v1/crm/contact-tasks/{UUID}` — current/зміна.
- POST `/api/v1/crm/contact-tasks/identity` — exact frozen request identity.
- GET `/api/v1/crm/contact-tasks/{UUID}/history` — журнал.
- GET `/api/v1/crm/contact-task-context` — scalar ресурсна авторизація.
- GET `/api/v1/crm/contact-task-assignees` — scoped page30/selected ID.

GET та identity працюють у fresh-actor READ ONLY RR, нічого не пишуть.
Context `exists` лише підтверджує доступний immutable контекст UUID; не доводить
авторство CREATE, не підтверджує first intent і не встановлює revision baseline.
Positive identity містить exact creator original; `confirmed:false` не є доказом
відсутності запису. History/read captions проектуються вибраними полями; повні
User/contact приватні payload не використовуються як read context.

## Raw recovery і окремі дії

`features/customers/tasks/api.ts/machine.ts/TaskEditor.tsx` підключені до прийнятої
P0 foundation. Same-tab/same-session явний Restore з будь-якого маршруту;
raw invalid date/assignee/порожня новіша назва зберігаються окремо від Save-validator.
Scope UUID/contact/store, baseline, raw та frozen first method/path/key/body —
whitelist codec v1. Немає credentials, CSRF, facts або дозволів у storage.

Синхронне on-input capture; frozen intent durable **перед fetch**, quota failclosed.
Після останнього awaited session перевіряються signal/generation/route/visibility.
Unknown CREATE/UPDATE зберігає той самий intent після reload і later4xx;
exact Retry typebutton доступний попри новіші invalid поля. Лише bound rollback400 першої live CREATE/PATCH або revision_conflict409 першої
live PATCH може звільнити matching rejected intent. Proof зв’язує task UUID,
request_key, action і code; collision/permission та post-commit response failures
його не мають. Після definite PATCH rejection current/read/Apply є явним бар’єром
перед новим UUID/окремим Save. Будь-який lifetime suspend назавжди скасовує цю локальну first-live authority для вже виданого intent; наступна400 не звільняє його. Catch охоплює atomic save;
Outer transaction тримає commit/on_commit поза catch внутрішнього savepoint; post-commit callback або serializer failure такого proof не отримує. Це rollback proof конкретної першої спроби, не доведення загальної відсутності UUID
і не автоматичний retry.

ACK/positive identity strict-bound до key/context/normalized terms і durable **до**
незалежного current GET. Current503 не відновлює CREATE і не приймає ACK revision як
baseline. Current → comparison → explicit Apply змінює тільки local baseline/raw;
Save — наступна окрема дія. Стан+архів+виконавець+строк порівнюються atomic unit,
примітка незалежна. Explicit Close cancels late requests; Restore dismissal не
стирає вже дозволену форму. Сеанс/role/store lifetime hide та resource denial йдуть
через P0; obsolete issued401 відсікається до global invalidation. Поточний401
синхронно приховує private DOM/storage перед login redirect. Discard removal error
видима, private form лишається прихованою, prior record збережений.

## Scoped freshness

`customers_tasks` окремий ресурс лише3 task roles; frozen0024/0029 unchanged.
0030 frozen triggers охоплюють direct/bulk task/operation writes, OLD/NEW store,
contact/store captions, assignee role/store/name/activity та історичне actor name
через reverse task/operation stores. Counters rollback разом із джерелом;
чужий store не змінює scoped token. Financial/payroll events не є task dependencies.

Actual Customers registration включає active child reader; task queue просить лише
customers_tasks. Scoped null filter проєктується в bootstrap.storeId. Оновлюється
committed page/filter; raw search, активний control або native editor/unknown intent
відкладає GET з notice. Quiet304 не перечитує task payload. Не force remount.

## Інкрементальні докази

Без full/production/Sheet/VPS. PostgreSQL disposable DB `tsukenya_contact_tasks`;
`/tmp/tsukenya-review-venv/bin/python manage.py test tests.test_contact_tasks... --noinput`.
Дванадцять distinct targeted methods пройшли інкрементально: receipts/revisions/audit,
role/store/read-only/cashier, paging65/query errors, direct/bulk/rollback/privacy,
parallel revision winner, stale/deactivated actor before private read, caption+
migration reverse/reinstall, actual LedgerLock role-revocation wait, reclassified
contact history/replay/new-create refusal та відмову іншому allowed owner в creator receipt replay. Migration reverse/reinstall також SQLite.
Це не твердження, що повний server набір повторено.

Unit adapter12 і machine16 пройшли цільовими групами; strict raw/ACK/identity/summary/
context/quota/late callback/removal. Shared comparison Story2: keyboard Apply та
Cancel. Тимчасовий symlink QA Story config з fs.allow лише для installed dependencies
не входить у source delivery. Types, changed lint, production build/schema — цільові.

Actual `tests/contact-tasks-ui.cjs`: isolated SQLite18291, bundled headless Chromium.
Повний primary не повторено: `primary-partial.json` підтверджує cold invalid Restore;
`remaining-partial.json` — quota, last-await Close, card/queue65 і geometry.
Термінальні stages `create`, `unknown`, `workflow`, `policy`, `freshness`, `review` зберігають
власні JSON reports, не називаються broad/full PASS.

```sh
env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  QA_CONTACT_TASK_FROM=freshness PYTHON_BIN=/tmp/tsukenya-review-venv/bin/python \
  /Users/pavlogrecka/.nvm/versions/node/v24.18.0/bin/node tests/contact-tasks-ui.cjs
```

Локальні синтетичні артефакти: `/tmp/tsukenya-contact-tasks-proof/`:
create-report/unknown-report/workflow-report/policy-report/freshness-report/review-report.json;
contact-queue-current-1440.png і contact-queue-current-320.png. Partial JSON лишено
для чесного reuse prefix; failure artifacts не є успішним proof.

## Закриті findings незалежного review

- Unresolved CREATE/PATCH не можна стерти через current/Compare/Apply або complete:
  UI/model/codec guards; only positive creator ACK/identity чи допустимий first-live
  rollback proof звільняють intent. Unknown after reload/lifetime/later400409 збережено.
- Apply має **один** atomic storage write baseline+merged raw; quota не змінює ні
  durable baseline/raw, ні in-memory payload. Title/note незалежні, workflow
  status+archive+assignee+due_on — одна atomic unit.
- Request status401403 опрацьовується перед JSON decode. Canceled response перевіряє
  AbortSignal перед авторизаційним side effect; Save final-session errors також
  проходять P0 denial. Identity перевіряє decodeDraftSession/sameSession проти
  authoritative P0 callback actor до identity POST; mismatch приховує форму і
  перечитує session, без baseline adoption.
- Ordinary open того самого UUID після fresh session не перезаписує plain raw,
  frozen intent або unreadable record. Generic public Restore/Discard gate; input і
  Save заблоковані до явного вибору. Close до initial await не записує opening payload.
- Enum decoder не перетворює масиви на дозволені рядки; assignee page SELECT містить тільки id/
  username (окремий fresh actor auth lookup зберігається).

Цільовий `review` native stage (один isolated сценарій) підтвердив invalid plain raw
reopen/Restore0writes, first PATCH409→current→keyboard comparison→Apply0writes→new
UUID Save, unknownPATCH/later409/noApply до positiveidentity, nonJSONcurrent403 і
nonJSONfinalsession401 з beforeunload private-clear. Додатковий PG method перевірив
rollback/no receipt, collision/no proof, scalar assignee projection та serializer
failure **після committed write** без rollback signal. Окремий callback target довів: on_commit BusinessError не повертає rollback proof, receipt збережено, exact retry повертає первинний ACK без другого task/audit/receipt. Змінена workflow Story Atomic
перевірена окремо; unchanged Cancel Story повторно не запускалась.

## Відкриті межі

Count/search лишаються серверними SQL scans за відповідним індексом/фільтром;
100k capacity, cursor, tombstone/receipt retention/SLA не доведено. Немає notification,
автоматичної зміни task стану, продажної воронки, loyalty/provider або Google writes.
Реальний телефон/скринрідер не перевірені; загальний B06/B24/план і0.1 не закриті.

### Реєстрація повної перевірки

Явний `npm run test:full` містить primary сценарій і окремі unknown/workflow/
freshness/review tails. Успадкований QA_CONTACT_TASK_FROM очищується, щоб зовнішня
змінна не звузила full. У цій доставці перевірено тільки синтаксис і `--plan`;
повний прогін не запускався. При інтеграції збережено обидва catalog/task enrollment
та обидва генератори контрактів; власні runtime-файли byte-equal frozen proof.
