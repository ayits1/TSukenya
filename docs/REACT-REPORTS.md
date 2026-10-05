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
