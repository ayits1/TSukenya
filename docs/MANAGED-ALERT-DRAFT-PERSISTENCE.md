# B06: керовані задачі після reload

База: accepted `e50f85258d6b488b90fbb248bd73af9937a9bdd6`.
Цільова сім’я — auto/reprint accept/defer/complete/resume та raw відкладення.
Цей перший commit містить тільки backend read contracts; actual P0 consumer
ще не завершений і весь B06/P2 не оголошується виконаним.

## Read contracts

- `GET /api/erp/alerts/tasks/{id}/recovery-context`, без query: strict
  `managed-alert-context-v1`, поточний role/store/networkOwner, whitelist task
  identity/title/revision/scope/store/cycle/active/workState/until/reason і canAct.
  Inactive condition дозволяє читання, але canAct=false; завершений reprint має
  canAct=true через чинну можливість resume. Остаточну дію вирішує сервер.
- `POST /api/erp/alerts/tasks/{id}/identity` з `{request: exact original body}` —
  **read-only**. Жодного business action, ledger lock або DML. Fresh active actor
  всередині READ ONLY RR і поточна visibility/scope перед receipt lookup.
  Missing task не надає історичного grant і повертає403.
- `AlertTaskAction` уже містить UUID/author/task/fingerprint/appliedRevision/cycle.
  Identity повторює точну існуючу JSON serializer семантику, включно raw reason
  та написанням UUID, без нових separators/нормалізації. Чужий author/task/body —
  409; відсутність receipt — confirmed=false, це не proof відсутності запису.
  Positive DTO містить key/task/action/observedRevision/appliedRevision/appliedCycle.
  Current revision/cycle читаються окремо й не підміняють первісний результат.

`managed_alerts.action`, порядок lock/authorization/receipt/revision та його
response shape не змінено; міграцій немає. Вихідний lifecycle описано у
`MANAGED-ALERTS.md`.

## Цільові докази першого backend commit

`tests.test_managed_alert_drafts`: **6 PASS, PostgreSQL18, 0.831s**.
Контекст різних ролей/read vs act; raw serializer/uppercase UUID parity;
creator/task/fingerprint mismatch; absent receipt/missing task; fresh current
actor після HTTP auth; підтвердження старої дії після resolve/cycle2; capture SQL
без DML/FOR UPDATE та реальний RR при конкурентній зміні задачі.

Лог: `/tmp/tsukenya-managed-drafts-pg.log`. Runner:
`/tmp/tsukenya-managed-drafts-pg.py`; existing disposable local
`tsukenya-review-pg18`, перевірений `127.0.0.1:62812`, унікальна роль/тестова БД,
production environment scrub, synthetic credentials, finally cleanup.
Тестову БД й роль видалено. Python syntax PASS. Existing mutation/concurrency
oracle не повторювали: mutation inputs/source незмінені.

Native/codec/keyboard/layout докази додаються наступним commit. Full, VPS,
Google Sheet, production data, generic ordinary-task codec й catalogue не чіпали.
