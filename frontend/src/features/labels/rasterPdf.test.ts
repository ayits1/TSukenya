import { expect, test } from 'vitest';
import { RasterPdf } from './rasterPdf';

test('Blob JPEG bytes, A4 dimensions and every xref offset survive without ArrayBuffer capture', async () => {
  const pages = [
    new Blob([new Uint8Array([0xff, 0xd8, 0, 0x80, 0xff, 0xd9])], { type: 'image/jpeg' }),
    new Blob([new Uint8Array([0xff, 0xd8, 0xc0, 0xff, 0xd9])], { type: 'image/jpeg' }),
  ];
  for (const page of pages)
    page.arrayBuffer = () => {
      throw new Error('JPEG ArrayBuffer copies are forbidden');
    };
  const writer = new RasterPdf(2);
  for (const page of pages) writer.append(page, 2480, 3508);
  const result = writer.finish();
  const bytes = new Uint8Array(await result.arrayBuffer());
  const text = new TextDecoder('latin1').decode(bytes);
  expect(result.type).toBe('application/pdf');
  expect(text).toContain('/Type /Pages /Count 2 /Kids [3 0 R 6 0 R]');
  expect(text.match(/\/MediaBox \[0 0 595\.28 841\.89\]/g)).toHaveLength(2);
  expect(text.match(/\/Width 2480 \/Height 3508/g)).toHaveLength(2);
  const xref = Number(text.match(/startxref\n(\d+)/)?.[1]);
  expect(new TextDecoder().decode(bytes.slice(xref, xref + 4))).toBe('xref');
  const rows = text.slice(xref).split('\n').slice(3, 11);
  for (const [index, row] of rows.entries()) {
    const offset = Number(row.slice(0, 10));
    expect(new TextDecoder().decode(bytes.slice(offset, offset + 9))).toContain(
      `${index + 1} 0 obj`,
    );
  }
  expect(() => writer.finish()).toThrow();
});

test('a cancelled or incomplete job cannot publish a partial PDF', () => {
  const writer = new RasterPdf(2);
  writer.append(new Blob(['first page']), 2480, 3508);
  expect(() => writer.finish()).toThrow();
  writer.dispose();
  expect(() => writer.append(new Blob(['late encoder']), 2480, 3508)).toThrow();
  expect(() => writer.finish()).toThrow();
});
