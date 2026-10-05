# B25 · Запуск звірки за розкладом

## Реалізація

`deploy/reconcile_scheduler.py` викликає лише `web` Compose-проєкту `tsukenya` з
`manage.py reconcile --record --source scheduler --run-id UUID --receipt-json`.
Команда читає регістри в наявному READ ONLY REPEATABLE READ; після знімка пише лише
технічний журнал. Грошові/складські рухи, зарплата, ролі й бізнес-аудит не змінюються.
Новий прапорець виводить тільки ID, джерело, статус, версію перевірок і кількість
зауважень; повний звіт і приватні помилки не потрапляють у systemd journal.

Перед запуском ID записується на диск через fsync/atomic rename. `flock` не дозволяє
другий одночасний host invocation. При втраті відповіді, timeout або неможливості
записати локальне підтвердження наступний запуск повторює той самий ID. Наявний
серверний receipt повертається без нового сканування. Пошкоджений локальний стан
блокує запуск, замість створення іншого ID.

Підтверджений `failed` блокує нові сканування. Після перегляду журналу оператор
може явно дозволити нову спробу:

```sh
python3 /opt/tsukenya/deploy/reconcile_scheduler.py --resume-failed UUID
```

UUID має точно збігатися з `pending.json` зі статусом `failed`. `clean` та
`discrepancies` завершують попередній intent; наступний розклад створює новий ID.
При розбіжностях runner повертає 1 і залишає результат у журналі застосунку.
`last.json` є компактним локальним підтвердженням, не заміною серверного журналу.
Локальні файли — приватні; команда не перезапускає контейнери й не змінює gateway.

## Розклад та активація

Підготовлені `deploy/tsukenya-reconcile.service` і `.timer`: щодня о 03:30 за Києвом,
до 10 хвилин випадкової затримки, один запуск після пропущеного розкладу. Це
технічний початковий розклад, який можна змінити systemd override.

Після прийняття та розгортання коду: перевірити units через `systemd-analyze verify`,
встановити лише ці два units і активувати `tsukenya-reconcile.timer`. Перевірити
перший receipt, статус таймера та незмінність бізнесових таблиць. На VPS units встановлені й timer активований 05.10.2026 після
прийняття PR130 та розгортання коду; докази нижче. Застаріла інструкція «без cron» стосувалася ручної звірки до B25;
цей пакет додає окремий systemd timer, а не змінює backup cron.

Retention серверного журналу не введено: автоматичного видалення історії немає.
Рішення щодо зовнішніх бекапів і відновлення з пункту 0.1 не входять у цю роботу.

## Перевірки

- 7 host-side сценаріїв без Docker/БД: lost ACK → exact UUID, failed receipt →
  блокування та explicit resume, пошкоджений стан, live lock, збій запису last.json,
  strict compact ACK і scoped Compose command.
- 3 цільові Django-сценарії на ізольованій SQLite: compact clean receipt, replay
  без нового scan і бізнесових записів, failed receipt без приватного payload,
  відхилення несумісних flags; discrepancy receipt із nonzero без деталей звіту.
  Початкові 6+2 PASS; додані 1+1 PASS перевірені окремо без повтору незмінених.
- Наявний PostgreSQL READ ONLY/RR і immutable journal протокол не змінені;
  попередні його докази повторно не запускалися. Повної регресії не було.

### Уточнення рев’ю

Команда явно задає `-f <root>/compose.production.yaml`, тому не залежить від автоматичного пошуку Compose-файла чи `COMPOSE_FILE`. Цільова перевірка звіряє весь argv, включно з production-файлом, проєктом та сервісом. До виправлення reviewer підтвердив відсутність вибору файла; після правки affected command-сценарій пройшов.

Компактний receipt також пропускає `saved_report()` та читання всіх finding rows: exact replay підтверджується лише з технічного запису запуску. Після цієї правки три affected CLI-сценарії (clean/replay, failed, discrepancies) пройшли; replay окремо забороняє матеріалізацію повного звіту.

## Активація VPS · 05.10.2026

Реліз коду093c53b; installed units та runner byte-equal прийнятим файлам PR130.
Перед зміною обидва units мали LoadState=not-found; встановлено лише
`/etc/systemd/system/tsukenya-reconcile.service` і `.timer`, Docker вже був active.
Попередня Linux перевірка units/calendar/py_compile успішна; інших units,
Compose/env/gateway, контейнерів чи backup cron не змінювали.

Перший `systemctl start tsukenya-reconcile.service`: Result=success,
ExecMainStatus=0. Серверний та host компактний receipt збігаються:
`47cdda0d-73ce-40a1-a775-c26c2bf9d1cf`, source=scheduler, status=clean,
checksVersion=1, issues=0. Pending state відсутній. Звірка всіх58 ERP/user моделей
(крім ReconciliationRun/Finding і heartbeat) до/після: кількості й хеші незмінні;
створений лише один ReconciliationRun, finding rows0. Це підтвердження операційного
запуску, не production mutation test або новий повний прогін.

`systemctl enable --now tsukenya-reconcile.timer`: loaded/active/enabled;
наступний запуск06.10.2026 о03:37:49 за Києвом (00:37:49UTC), у погодженому
вікні03:30–03:40. Фактичний майбутній автоматичний запуск ще не спостерігався.
Стан/receipt лежать поза release.CODE у `/opt/tsukenya/ops/reconcile`, отже
звичайна заміна коду їх не видаляє.

Операційне вимкнення розкладу: `systemctl disable --now tsukenya-reconcile.timer`.
Не видаляти pending/last, не змінювати UUID після unknown результату. Перший clean
receipt не змінює правила resume-failed чи вже перевірений exact replay.
Retention без автоматичного видалення;0.1 та зовнішні backup/recovery рішення
залишаються поза цією активацією.
