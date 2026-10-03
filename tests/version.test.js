// Номер версії в застосунку збігається з останнім записом CHANGELOG.md.
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("fs");
const {html} = require("./sync-harness.js");

test("APP_VERSION = перший запис CHANGELOG.md", () => {
  const v = (html.match(/const APP_VERSION = "([^"]+)"/) || [])[1];
  assert.ok(v, "у app/index.html немає APP_VERSION");
  const top = (fs.readFileSync(__dirname + "/../CHANGELOG.md", "utf8").match(/^## (\S+)/m) || [])[1];
  assert.equal(top, v);
});
