# TSukenya

This repository contains the Django portal with a React catalogue and Label Studio in `frontend/` and remaining HTML/JavaScript modules in `app/`.
For frontend, API, or trading workflow changes, read the project skill at
`.agents/skills/tsukenya-development/SKILL.md` and only the references relevant to the task.

- User-facing interface and explanations are Ukrainian.
- `frontend/src/features/catalog/` is integrated at `#operations/products`. `frontend/src/features/labels/` is integrated at `#operations/tags`; `app/` remains the shell and trading UI. The component lab and stories use synthetic data; the integrated catalogue writes real documents. See `docs/CATALOG-MIGRATION.md` and `docs/LABEL-STUDIO.md`.
- Use the root npm workspace and lockfile. Node version is in `.nvmrc`.
- Keep business postings, roles, audit, money and inventory authoritative on Django/PostgreSQL.
- Existing tests use isolated data. Never point mutation tests at the production database or shared Google Sheet.
- A changed shared control needs its Storybook states and meaningful keyboard/layout checks. See `docs/FRONTEND-FOUNDATION.md` for commands and visual baselines.
- Fast development is the default: read `docs/DEVELOPMENT-MODES.md`, choose checks for the changed behavior and reuse successful results while their inputs remain unchanged. Do not launch the full suite after ordinary edits.
- Browser checks use Playwright's bundled Chromium with `headless: true`, without `channel` or `executablePath`. Never launch installed Google Chrome, Chrome DevTools against system Chrome, or a headed browser from automated checks on this Mac. Do not restore `CHROME_PATH` overrides. If needed, install the bundled browser with `npx playwright install chromium`; if no browser verification is needed, launch none. Keep existing isolated headless WebKit checks for explicitly selected cross-engine scenarios.
- Full regression has one explicit entrypoint: `npm run test:full`, implemented by `scripts/full-check.mjs`. For a requested full pass, read `.agents/skills/tsukenya-full-check/SKILL.md`. Never repeat a full pass automatically after a failure; retry the affected stage.
- Deployment details and backup/rollback procedures are in `docs/SERVER-DEPLOYMENT.md`. The VPS also hosts another business; scope operations to `/opt/tsukenya` and its Compose project.
- Existing user authorization remains applicable. These instructions do not require repeated permission for already authorized work.
