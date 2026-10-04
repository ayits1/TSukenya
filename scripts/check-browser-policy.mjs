// Static check only: this command never starts a browser or a test server.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const self = fileURLToPath(import.meta.url);
const files = [];
function collect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collect(path);
    else if (/\.(cjs|mjs|js|ts|sh|py)$/.test(entry.name) && path !== self) files.push(path);
  }
}
collect(join(root, 'tests'));
collect(join(root, 'scripts'));
files.push(join(root, 'frontend/playwright.config.ts'), join(root, 'frontend/vitest.config.ts'));
const prohibited = [
  /\/Applications\/Google Chrome\.app/,
  /\bexecutablePath\s*:/,
  /\bchannel\s*:\s*['"](?:chrome|msedge)/,
  /\bheadless\s*:\s*false/,
  /process\.env\.CHROME_PATH/,
  /chrome-devtools/,
];
const errors = [];
for (const file of files) {
  readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
    if (prohibited.some(pattern => pattern.test(line))) errors.push(`${relative(root, file)}:${index + 1}`);
  });
}
if (errors.length) {
  console.error('Use bundled Playwright Chromium, headless: true, without channel/executablePath:\n' + errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Browser policy: PASS (${files.length} source files; no browser launched)`);
}
