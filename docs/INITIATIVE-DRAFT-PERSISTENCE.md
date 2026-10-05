# B06: відновлення одинадцяти дій ініціатив

База `d35b6149f062b29181eaed94910d0df177ca525b` (accepted PR115).
Межа: create/edit/start/complete/result_edit/cancel/task_create/task_link/task_update/
expense_attach/expense_detach у реальному `app/initiatives.js`. Поточний перший
commit додає лише серверні readers; завершення consumer або всього B06 ще не
заявляється.

## Незмінні правила

Authoritative `initiatives.mutate()` не змінено: ledger lock, fresh active owner,
scope, canonical key, exact historical replay, revision checks, KPI/Decimal,
whole-expense attribution, audit й ProjectOperation receipt зберігаються.
ProjectOperation уже містить достатній actor/project/key/fingerprint/result;
міграцій немає. Attach/detach витрат допускаються також для completed/cancelled
проєкту. Detach не додає вигадану voucherRevision і не змінює проведення витрати.

## Read contracts

- `GET /api/erp/initiatives/recovery-context`: тільки короткі scalar
  action/project/idea/task/voucher/store, exact набір параметрів для дії; duplicate
  query keys заборонені. Read-only RR і fresh owner всередині snapshot.
  Повертає `initiative-recovery-context-v1`, чинний actor scope, scalar plan/result,
  exact project revision або idea/task token64 і selected source, canWrite/reason.
  Source missing/ineligible лишає primary project доступним із canWrite=false.
  Foreign scope/недоступний primary повертає403. Закритий стан не є втратою grant.
  Exact `selection` envelope повертає requested project/idea/task/voucher/store;
  selected create store відділений від actor storeId. Missing source не стирає
  expected ID, тому consumer може відхилити відповідь для іншої вибірки.
- `POST /api/erp/initiatives/operation-identity`: **тільки читання**,
  `{project: null|canonicalUUID, request: exact frozen body}`. Existing serializer
  `sha256(json.dumps([project_id,value],sort_keys=True,separators=(',',':'),
  ensure_ascii=False,allow_nan=False))` не нормалізує raw/decimal/null/omitted.
  Current primary grant + actor/key/route/fingerprint перед positive receipt.
  Відсутність receipt — confirmed=false, не доказ відсутності запису.
  Positive `initiative-operation-identity-v1` містить project/appliedRevision,
  observedRevision/observedIdeaRevision, key/action/routeProject; історичний
  plan/tasks/expense payload не повертається і не стає current baseline.
- Scalar extraction `result__project__id/revision` не матеріалізує весь receipt.
  Expense context читає тільки header і JSON scope/category; task token потребує
  одного поточного Document.data, але DTO повертає лише whitelist.
- Чинні list/detail/options/idea/candidates/source readers тепер теж refresh-ять
  cached HTTP actor всередині RR. Окрема server mutation authority незмінна.

## Перший серверний доказ

`tests.test_initiative_drafts`: **6 PASS, PostgreSQL18, 1.540s**.
Усі11 типів actual operation receipts після наступних змін; exact raw/decimal
serializer та creator/key/route; old expense receipt після detach; closed-project
expense eligibility; missing source/foreign scope; malformed/duplicate query;
fresh role/deactivation для нових і чинних read paths; scalar projection та SQL
без DML/FOR UPDATE; concurrent project change після actor read підтверджує RR.
Ізольовані fixtures, не production.

Лог `/tmp/tsukenya-initiative-drafts-pg.log`, runner
`/tmp/tsukenya-initiative-drafts-pg.py`. Перед створенням унікальної QA ролі/БД runner
fail-closed звіряє existing QA container `tsukenya-review-pg18` із єдиним binding
`127.0.0.1:62812`; inherited DB/PG/URL env прибираються. У finally тестову БД і роль
видалено. Syntax/diff PASS. Чинні mutation/accounting concurrency proofs reused;
повна регресія, production, VPS, браузер на цьому серверному кроці не запускалися.

## Подальша цілісна межа

Domain codec і реальні11 consumers: raw whitelist, незмінний first intent,
positive identity durable до independent current GET, explicit Restore/Apply/Save,
KPI three-way merge, source terms, quota, cold/warm privacy та last-await fences.
Ordinary task adapter не використовується для initiative mutation bypass.
Options all-active users/stores та інші B24 оптимізації цим пакетом не оголошуються
вирішеними. Actual consumer proofs буде додано після реалізації.

Additive exact-selection follow-up: лише
`test_context_exact_selection_survives_absent_sources_and_separates_actor_scope`
**PostgreSQL PASS1, 0.193s**;
`/tmp/tsukenya-initiative-drafts-selection-pg.log`. Request store відділений від
actor store, missing task/voucher залишають exact selection. Попередні PG6 reused.
