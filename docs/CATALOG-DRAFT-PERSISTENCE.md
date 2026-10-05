# B06: React каталог і довідники після reload

## Протокол та межа реалізації

База author checkout — frozen catalogue126 `eb56f9d99e0affc5c4d7d58b58de5eaa1e655ee4`.
Final acceptance/rebase і докази додаються після реалізації. Цей початковий запис
описує контракт, не оголошує готовність або виконані тести.

Actual ProductEditor (CREATE/UPDATE/visibility/guarded DELETE), його inline
reference CREATE та reviewed ReferenceManager B30 commit підключаються до
чинних DraftStore/RecoveryController. Same-tab/same-session P0 лишається межею;
Restore/Discard явні, business fetch ніколи не запускається під час restore.

Новий frozen envelope має `{key,operation,target,store,request}`. UUID canonical;
operation — product_create/product_update/product_visibility/product_delete/
reference_create/reference_commit. Target потрібний лише для existing product
або source reference; store — explicit pricing context або null. Request містить
лише поля чинного відповідного контракту; B30 idempotencyKey дорівнює key.
Fingerprint — SHA256 canonical JSON envelope зі збереженою scalar spelling;
decimal strings не перетворюються на Number і не підміняють бізнес-нормалізацію.

Execute делегує чинним серверним сервісам усередині LedgerLock/atomic boundary.
Fresh actor і scope перевіряються перед creator/fingerprint receipt lookup;
exact committed replay повертає первісну компактну acknowledgement до current
revision/active/deleted checks. Receipt `catalog_action_receipts/<UUID>` містить
лише author/fingerprint/compact acknowledgement. Цей prefix не входить у generic
legacy collection allowlist; нової моделі/міграції не потрібно.

ACK та readonly identity мають `{confirmed,key,operation,target,requestHash,outcome}`.
Непідтверджена identity не доводить known absence, поточний стан — не authorship.
Fresh context/identity читаються READ ONLY RR; поточні Product/selected-reference
metadata читаються окремими чинними bounded endpoints. Compact confirmation
записується до independent current GET; confirmation не приймає current revision
як Save baseline. DELETE не відновлює видалене; changed original replay нічого
не перезаписує. Author/payload collision дає409.

Лише initial live400 validation або rollback409 conflict може отримати bound
write_rejected proof після inner rollback. Permission/collision/postcommit errors
не отримують proof; після unknown/reload будь-який пізніший4xx лишає intent.
Оригінальна дія повторюється окремою type=button навіть за нового invalid raw.

Storage whitelist: editable baseline fields/revision/target і readonly stable
reference IDs для pinning, raw editable strings/checkboxes, власний inline draft,
frozen exact intent і compact confirmation. Немає Product DTO, pricing/campaign
cache, recipe/unknown JSON, permissions, CSRF/session credentials або DOM/PDF.
Capture та quota replacement успішні до першого network await; fresh session,
resource read і останній generation/signal fence стоять перед actual fetch.

Fresh GET не стирає newer input. Existing product comparison використовує чинні
threeWay groups; local Apply встановлює baseline, окремий Save надсилає mutation.
B30 fresh preview/review охоплює whole impact, не page1; snapshot/UUID frozen.
Серверні pricingRevision/type-category/B03/unknown SQL merge/DELETE guards і
bounded126 metadata зберігаються. Private body приховується при непройденому
read/session gate; current401/403 застосовує P0, late/cancelled transport ігнорується.

Поза пакетом: Studio/CampaignManager/assortment/receipt-price review recovery,
cross-device persistence, capacity, повна регресія, deployment і backup0.1.
