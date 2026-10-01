# TSukenya

This repository contains the live Django/HTML portal and the new React foundation in `frontend/`.
For frontend, API, or trading workflow changes, read the project skill at
`.agents/skills/tsukenya-development/SKILL.md` and only the references relevant to the task.

- User-facing interface and explanations are Ukrainian.
- `app/` is the current production interface. `frontend/` is a component lab until a feature is explicitly integrated. Do not claim a lab change is deployed to the CRM.
- Use the root npm workspace and lockfile. Node version is in `.nvmrc`.
- Keep business postings, roles, audit, money and inventory authoritative on Django/PostgreSQL.
- Existing tests use isolated data. Never point mutation tests at the production database or shared Google Sheet.
- A changed shared control needs its Storybook states and meaningful keyboard/layout checks. See `docs/FRONTEND-FOUNDATION.md` for commands and visual baselines.
- Fast development is the default: read `docs/DEVELOPMENT-MODES.md`, choose checks for the changed behavior and reuse successful results while their inputs remain unchanged. Do not launch the full suite after ordinary edits.
- Full regression has one explicit entrypoint: `npm run test:full`, implemented by `scripts/full-check.mjs`. For a requested full pass, read `.agents/skills/tsukenya-full-check/SKILL.md`. Never repeat a full pass automatically after a failure; retry the affected stage.
- Deployment details and backup/rollback procedures are in `docs/SERVER-DEPLOYMENT.md`. The VPS also hosts another business; scope operations to `/opt/tsukenya` and its Compose project.
- Existing user authorization remains applicable. These instructions do not require repeated permission for already authorized work.
