---
name: tsukenya-full-check
description: Run the explicit full TSukenya regression command and report coverage and failures. Use when the user asks for all tests or a full regression; ordinary development uses targeted checks.
---

# TSukenya full check

Read [development modes](../../../docs/DEVELOPMENT-MODES.md). A requested full regression uses the single root command `npm run test:full`; `npm run test:full -- --plan` lists its stages without executing them. Do not reconstruct the full suite as separate repeated commands.

Ordinary edits use the development skill and checks for the changed behavior. Do not start a full run just because a file changed or a task is ending. Existing explicit authorization for a full pass remains valid; do not ask for it again.

Before the run, check the documented prerequisites and select `PYTHON_BIN` if the project environment is elsewhere. The runner creates isolated PostgreSQL and browser test data; never replace these with the production database or shared Sheet. Do not load private deployment variables to satisfy test prerequisites.

Run once. Keep visual baselines unchanged. On failure, report the failing stage and which later stages did not run; fix the cause and retry the affected stage. Repeat the entire run only when the change creates a concrete risk across stages or the user requests another full pass. A missing browser or dependency is a prerequisite failure, not a business regression.

Read `test-results/full-check.json` and relevant failure artifacts. Report completed coverage, remaining limits and cleanup problems. A green result does not verify physical printing, backups, load capacity or migration to React, and does not authorize deployment. If interrupted, verify this invocation's test container was removed; never prune unrelated Docker resources.
