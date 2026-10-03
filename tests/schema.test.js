// Одна схема стовпців: GS_COLS у застосунку — джерело правди для знімка CSV, шаблону xlsx і README.
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("fs"), zlib = require("zlib");
const {GS_COLS} = require("./sync-harness.js");
const HEADERS = GS_COLS.map(c => c.h);
const root = __dirname + "/../";

// Мінімальне читання zip (xlsx): файл за назвою з центрального каталогу; null, якщо такого немає
function unzip(buf, name){
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = buf.readUInt16LE(eocd + 10); n > 0; n--){
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20), nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30), comment = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    if (buf.toString("utf8", p + 46, p + 46 + nameLen) === name){
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28), data = buf.subarray(start, start + size);
      return (method === 8 ? zlib.inflateRawSync(data) : data).toString("utf8");
    }
    p += 46 + nameLen + extra + comment;
  }
  return null;
}
const xmlText = s => s.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

test("знімок бази CSV має стовпці GS_COLS", () => {
  const first = fs.readFileSync(root + "data/baza-tovariv-2026-09-29.csv", "utf8").replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0];
  assert.deepEqual(first.replace(/^"|"$/g, "").split('","'), HEADERS);
});

test("шаблон xlsx має стовпці GS_COLS", () => {
  const buf = fs.readFileSync(root + "data/baza-tovariv-template.xlsx");
  const strings = [...(unzip(buf, "xl/sharedStrings.xml") || "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => xmlText(m[1]));
  const row1 = unzip(buf, "xl/worksheets/sheet1.xml").match(/<row [^>]*r="1"[^>]*>([\s\S]*?)<\/row>/)[1];
  const cells = [...row1.matchAll(/<c [^>]*?(t="(\w+)")?[^>]*>([\s\S]*?)<\/c>/g)].map(m => {
    const v = xmlText((m[3].match(/<v>([\s\S]*?)<\/v>/) || m[3].match(/<is>([\s\S]*?)<\/is>/) || [, ""])[1]);
    return m[2] === "s" ? strings[+v] : v;
  });
  assert.deepEqual(cells, HEADERS);
});

test("README перелічує всі стовпці GS_COLS", () => {
  const readme = fs.readFileSync(root + "README.md", "utf8");
  for (const h of HEADERS) assert.ok(readme.includes(h), `README не згадує «${h}»`);
});
