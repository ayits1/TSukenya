// Правила публікації в Claude Artifact: те, що в рамці артефакту не працює або заблоковано, не має потрапити в app/index.html.
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("fs");
const {html} = require("./sync-harness.js");
const caps = JSON.parse(fs.readFileSync(__dirname + "/../deploy/capabilities.json", "utf8"));
const staging = JSON.parse(fs.readFileSync(__dirname + "/../deploy/capabilities.staging.json", "utf8"));
const script = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || "";
const code = script.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1"); // без коментарів

test("без confirm/alert/prompt: у рамці артефакту вони одразу повертають «ні» і нічого не показують", () => {
  assert.doesNotMatch(code, /\b(confirm|alert|prompt)\s*\(/);
});

test("без window.print: вікно друку з артефакту не відкривається", () => {
  assert.doesNotMatch(code, /\bprint\s*\(\s*\)/);
});

test("сторінка без власних doctype/html/head/body — їх додає платформа; <title> на початку", () => {
  assert.doesNotMatch(html, /<!doctype|<html[\s>]|<head[\s>]|<body[\s>]/i);
  const t = html.slice(0, 8192).match(/<title>([^<]+)<\/title>/);
  assert.ok(t, "немає <title> у перших 8 КБ"); assert.equal(t[1], "Цукерня");
});

test("зовнішні скрипти й стилі — лише з дозволених адрес", () => {
  for (const [, src] of html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)) assert.match(src, /^https:\/\/(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net\/npm\/|unpkg\.com)/);
  for (const [, href] of html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)) assert.match(href, /^https:\/\/fonts\.googleapis\.com\//);
  for (const [, u] of code.matchAll(/\.src\s*=\s*"([^"]+)"/g)) assert.match(u, /^https:\/\/cdnjs\.cloudflare\.com\//, "скрипт, що підвантажується з коду");
  assert.doesNotMatch(html, /<a[^>]*\sdownload[\s>=]/, "посилання download у рамці не працюють — лише capability downloads");
});

test("кожна можливість і кожен інструмент конектора, які викликає код, оголошені в маніфесті", () => {
  const used = new Set([...code.matchAll(/use\??\.?\(\s*"(\w+)"\s*\)/g)].map(m => m[1]));
  for (const c of used) assert.ok(caps[c], `можливість «${c}» не оголошена в deploy/capabilities.json`);
  const decl = s => new Set((caps.mcp.servers.find(x => x.server === s) || {tools:[]}).tools);
  const drive = [...code.matchAll(/drive\(\s*"(\w+)"/g)].map(m => m[1]), sheets = [...code.matchAll(/sheets\(\s*"(\w+)"/g)].map(m => m[1]);
  assert.ok(drive.length && sheets.length);
  for (const t of drive) assert.ok(decl("Google Drive").has(t), `Google Drive: ${t}`);
  for (const t of sheets) assert.ok(decl("Google Sheets").has(t), `Google Sheets: ${t}`);
  assert.match(code, /const DRIVE = "Google Drive"/); assert.match(code, /const SHEETS = "Google Sheets"/);
});

test("тестовий маніфест не має доступу до Google Sheets — тестова копія не може зачепити робочу таблицю", () => {
  assert.ok(!staging.mcp.servers.some(x => x.server === "Google Sheets"));
  assert.deepEqual(Object.keys(staging).sort(), Object.keys(caps).sort());
});

test("обидві теми: кольори на токенах, темна тема і для системного налаштування, і для явного вибору", () => {
  assert.match(html, /@media \(prefers-color-scheme: dark\)\{\s*:root:not\(\[data-theme="light"\]\)/);
  assert.match(html, /:root\[data-theme="dark"\]\{/);
  assert.match(html, /body\{[^}]*background:var\(--bg\)/);
});

test("розмір сторінки в межах ліміту артефакту (16 МБ)", () => {
  assert.ok(Buffer.byteLength(html) < 16 * 1024 * 1024);
});
