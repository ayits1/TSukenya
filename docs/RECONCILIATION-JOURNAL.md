# B25 · Журнал звірки та відомі закриті періоди

## Реалізована межа

Команда `manage.py reconcile` зберігає чинні перевірки складських залишків, документів, коштів, зарплати, сторно й розподілів платежів. Новий check `closed_period` доповнює їх відомою хронологією. Звірка нічого не виправляє; не змінює ролі, проведення, зарплатний знімок чи строки закриття.

Це технічні правила реалізації, не нові рішення власника бізнесу. Немає автоматичних знімків під час закриття чи вимоги погоджувати результати. Змінені історичні назви товарів, магазинів і контрагентів не прирівнюються до облікового пошкодження.

## Докази та прогалини вихідного коду

- `services.py:save_voucher/post_voucher/reverse_voucher`, `views.py:work_shift_save`, `post_cash_difference` перевіряють `LedgerLock.closed_through` під спільним блокуванням. `/api/erp/period` дозволяє власнику лише завершену дату, вимагає причину та відхиляє закриття з чернетками до цієї дати.
- `views.py:/api/erp/period` записує `AuditEvent(action=period_changed, subject=ledger, detail={date,reason})`. До першої відомої події немає авторитетної історії закриття. Старий event не має `before`, тому попередній стан не вгадується.
- `reconcile.py` раніше перевіряв лише поточні облікові рівності. `management/commands/reconcile.py` уже мав реальний PostgreSQL `REPEATABLE READ, READ ONLY`, включно з перевіркою вкладеного виклику.
- B15 вже додає борги/розподіли/аванси до звірки. Це не нова відсутня функція B25.

## Перевірка періодів

`reconcile_periods.py:check_periods` повертає findings і coverage:

- невідомий статус, час проведення/скасування у чернетки, час скасування у чинного проведеного документа, скасування раніше проведення;
- поточне закриття незавершеного/майбутнього дня;
- відома остання подія періоду не відповідає поточному закриттю; malformed later event або неоднозначні одночасні зміни роблять останній стан невідомим, старий валідний стан не підставляється;
- подія зміни періоду без обов’язкової причини;
- відомий `posted_at` або `reversed_at` після події закриття для `voucher.date`, що захищалась тоді. Явне повторне відкриття допускає пізніше проведення документа з минулою датою.

Відсутні timestamps, операція до першої відомої події, точна рівність timestamp операції й події та malformed interval дають `unknown_operations`, а не твердження про незаконне проведення. Старі події з невідомою версією правил не доводять повну історичну незмінність. Статус і відомі timestamps перевіряються за чинними переходами серверних services; відсутній legacy timestamp не стає помилкою лише через його відсутність.

`protected_drafts` — кількість чернеток на дату поточного закриття. Це операційне блокування та суперечність чинному close guard, **не доказ незаконного проведення**. Цей показник виводиться в coverage, без зміни статусу run на «розбіжності» сам по собі.

Coverage: `closed_through`, `protected_drafts`, `known_operations`, `unknown_operations`, `invalid_period_events`. Дати — Київ. Фінансові суми не перераховуються за сучасними назвами чи цінами каталогу.

## Технічний журнал і справжній READ ONLY

Без `--record` команда не пише нічого. PostgreSQL відхиляє випадковий write у read-only snapshot, SQLite використовується лише для ізольованих локальних сценаріїв. Вкладений PostgreSQL caller має вже забезпечити RR/SERIALIZABLE + READ ONLY.

```sh
python manage.py reconcile --json
python manage.py reconcile --record --source manual --run-id 1b90d95e-8b54-4b3a-b922-4c829fe4307e --json
```

`--record` дозволений лише поза чужою транзакцією. Спочатку весь облік читається в **одному** RR/READ ONLY snapshot; після його завершення окрема транзакція записує лише `ReconciliationRun` і `ReconciliationFinding`. `LedgerLock` не береться, рухи/аудит бізнесу не створюються. Журнал не може змінити token касира через приватну фінансову подію.

UUID — immutable technical receipt. Intent fingerprint містить `source` та `checks_version`. Повтор UUID з тим самим intent повертає збережений результат **без нового scan**; інший source/version відхиляється. При одночасному однаковому UUID перший збережений результат стає авторитетним, інші отримують його. Це не обіцянка, що різні конкурентні читачі бачили одну й ту саму версію БД.

Джерела: `manual`, `scheduler`. Стани: `clean`, `discrepancies`, `failed`. Перерваний scan може записати лише generic `snapshot_failed`, без traceback чи приватного payload. Failed receipt не перезапускається автоматично: новий запуск потребує нового UUID. При втраті ACK повторюється попередній UUID. UUID без `--record` відхиляється. Без UUID команда створює його й друкує ID журналу в stderr.

Код завершення — 0 лише для успішної звірки без розбіжностей, nonzero для findings чи незавершеного запуску. Збереження технічного запису не приховує невдалий результат.

Міграція `0018_reconciliation_runs` залежить від прийнятої `0017_catalog_import_jobs`. Run містить hash звіту, версію перевірок, час початку/завершення/запису, summary/counts/coverage/error; findings зберігаються окремо з порядковим номером, expected/actual як рядками. Hash — відбиток receipt, а не криптографічний захист від адміністратора БД. Новий GET не пише дані.

## Read-only API й інтерфейс

Доступ лише network owner: `role=owner`, `profile.store_id=null`. У звірці є глобальні кошти, собівартість і зарплата; власник магазину, керівник, бухгалтер, касир та склад отримують 403. Чинні права на інші облікові екрани не змінюються.

- `GET /api/erp/reconciliation-runs?page=&status=&source=&from=&to=`: `{items,total,page,pages}`, 30 запусків/сторінку. Дати — дата запису журналу за Києвом. `status/source` мають перевірені enum, сторінка strict positive ASCII integer, завелика сторінка clamp.
- `GET /api/erp/reconciliation-runs/:uuid`: run DTO.
- `GET /api/erp/reconciliation-runs/:uuid/issues?page=&check=`: `{items,total,page,pages}`, 100 findings/сторінку. Ключ check перевіряється за summary run.
- Жодного HTTP POST запуску, edit/delete/repair endpoint немає. Читання count/page виконується в RR READ ONLY, щоб паралельне додавання run не дало суперечливу сторінку.

Run DTO: `id,source,status,checksVersion,startedAt,finishedAt,recordedAt,issues,reportHash,summary,errorCode`. `summary.checks` містить `title,issues_count`, без масиву findings. Finding: `ordinal,check,subject,message,expected,actual`; expected/actual nullable strings.

У «Налаштуваннях обліку → Контроль обліку» кнопка «Звірка регістрів» відкриває компактний журнал. Є календарні фільтри, результат, paging, подробиці з native `<details>` для підсумку перевірок. Невідоме покриття відображається явно. Failed run не називається чистим. Runtime decoder відхиляє неповні DTO, суперечливі counts/pages/status; помилка GET прибирає stale результати й дає повторне читання. Escape повертає фокус до кнопки без dirty-confirmation. Shared controls не замінені новими custom selectors.

## Плановий запуск

Для зовнішнього supervisor/scheduler підготовлено той самий entrypoint:

```sh
python manage.py reconcile --record --source scheduler --run-id 5e7f385a-b622-4740-ae7e-99e2c4c52c56 --json
```

Планувальник має видати новий UUID для нового запуску, зберігати його до ACK і повторити той самий UUID після невідомого результату. Частота та активація — окрема операційна конфігурація. Тут не налаштовано VPS scheduler, retention/delete політику журналу, зовнішній backup/restore або deployment. Рішення 0.1 лишається поза цим пакетом.

## Перевірки

- `tests/test_reconcile_journal.py`: доведене закрите проведення/сторно, явне reopen, unknown timestamps/events, audit/ledger mismatch і причина, назви без false corruption, SELECT-only default, immutable receipt, failed generic journal, pages 31/205, roles/invalid filters, PG concurrent UUID, real RR snapshot і separate technical write.
- PostgreSQL18: нові 8 + чинні clean-ledger/real-readonly/parallel-snapshot 3 — **11 PASS**, 4.335 s. Після вузького виправлення «локальний failed snapshot, але конкурентний clean receipt уже збережено» лише 2 зачеплені тести — **PASS** на ізольованій SQLite. Додані HTTP GET/POST/PUT/DELETE рольові перевірки перевірено 2 цільовими тестами; окремий CLI text coverage сценарій — 1 PASS. Усі перевірки на синтетичних даних.
- `node tests/reconciliation-contract.cjs`: strict DTO, failed result, malformed/stale pages — PASS.
- `tests/reconciliation-ui.cjs`: один native Chrome шлях 31 run/205 findings, keyboard paging, failed GET→retry GET, focus/Escape, 320/1440, незмінні Voucher/StockEntry/CashEntry/AuditEvent counts, лише GET журналу — PASS. Після згортання довгого mobile summary повторено лише цей змінений сценарій.
- `makemigrations --check --dry-run`, diff/syntax — перевірені перед delivery. Повної регресії, production capacity, VPS та recovery/offsite test не було.

Нова звірка виявляє доведені суперечності доступних регістрів/хронології. Вона не доводить незмінність усіх історичних фінансових полів, якщо незалежного минулого snapshot немає, і не замінює відновлення резервної копії.
