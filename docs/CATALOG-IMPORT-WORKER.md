# B21: керований worker великих імпортів

## Що реалізовано

`python manage.py process_catalog_imports --continuous` обробляє всю збережену чергу до SIGTERM/SIGINT. Після кожного обмеженого кроку — interruptible pause 2s; `--poll-seconds` дозволяє 0.5–60s. Пауза також діє для порожньої черги та тимчасової помилки її читання. Supervisor перезапускає процес після аварійного виходу. Додаткової мережі, брокера чи Redis/Celery немає.

Чинні `--once`, `--run UUID`, `--max-steps N` залишаються bounded CLI і не реєструють supervised liveness. `--continuous` не поєднується з `--once`, `--max-steps` >1 або `--run`: targeted runner не повинен оголошувати всю чергу доступною іншим авторам.

Runner використовує чинні `claim/process_one/step`, per-run UUID lease/token, owner-role validation, LedgerLock, нормалізацію/planRevision й транзакції. Результат кожного committed chunk зберігається окремо. Він не схвалює `ready` план автоматично: Apply залишається явним рішенням автора. Cancel/revoked access/row conflicts зберігають чинні правила. Малий atomic імпорт до1000 не залежить від worker.

## Зупинка та відновлення

SIGTERM/SIGINT лише встановлює stop flag. Поточна claim/step операція завершується; після неї новий claim не береться. Heartbeat thread припиняється, instance позначається stopped. Пізня heartbeat-відповідь не може відновити stopped instance; інший живий instance лишається available.

Compose `stop_grace_period:150s` — **технічний бюджет**, не гарантований верхній час транзакції. Lease120s перевіряється на вході, а 5s adaptive budget — лише між рядками; один SQL/рядок і очікування LedgerLock можуть тривати довше. LedgerLock/timeouts accounting цим пакетом не змінено. Якщо supervisor після150s застосує SIGKILL, PostgreSQL відкотить незавершену транзакцію. Уже committed chunks залишаються. Running claim, який був окремо збережений перед step, відновлюється новим runner після чинного lease expiry; новий token не повторно записує committed рядки. При рестарті до expiry можливе коротке очікування: liveness не означає, що старий lease уже доступний.

## Heartbeat і публічний контракт

Міграція `0019_service_heartbeats` залежить від B25 `0018_reconciliation_runs`. `ServiceHeartbeat` зберігає тільки випадковий технічний instance UUID, service, seen_at, stopped, release. Немає PID, owner/store/run ID, кількості черги, назв файлів чи винятків.

Окремий thread оновлює heartbeat кожні10s незалежно від активності jobs, у т.ч. під час ledger wait. Technical default stale —45s; це не строк бізнесової задачі та не progress/SLA. Один свіжий non-stopped instance означає available; лише старі non-stopped —stale; жодного або всі stopped —unavailable. Майбутній timestamp не вважається живим. Під час startup видаляються не більше100 технічних rows старше доби; GET нічого не чистить і не пише.

`/health` додає `imports:{status,lastSeen,staleAfterSeconds:45}`. Web health `status:ok` лишається незалежним від opt-in worker, щоб його відсутність не зупиняла звичайний портал. `python manage.py import_worker_health` — read-only worker probe, exit0 лише за available.

GET import detail/history додає optional read-only `worker` того самого формату; один DB aggregate на всю history page, без N+1. Creator і поточна edit role перевіряються перед читанням import. Control ACK може не містити worker: його payload/idempotency не змінено. Schema й runtime decoder перевіряють enum/string/timestamp/45s; available/stale мають timestamp. UI для queued/running показує unavailable/stale повідомлення, зберігає лічильники та початкові options; refresh лише читає, не запускає POST/Apply. Current visible-run polling і recovery/draft правила не змінено.

## Opt-in Compose та окреме оновлення

Це **код і runbook**, не виконаний VPS release. У `compose.production.yaml` додано лише `import-worker`, profile `imports`, той самий Dockerfile і обмежена DB app-role. Йому доступна тільки internal accounting network: немає edge, портів, storage чи адміністративних DB credentials. Command минає `server/start.sh`, тому worker не запускає migrate/bootstrap. Увімкнення робити лише після звичайного web migration/healthy. Resource limits512MiB/0.5CPU — початкові технічні обмеження, capacity не виміряно.

Після окремо авторизованого релізу й перевірки backup/migration, тільки у `/opt/tsukenya`:

```sh
cd /opt/tsukenya
# Read-only config validation:
docker compose -p tsukenya -f compose.production.yaml --profile imports config --quiet
# Початкове opt-in: web уже healthy, schema0019 застосована його startup:
docker compose -p tsukenya -f compose.production.yaml --profile imports up -d --build --no-deps import-worker
docker compose -p tsukenya -f compose.production.yaml --profile imports ps import-worker
docker compose -p tsukenya -f compose.production.yaml --profile imports logs --tail 100 import-worker
docker compose -p tsukenya -f compose.production.yaml --profile imports exec import-worker python manage.py import_worker_health
```

**Наступний release.py оновлює тільки web. Він не оновлює вже запущений worker**, а Compose файл передається тільки з `--with-compose`. Перед зміною коду/schema з активним worker:

1. `docker compose -p tsukenya -f compose.production.yaml --profile imports stop import-worker` — дочекатися зупинки, перевірити стан committed chunks у журналі.
2. Виконати звичайний узгоджений backup/release web/migrate/health за `SERVER-DEPLOYMENT.md`; для початкового додавання сервісу — передати Compose явним `--with-compose`.
3. Окремо `up -d --build --no-deps import-worker`, перевірити worker probe та web `/health.imports`; прочитати власний run без повторного Apply.

Зупинка profile: та сама scoped команда `stop import-worker`; web/DB/інші проєкти не зупиняються. Відкат коду: спочатку stop worker, потім чинний web rollback; rebuild/restart worker тільки сумісною версією. Якщо старий код не має continuous command, лишити worker вимкненим, а не запускати старий image циклічно. Дані imports/0019 назад не видаляти. `deploy/release.py`, gateway, production profiles/контейнери, VPS/backup не змінювались і не запускались у цій задачі.

## Цільові перевірки

- PostgreSQL `tests.test_import_worker`: **5 PASS11.244s**. Реальний subprocess SIGTERM всередині apply дозволив commit100/201 і stop; restart завершив201, той самий planRevision,201 audit без повторів. Два continuous runners не дублювали рядки; Cancel і відкликана роль не застосували товари. Heartbeat fresh/stale/stopped/future, late pulse fence, read-only/privacy/30-row history snapshot і bounded CLI перевірено.
- Після early review повторено **лише один** affected argument/health test: continuous+run відхилено без global heartbeat, bounded run сумісний —PASS0.014s. Решту успішних PG proofs не повторено.
- Native `tests/import-worker-ui.cjs`: actual isolated server/continuous CLI,1001 synthetic rows, unavailable→stale→available→SIGTERM queued validating→restart ready→явний Apply completed. Один create/Apply, options27%/price збережені, keyboard refresh повертає focus у heading,1440/320 без horizontal overflow. Ніяких ручних `--once` для цього сценарію. SQLite native proof не підміняє PG concurrency.
- Артефакти `/tmp/tsukenya-import-worker-native/report.json`, `worker-available-1440.png`, `worker-available-320.png`, `worker-stopped-320.png`; viewport PNG переглянуті. Початковий browser setup не мав frontend/dist; після підключення існуючої перевіреної збірки affected scenario пройшов. Runtime errors=[]; physicalDevice=false.
- Runtime DTO/recovery Node tests PASS; OpenAPI generated, tsc PASS. Compose parser validation з `--no-env-resolution --quiet` PASS (без читання env/створення сервісів), Python/JS syntax і migration consistency PASS.

Повна регресія, real container kill/power-loss,150s production shutdown, network/capacity/SLA й реальний телефон не перевірялись. Реліз worker ще не виконаний. Чинний bootstrap/trading контракт не змінено; new tests потрапляють у Django discovery, native lifecycle script залишається opt-in targeted QA.

## Root інтеграція

Root незалежно перевірив direct-command Compose boundary, internal-only мережу, окремі app/admin credentials у документації, stopped-instance heartbeat fence та best-effort shutdown/restart runbook. Виявлений targeted `--continuous --run` global-availability gap виправлено до delivery; чинний bounded `--run` збережений. На інтегрованому коді PostgreSQL **2 PASS** (GET-only creator/health/history privacy й один aggregate на30row page, future heartbeat/argument guard), strict DTO/recovery VM PASS. Actual320 viewport PNG і native report переглянуті; незмінені agent PG5/native1001 докази використано повторно. Native lifecycle script також зареєстровано в explicit `test:full`; перевірено синтаксис, повний прогін не запускався. Release/VPS/service activation/0.1 не виконані.
