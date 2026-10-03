/* One CSV implementation for the classic shell and the React bundle; no business state. */
(() => {
  'use strict';
  const marker = ' [TSukenya CSV 1]';
  const guarded = value => /^[\t\r\n]/.test(value) || /^[\s\p{Cf}\p{Cc}]*[=+@\-＝＋－＠]/u.test(value);
  const quote = value => '"' + value.replace(/"/g, '""') + '"';
  const text = value => { const raw = String(value ?? ''); return guarded(raw) ? '\t' + raw : raw; };
  function numeric(value, label) {
    if (value === '' || value === null || value === undefined) return '';
    if (typeof value !== 'string' && typeof value !== 'number') throw Error(`CSV: «${label}» має бути числом.`);
    const source = String(value).replace(/^[ \u00a0\u202f]+|[ \u00a0\u202f]+$/g, '');
    if (!/^-?\d+(?:[.,]\d+)?$/.test(source) && !/^-?\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:[.,]\d+)?$/.test(source)) throw Error(`CSV: некоректне число у стовпці «${label}».`);
    const raw = source.replace(/[ \u00a0\u202f]/g, '').replace(',', '.');
    if (!/^-?\d+(?:\.\d+)?$/.test(raw)) throw Error(`CSV: некоректне число у стовпці «${label}».`);
    return raw;
  }
  function serialize(columns, rows, options = {}) {
    const delimiter = options.delimiter ?? ';';
    if (![';', ','].includes(delimiter) || !columns.length || columns.some(c => !c || !['text','number'].includes(c.kind) || typeof c.label !== 'string')) throw Error('CSV: некоректний формат стовпців.');
    const headers = columns.map(c => c.label);
    if (options.reversible) headers[0] += marker;
    const body = rows.map(row => {
      if (row.length !== columns.length) throw Error('CSV: кількість полів не відповідає заголовку.');
      return row.map((value, index) => columns[index].kind === 'number' ? numeric(value, columns[index].label) : text(value));
    });
    return (options.bom === false ? '' : '\uFEFF') + [headers.map(text), ...body].map(row => row.map(quote).join(delimiter)).join('\r\n');
  }
  function decode(rows) {
    const header = rows[0]?.[0];
    if (typeof header !== 'string') return rows;
    if (/ \[TSukenya CSV \d+\]$/.test(header) && !header.endsWith(marker)) throw Error('Версія CSV TSukenya не підтримується. Оновіть застосунок.');
    if (!header.endsWith(marker)) return rows;
    return rows.map((row, index) => row.map((cell, column) => {
      if (typeof cell !== 'string') return cell;
      const value = index === 0 && column === 0 ? cell.slice(0, -marker.length) : cell;
      return value.startsWith('\t') && guarded(value.slice(1)) ? value.slice(1) : value;
    }));
  }
  function parse(input) {
    const source = String(input).replace(/^\uFEFF/, '');
    let quoted = false, commas = 0, semicolons = 0;
    // Count separators outside quotes, including headers with commas or embedded newlines.
    for (let i = 0; i < source.length; i++) {
      const ch = source[i];
      if (ch === '"') { if (quoted && source[i + 1] === '"') i++; else quoted = !quoted; }
      else if (!quoted && (ch === '\r' || ch === '\n')) break;
      else if (!quoted && ch === ',') commas++;
      else if (!quoted && ch === ';') semicolons++;
    }
    const delimiter = semicolons > commas ? ';' : ',';
    const rows = []; let row = [], cell = '', inQuote = false, closed = false;
    const pushCell = () => { row.push(cell); cell = ''; closed = false; };
    for (let i = 0; i < source.length; i++) {
      const ch = source[i];
      if (inQuote) {
        if (ch === '"') { if (source[i + 1] === '"') { cell += '"'; i++; } else { inQuote = false; closed = true; } }
        else cell += ch;
      } else if (ch === delimiter) pushCell();
      else if (ch === '\r' || ch === '\n') {
        if (ch === '\r' && source[i + 1] === '\n') i++;
        pushCell(); rows.push(row); row = [];
      } else if (ch === '"' && !closed && !cell) inQuote = true;
      else if (closed && (ch === ' ' || ch === '\t')) continue;
      else if (closed || ch === '"') throw Error('У CSV є зайві символи біля лапок. Перевірте файл.');
      else cell += ch;
    }
    if (inQuote) throw Error('У CSV не закрито лапки. Перевірте файл і завантажте його знову.');
    if (cell !== '' || row.length || closed) { pushCell(); rows.push(row); }
    return decode(rows);
  }
  const api = Object.freeze({ serialize, parse, decode });
  globalThis.TSukenyaCsv = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
