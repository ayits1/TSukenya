# B06: основа відновлення чернеток після перезавантаження (P0)

База: `9174b00e16c55e74d0229a56e0bff87c6d50a444`. Цей пакет реалізує спільну основу. **Робочі редактори P1–P3 ще не підключені; загальна вимога B06 залишається незавершеною.**

## Межа зберігання

Перший підтримуваний режим — та сама вкладка, той самий чинний серверний сеанс після reload. `sessionStorage`, власний префікс `tsukenya:draft:v1:`, версія envelope та версія кожного codec. Закриття вкладки, новий login, інший пристрій і довготривале серверне зберігання не підтримуються. Звичайна друга вкладка має окреме сховище; дублювання вкладки браузером може копіювати його, тому це не механізм виключного володіння запитом.

`GET /api/v1/session` зберігає чинні `role`/`csrf` і додає `draftOwner`, `draftSession`, `storeId`, `networkOwner`. Нові поля optional у спільному Session OpenAPI для сумісності старих клієнтів; recovery decoder вимагає їх усі. Обидва binding — окремі SHA256 HMAC від ідентичностей користувача/сеансу. Вони не є credential або дозволом. CSRF, cookie, пароль, session token/hash не потрапляють у збережений binding. Сервер повторно читає активного користувача, актуальний profile та чинний PortalSession в одній PostgreSQL `REPEATABLE READ, READ ONLY` транзакції. GET не пише дані.

Локальний запис розділяє `baseline`, сирий `draft`, `firstIntent`, `confirmation`. Невалідні новіші поля допустимі у draft за правилами відповідного редактора. Первісний method/path/key/body/revision не можна підмінити чи очистити через звичайний save, доки результат невідомий. `beforeSend(id)` повертає тільки вже записаний первісний запит. Quota/ліміт/пошкоджений запис блокують відправлення; попередній валідний запис зберігається. ACK приймає тільки явний доменний `confirm`, який має перевірити серверний ресурс, авторство та первісний намір; загальна основа не обчислює бізнес-формули й не підтверджує довільну відповідь.

Ліміти: 20 записів, 2 MiB на запис, 3 MiB разом, 30 000 JSON вузлів, глибина 16. Немає автоматичного eviction невідомих запитів. Пошкоджена або невідома версія отримує лише постійний загальний підпис без виведення її полів; доступне явне локальне відкидання. Відкидання не скасовує серверну операцію.

## Підключення редактора

Спільний код: `frontend/src/shared/recovery/`. React використовує `DraftStore`, `RecoveryController`, `RecoveryPanel`; native shell має additive `window.NativeDraftRecovery` з тієї самої реалізації у чинному native conflict entry. Автоматичного підключення форм немає. Не додано порожню кнопку відновлення на всіх екранах без enrolled editor.

Кожен trusted codec обов'язково задає:

- Постійні `name`, `version`, загальний український `label`, strict whitelist `decode` для власного ресурсу. Сховище додатково перевіряє bounded JSON та заборонені credential/prototype keys; це не заміна whitelist бізнес-полів.
- `authorize(payload, session, signal)` — актуальне авторитетне read-only читання дозволу та resource identity/scope, без бізнес-запису. Binding не замінює цей запит.
- `restore(payload)` — тільки локальне застосування введення; без POST, автоматичного Save або вибору нової baseline з identity receipt.
- `suspend()` — негайне приховування приватного UI при pagehide, hidden tab, зміні/помилці сеансу або dispose. Закриття лише recovery-діалогу скасовує pending reads, але не викликає hide цього вже відновленого редактора. Це hide-only callback: binding уже заблокований, тому save з нього не дозволений. Enrollment має синхронно завершувати capture/storage save на кожному редагуванні ДО lifetime transition; callback нічого не записує і не відновлює мовчки після повернення. Якщо capture не вдався, інтеграція показує явну помилку й не відправляє бізнес-запит.
- За потреби `confirm(payload, acknowledgement)` з exact semantic ACK. Після підтвердженого запису та невдалого GET зберігається read barrier; повтор POST не дозволяється.

Порядок інтеграції: enrollment → fresh binding/read permission → запис draft/первісного запиту **до** fetch → `beforeSend` → strict ACK або unresolved intent. Exact retry використовує заморожені method/path/body/key, а не нові поля. Підтвердження, identity/current GET, локальне Apply і окремий Save залишаються різними діями.

Restore завжди явний. Controller перечитує session, потім codec перевіряє resource; generation/AbortSignal, binding та точний збережений текст захищають від late adoption й одночасного локального редагування. На session GET401/403 сховище цієї вкладки очищається й UI приховується. Resource authorize403 стосується лише конкретного запису: controller повторно перевіряє session без показу інших чернеток, видаляє лише відхилений запис і показує notice. Інші невідомі запити зберігаються; якщо актор/роль/магазин уже змінилися, fresh binding застосовує session-wide privacy fence. Late/cancelled denial не видаляє записів. Помилка storage removal показується явно, залишає попередній запис і приховує приватний UI до повторної перевірки. На 503/protocol failure запис залишається на диску, але не показується до нового успішного читання. Повідомлення `tsukenya:session-invalidated` та advisory BroadcastChannel revoke містять тільки сигнал, без полів/ключів/credentials. Вони не є серверною авторизацією.

Існуючі редактори ще не посилають цей event з усіх 401/logout шляхів і не мають власних codecs. Це частина P1–P3, разом зі стабільними CREATE receipts, поточними permissions, domain-specific keys/headers і confirmed-read barriers. Немає загального FormData autosave чи збереження повного каталогу/фінансового cache. Same-origin JavaScript має доступ до sessionStorage; це не зашифроване сховище і не захист від XSS.

## Виконані цільові перевірки

- PostgreSQL18, `DB_NAME=tsukenya_draft_foundation`, `/tmp/tsukenya-review-venv/bin/python manage.py test tests.test_draft_sessions --noinput`: **3 PASS**, 0.353s. Актуальна роль/магазин, deactivation, revoked session, missing profile/інший actor, стабільність одного login і новий epoch, відсутність DML та реальний RR/READ ONLY. Тестова база видалена.
- `npm run test --workspace frontend -- src/shared/recovery/recovery.test.ts`: **7 PASS** (77ms після останньої правки storage fence). Exact first body + невалідне нове введення, quota, unknown version, strict ACK, fresh binding, cancel/late read.
- `npm run test:components --workspace frontend -- RecoveryPanel.stories.tsx`: **5 PASS**, 2.00s; клавіатурне Restore, явне Discard/Cancel, checking/error/unreadable. `tsc --noEmit`, цільовий ESLint та frontend build: PASS. Історії повторно не запускались після незалежної правки callback lifetime/storage.
- Native `tests/draft-persistence-ui.cjs`, власний matching build/SQLite/порт18271/Chrome: початковий прогін успішно пройшов reload + invalid draft/exact first intent, Enter Restore без POST, confirmed state, quota, malformed version і Discard/Cancel, геометрію 1440/320/44px. Потім зупинився на **помилці harness**: додаткова page у Playwright owner context. Перехід на явний `browser.newContext()` виправляє fixture. Незмінені вже успішні assertions не повторювали.
- Продовжено лише `QA_DRAFT_FROM=tail PYTHON_BIN=/tmp/tsukenya-review-venv/bin/python node tests/draft-persistence-ui.cjs`: **PASS**. Друга сторінка того самого browser context/cookie login має порожнє sessionStorage; фактичне видалення isolated PortalSession → GET401 приховує restored payload та очищає записи. **0 бізнес-записів** після login. Це не повний повтор першого native прогону і не вимірювання capacity.

Артефакти: `/var/folders/9_/xkms65w90g57nhx8n9bhp6300000gn/T/tsukenya-draft-foundation-proof/`: `draft-recovery-1440.png`, `draft-recovery-320.png` (320 оглянуто), `tail-report.json`; `failure.txt`/`failure.png` збережено для первісної fixture помилки. Harness у наступному звичайному прогоні записує окремий foundation checkpoint перед tail.

Повна регресія, виробничі дані, Google Sheet та VPS не використовувались. Неперевірені межі: інші браузери, screen reader, всі реальні редактори, вкладки після clone/close, cross-device. Наступний пакет P1 має підключити конкретні native редактори й показати фактичний reload з їхніми authoritative receipt/current-read контрактами; P2/P3 — решта порталу та React/action flows з повної B06 карти.

### Follow-up незалежного рев’ю P0

Розділено session denial і resource denial. Цільовий `recovery.test.ts -t 'resource403|discard removal'`: **3 PASS**, 7 skipped, 83ms — два записи з невідомим первісним наміром іншого редактора; fresh session read перед поверненням до інших чернеток; late403 після cancel не видаляє нічого; storage removal failure показується явно й зберігає запис. Додатково перевірено лише дві зачеплені controller перевірки `-t 'fresh permission|late authorization'`; незмінені PG/Story/native докази не повторювались. `suspend` задокументовано як hide-only: capture має завершитися синхронно на input перед lifetime fence, а не через callback після блокування binding.

### Follow-up закриття recovery-діалогу

`controller.dismiss()` скасовує pending session/authorize reads через AbortSignal+generation та прибирає лише стан діалогу. `controller.suspend()` додатково блокує binding і викликає hide-only callbacks усіх підключених редакторів. Close/Escape recovery-діалогу використовують dismiss: після завершеного Restore введення лишається доступним для редагування. Pagehide/hidden/revoke/dispose використовують suspend. Focus повертається до елемента, що відкрив діалог. Немає автоматичного Save після Restore або Close.

Цільові unit `-t 'dismissing'`: **2 PASS**, 10 skipped (87ms) — completed Restore→Dismiss з подальшим локальним save, окремий pending Restore→Dismiss→late response без adoption. Types/lint/build PASS. `QA_DRAFT_FROM=dismiss PYTHON_BIN=/tmp/tsukenya-review-venv/bin/python node tests/draft-persistence-ui.cjs`: **PASS**, фактичний Restore→Enter Close→локальне редагування сирого невалідного draft і capture у sessionStorage; потім видалення isolated PortalSession→GET401 приховує редактор та очищає записи, 0 бізнес-записів. Артефакт `dismiss-report.json` у тому самому proof directory. Старе неправильне очікування «Close очищає restored payload» виправлено у default harness. Незмінені PG/Story/попередні storage/layout scenarios не повторювались. Дозволені `QA_DRAFT_FROM`: undefined (цілий standalone target), `tail` (друга вкладка/401), `dismiss` (цей окремий continuation).
