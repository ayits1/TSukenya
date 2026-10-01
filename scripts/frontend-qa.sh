#!/usr/bin/env bash
set -euo pipefail
task_mode="${1:-check}"
case "$task_mode" in check|update) ;; *) echo 'Usage: frontend-qa.sh [check|update]' >&2; exit 2 ;; esac
task_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$task_root"
mkdir -p frontend/tests/baselines/linux frontend/test-results frontend/playwright-report
docker build --platform linux/amd64 -f frontend/Dockerfile.qa -t tsukenya-frontend-qa:local .
task_command='npm run test:components && npm run test:visual'
if [[ "$task_mode" == update ]]; then
  task_command='npm run test:components && npm run test:visual:update'
fi
docker run --rm --init --platform linux/amd64 --ipc=host \
  --mount "type=bind,source=$task_root/frontend/tests/baselines/linux,target=/workspace/frontend/tests/baselines/linux" \
  --mount "type=bind,source=$task_root/frontend/test-results,target=/workspace/frontend/test-results" \
  --mount "type=bind,source=$task_root/frontend/playwright-report,target=/workspace/frontend/playwright-report" \
  tsukenya-frontend-qa:local sh -c "$task_command"
