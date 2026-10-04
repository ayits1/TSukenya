# B21 — цільова серверна перевірка

Ізольований clone, власна PostgreSQL test-база `test_tsukenya_import_jobs`; жодних VPS/Sheet/production writes. Повний набір не запускався.

## Результат

25 цільових тестів PostgreSQL PASS, 51.776с. Вони охоплюють:

- 1001 рядок, upload6 пакетів, worker apply100 за крок, відновлення зі збереженого курсора після першого пакета; рівно1001 продукт та catalog_changed, без дублювання після повторного applyACK;
- whole-file duplicate name/line/barcode на межі пакетів; до apply жодних продуктів;
- створення/оновлення/пропуск/конфлікт окремого рядка, відмова чинного barcode-валідатора без зупинки інших рядків;
- exact lostACK create/chunk/seal/apply, змінений запит під старим ключем409, GET-only журнал та receipts без записів;
- два паралельні workers, паралельне підтвердження, expired lease та старий token; no duplicate product/audit;
- реальна затримка на LedgerLock і відкликання прав автора перед продовженням → blocked, без продуктів чи audit;
- rollback продуктів, outcomes та audit поточного пакета при технічній помилці, повтор лише pending; скасування після100 commits;
- creator-only reads, інший owner404, cashier403, актуальна роль після відновлення;
- sourceHash/genericAs/defaultMarkup незмінні й доступні при reload; explicit bounds/invalid filters/no mutations;
- unit guard існуючих облікових документів, зміна цінової конфігурації та campaign після плану;
- збереження чинних price observations/price_changed при обмеженні PriceResolver до потрібних paths;
- міграція0017: лише валідні історичні receipts, forward/reverse/forward;
- чинний малий atomic ACK/повтор/rollback/PG same-key race та дві перевірки довідників.

До остаточного PG прогону12 ранніх API/worker перевірок,3 нові1001/resource/perrow сценарії та migration проходили SQLite; цей результат повторно не видається за підтвердження PostgreSQL locks.

## Команда остаточного цільового прогону

Використано локальні синтетичні DB credentials через environment, `DB_NAME=tsukenya_import_jobs`; пароль не належить робочому середовищу.

```sh
/tmp/tsukenya-review-venv/bin/python manage.py test \
  tests.test_catalog_import_jobs.CatalogImportJobsTests \
  tests.test_catalog_import_jobs.CatalogImportJobsPostgresTests \
  tests.test_catalog_import_jobs.CatalogImportJobsMigrationTests \
  tests.test_catalog_import.CatalogImportTests.test_atomic_create_update_legacy_references_and_preservation \
  tests.test_catalog_import.CatalogImportTests.test_write_failure_rolls_back_previous_rows_and_audit \
  tests.test_catalog_import.CatalogImportConcurrencyTests.test_parallel_same_key_returns_one_committed_import \
  tests.test_catalog_references.CatalogReferenceTests.test_existing_product_choices_and_default_unit_have_stable_ids \
  tests.test_catalog_references.CatalogReferenceTests.test_product_create_uses_standalone_choices_and_legacy_import_stays_compatible \
  --noinput
```

`makemigrations --check --dry-run`: No changes detected. `git diff --check`: PASS. Реальна0017 залежить від прийнятої0016_multiple_daily_work_shifts. Worker/scheduler на VPS не запускався. Capacity100000 рядків та production memory/network не вимірювались;1001 синтетичний SKU не є SLA. UI/OpenAPI та native reload-proof веде окремий агент, вони не входять у цей серверний доказ.
