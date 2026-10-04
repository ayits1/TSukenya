/** Blob-backed JPEG pages avoid retaining a second complete ArrayBuffer copy of the PDF. */
export class RasterPdf {
  private readonly encoder = new TextEncoder();
  private parts: BlobPart[] = [];
  private readonly offsets: number[] = [];
  private length = 0;
  private completed = 0;
  private closed = false;

  constructor(private readonly pages: number) {
    if (!Number.isSafeInteger(pages) || pages < 1)
      throw new Error('Некоректна кількість сторінок.');
    this.put('%PDF-1.4\n');
    this.offsets[1] = this.length;
    this.put('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
    this.offsets[2] = this.length;
    this.put(
      `2 0 obj\n<< /Type /Pages /Count ${pages} /Kids [${Array.from({ length: pages }, (_, i) => `${3 + 3 * i} 0 R`).join(' ')}] >>\nendobj\n`,
    );
  }

  private put(value: string | Blob) {
    this.parts.push(value);
    this.length += typeof value === 'string' ? this.encoder.encode(value).length : value.size;
  }

  append(jpeg: Blob, width: number, height: number) {
    if (
      this.closed ||
      this.completed >= this.pages ||
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width < 1 ||
      height < 1
    )
      throw new Error('Некоректна сторінка PDF.');
    const pageId = 3 + 3 * this.completed,
      contentId = pageId + 1,
      imageId = pageId + 2,
      content = 'q 595.28 0 0 841.89 0 0 cm /Im0 Do Q';
    this.offsets[pageId] = this.length;
    this.put(
      `${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>\nendobj\n`,
    );
    this.offsets[contentId] = this.length;
    this.put(
      `${contentId} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`,
    );
    this.offsets[imageId] = this.length;
    this.put(
      `${imageId} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.size} >>\nstream\n`,
    );
    this.put(jpeg);
    this.put('\nendstream\nendobj\n');
    this.completed++;
  }

  finish(): Blob {
    if (this.closed || this.completed !== this.pages)
      throw new Error('PDF ще не сформовано повністю.');
    const total = 3 + 3 * this.pages,
      xref = this.length;
    this.put(
      `xref\n0 ${total}\n0000000000 65535 f \n${this.offsets
        .slice(1)
        .map((offset) => String(offset).padStart(10, '0') + ' 00000 n \n')
        .join('')}`,
    );
    this.put(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    const result = new Blob(this.parts, { type: 'application/pdf' });
    this.dispose();
    return result;
  }

  dispose() {
    // The result/download URL owns immutable Blob parts after finish; cancelled work owns none.
    this.parts = [];
    this.closed = true;
  }
}
