---
name: tsukenya-development
description: Develop and review TSukenya frontend components, API integration and trading workflows using the repository architecture, Storybook checks and accounting invariants. Use for changes in this project, not general React advice or unrelated apps.
---

# TSukenya development

Read the repository state before choosing a migration boundary. The production UI is mixed: the catalogue and Label Studio live in `frontend/src/features/catalog/` and `frontend/src/features/labels/`, mounted into the `app/` shell; trading screens remain in `app/`. Read `docs/CATALOG-MIGRATION.md` and `docs/LABEL-STUDIO.md` for this boundary. Stories and the component lab use synthetic data; the integrated catalogue writes server documents. A successful lab build does not mean a production screen has been migrated or deployed.

## Route the task

- For React components and UI behavior, read [frontend foundation](../../../docs/FRONTEND-FOUNDATION.md) and the relevant component/stories. For constructor geometry and print changes, also read [UI quality](../../../docs/UI-QUALITY.md).
- For API and module boundaries, read [stack evolution](../../../docs/STACK-EVOLUTION.md) and the actual Django endpoint/service being changed. OpenAPI exists for the catalogue and labels in `contracts/catalog.openapi.json`; generate types with `npm run generate:api`. DRF and trading module contracts remain planned.
- For stock, cash or payroll, read [CRM implementation](../../../docs/CRM-IMPLEMENTATION.md) and related server tests.
- For an authorized release, read [server deployment](../../../docs/SERVER-DEPLOYMENT.md). Scope operations to this project. Existing authorization applies; this skill does not introduce another permission step.

## Components and layout

Use the same component and stylesheet in Storybook and the application. Prefer extending `frontend/src/shared/ui/` before introducing a second implementation. React Aria owns keyboard, selection, overlay and focus behavior; project CSS owns appearance. Preserve the distinction between temporary search text and a committed product.

Check the relevant states: long Ukrainian labels, empty results, errors, loading where asynchronous, disabled controls, keyboard cancel/commit and focus return. Verify controls and overlays at narrow widths and enlarged text. Select arrows have reserved space and remain centered; touch targets are at least 44 px. Do not fix a shared component with a page-specific selector.

Use explicit variants and composition when behaviors diverge. Keep business requests outside visual controls. Use strict types and decode network input; a TypeScript cast is not runtime validation. Avoid storing derived state in effects or adding global state before it is needed. Lazy-load heavy printing/import modules when integrating them into real routes.

## Domain invariants

- Server services and PostgreSQL are authoritative for money, stock movements, roles and audit. Posting a document and its movements must remain atomic and safe against retries.
- Payroll is a rate per shift plus a configurable percentage of store turnover during that shift. Preserve the terms captured in the shift/accrual; payouts and advances are separate movements.
- New money contracts use decimal strings; calculations and final rounding belong to server Decimal. Existing legacy number fields require an explicit adapter, not a silent reinterpretation.
- Unknown Google Sheet IDs do not prove intentional deletion. Stop destructive synchronization and surface row context. Multi-device coordination also needs retry/idempotency handling; a browser flag is insufficient.
- Price review date and purchase-document date are separate concepts. Missing cost data must remain visible in analytical coverage.
- Preserve saved label layout versions and physical mm/pt dimensions. Screen zoom must not affect printed size. Compare output/PDF when changing rendering.

## Verification and maintenance

Fast development is the default. Read [development modes](../../../docs/DEVELOPMENT-MODES.md) and choose checks for the changed behavior. Reuse successful results while their inputs remain unchanged; do not run Docker or the full browser matrix for ordinary edits. Full regression is an explicit user-requested mode with one entrypoint, `npm run test:full`; route it to the sibling `tsukenya-full-check` skill. After a failure, retry the affected stage rather than automatically repeating the entire suite.

Run checks proportional to the changed behavior using the commands in the frontend reference. Shared controls require their stories, interaction checks and layout/accessibility verification. Accounting changes require the relevant server scenarios, including concurrent/repeated posting where affected. Test business mutations only against isolated data.

Use the fixed Linux QA image for canonical visual baselines. Inspect changes before updating PNGs; retain failure artifacts. Record what was checked and what remains unverified, such as physical printing, screen readers or load capacity.

Versions and installation policy live in the root lockfile and package metadata. Update packages as compatible groups with the corresponding tests. Never include private sessions, customer exports or `.env` contents in stories, artifacts or logs.
