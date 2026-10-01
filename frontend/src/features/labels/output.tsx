import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { Label, PrintPages } from './Label';
import { clippedLabel, formatLabelMoney, MAX_LABEL_COPIES, pageGeometry } from './domain';
import type { LabelConfig, LabelProduct, LabelSettings } from './domain';

export type LabelOutputSnapshot = {
  products: LabelProduct[];
  config: LabelConfig;
  settings: LabelSettings;
  date: Date;
};
const DPI = 300;
const PX_MM = DPI / 25.4;
type Box = { x: number; y: number; w: number; h: number };
type CapturedLabel = {
  w: number;
  h: number;
  background: (Box & { color: string })[];
  text: { x: number; y: number; font: string; color: string; ascent: number; value: string }[];
};
type PdfPage = { bytes: Uint8Array<ArrayBuffer>; w: number; h: number };

function assertSnapshot(snapshot: LabelOutputSnapshot) {
  if (!snapshot.products.length) throw new Error('Виберіть товари для друку.');
  if (snapshot.products.length > MAX_LABEL_COPIES)
    throw new Error('За один раз можна підготувати до 1000 цінників.');
  if (
    snapshot.products.some(
      (product) => !Number.isFinite(product.salePrice) || product.salePrice <= 0,
    )
  )
    throw new Error('Є товари без ціни. Оновіть їх перед друком.');
}
function hiddenHost() {
  const host = document.createElement('div');
  host.style.cssText =
    'position:absolute;left:-10000px;top:0;visibility:hidden;pointer-events:none;zoom:1;transform:none';
  document.body.append(host);
  const root = createRoot(host);
  return {
    host,
    root,
    remove: () => {
      root.unmount();
      host.remove();
    },
  };
}
async function readyFonts(host: HTMLElement) {
  const fonts = new Set(
    [...host.querySelectorAll<HTMLElement>('[data-field]')].map((field) => {
      const style = getComputedStyle(field);
      return `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    }),
  );
  await Promise.all([...fonts].map((font) => document.fonts.load(font, 'Абвґєіїй 0123456789')));
  await document.fonts.ready;
}
function assertFits(host: HTMLElement) {
  if ([...host.querySelectorAll<HTMLElement>('.tk-label')].some(clippedLabel))
    throw new Error('Текст не вміщується на ціннику. Зменште шрифт або приховайте зайві поля.');
}
function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob),
    anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60000);
}
function filename(date: Date, extension: string) {
  return `tsinnyky-${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}.${extension}`;
}

/** Browser print uses physical millimetres; studio zoom never reaches this root. */
export async function printLabels(snapshot: LabelOutputSnapshot): Promise<void> {
  assertSnapshot(snapshot);
  if (document.querySelector('#printArea'))
    throw new Error('Дочекайтеся завершення попереднього друку.');
  const output = hiddenHost();
  try {
    flushSync(() => output.root.render(<PrintPages {...snapshot} />));
    await readyFonts(output.host);
    assertFits(output.host);
    output.host.id = 'printArea';
    output.host.className = 'tk-label-output';
    let cleaned = false;
    const cleanup = () => {
      if (!cleaned) {
        cleaned = true;
        output.remove();
      }
      window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);
    try {
      window.print();
    } catch (error) {
      cleanup();
      throw error;
    }
  } catch (error) {
    if (output.host.isConnected) output.remove();
    throw error;
  }
}

function capture(label: HTMLElement, context: CanvasRenderingContext2D): CapturedLabel {
  const rect = label.getBoundingClientRect(),
    scale = DPI / 96;
  const box = (element: HTMLElement): Box => {
    const bounds = element.getBoundingClientRect();
    return {
      x: (bounds.left - rect.left) * scale,
      y: (bounds.top - rect.top) * scale,
      w: bounds.width * scale,
      h: bounds.height * scale,
    };
  };
  const result: CapturedLabel = {
    w: rect.width * scale,
    h: rect.height * scale,
    background: [],
    text: [],
  };
  const badge = label.querySelector<HTMLElement>('.t-promo');
  if (badge)
    result.background.push({ ...box(badge), color: getComputedStyle(badge).backgroundColor });
  const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.textContent?.trim() || !node.parentElement) continue;
    const style = getComputedStyle(node.parentElement),
      size = Number.parseFloat(style.fontSize) * scale;
    const font = `${style.fontWeight} ${size}px ${style.fontFamily}`;
    context.font = font;
    const ascent = context.measureText('Аg').fontBoundingBoxAscent || size * 0.9;
    let offset = 0,
      current: CapturedLabel['text'][number] | null = null;
    for (const char of node.textContent) {
      const range = document.createRange();
      range.setStart(node, offset);
      offset += char.length;
      range.setEnd(node, offset);
      const bounds = range.getBoundingClientRect();
      if (!bounds.width || !bounds.height) continue;
      const x = (bounds.left - rect.left) * scale,
        y = (bounds.top - rect.top) * scale;
      if (!current || Math.abs(current.y - y) > 1) {
        current = { x, y, font, color: style.color, ascent, value: char };
        result.text.push(current);
      } else current.value += char;
    }
  }
  return result;
}
function draw(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  layout: CapturedLabel,
  config: LabelConfig,
) {
  context.save();
  context.translate(x, y);
  context.beginPath();
  context.rect(0, 0, layout.w, layout.h);
  context.clip();
  for (const background of layout.background) {
    context.fillStyle = background.color;
    context.fillRect(background.x, background.y, background.w, background.h);
  }
  context.textAlign = 'left';
  context.textBaseline = 'alphabetic';
  for (const line of layout.text) {
    context.font = line.font;
    context.fillStyle = line.color;
    context.fillText(line.value, line.x, line.y + line.ascent);
  }
  if (config.border !== 'none') {
    const px = DPI / 96;
    context.lineWidth = px;
    context.strokeStyle = config.border === 'solid' ? '#555' : '#999';
    if (config.border === 'dash') context.setLineDash([px * 3, px * 3]);
    context.strokeRect(px / 2, px / 2, layout.w - px, layout.h - px);
  }
  context.restore();
}
function pdfFromJpegs(pages: PdfPage[]): Blob {
  const encoder = new TextEncoder(),
    parts: Uint8Array<ArrayBuffer>[] = [],
    offsets: number[] = [];
  let length = 0;
  const put = (value: string | Uint8Array<ArrayBuffer>) => {
    const bytes = typeof value === 'string' ? encoder.encode(value) : value;
    parts.push(bytes);
    length += bytes.length;
  };
  const width = 595.28,
    height = 841.89,
    count = pages.length;
  put('%PDF-1.4\n');
  offsets[1] = length;
  put('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  offsets[2] = length;
  put(
    `2 0 obj\n<< /Type /Pages /Count ${count} /Kids [${pages.map((_, i) => `${3 + 3 * i} 0 R`).join(' ')}] >>\nendobj\n`,
  );
  pages.forEach((page, i) => {
    const pageId = 3 + 3 * i,
      contentId = pageId + 1,
      imageId = pageId + 2,
      content = `q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q`;
    offsets[pageId] = length;
    put(
      `${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>\nendobj\n`,
    );
    offsets[contentId] = length;
    put(
      `${contentId} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`,
    );
    offsets[imageId] = length;
    put(
      `${imageId} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${page.w} /Height ${page.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.bytes.length} >>\nstream\n`,
    );
    put(page.bytes);
    put('\nendstream\nendobj\n');
  });
  const total = 3 + 3 * count,
    xref = length;
  put(
    `xref\n0 ${total}\n0000000000 65535 f \n${offsets
      .slice(1)
      .map((offset) => String(offset).padStart(10, '0') + ' 00000 n \n')
      .join('')}`,
  );
  put(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}

/** Raster capture keeps the existing 300 dpi PDF contract and supports every label font. */
export async function exportPdf(snapshot: LabelOutputSnapshot): Promise<void> {
  assertSnapshot(snapshot);
  const output = hiddenHost();
  try {
    const unique = [...new Map(snapshot.products.map((product) => [product.id, product])).values()];
    flushSync(() =>
      output.root.render(
        unique.map((product) => (
          <Label
            key={product.id}
            product={product}
            config={snapshot.config}
            settings={snapshot.settings}
            date={snapshot.date}
          />
        )),
      ),
    );
    await readyFonts(output.host);
    assertFits(output.host);
    const geometry = pageGeometry(snapshot.config),
      canvas = document.createElement('canvas');
    canvas.width = Math.round(geometry.pageWidth * PX_MM);
    canvas.height = Math.round(geometry.pageHeight * PX_MM);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Браузер не підтримує створення PDF.');
    const layouts = new Map(
      [...output.host.querySelectorAll<HTMLElement>('.tk-label')].map((label) => [
        label.dataset.product,
        capture(label, context),
      ]),
    );
    const pages: PdfPage[] = [];
    for (let start = 0; start < snapshot.products.length; start += geometry.perSheet) {
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      snapshot.products.slice(start, start + geometry.perSheet).forEach((product, index) => {
        const layout = layouts.get(product.id);
        if (!layout) throw new Error('Не вдалося сформувати цінник.');
        draw(
          context,
          (geometry.margin + (index % geometry.columns) * geometry.width) * PX_MM,
          (geometry.margin + Math.floor(index / geometry.columns) * geometry.height) * PX_MM,
          layout,
          snapshot.config,
        );
      });
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (value) =>
            value ? resolve(value) : reject(new Error('Не вдалося сформувати сторінку PDF.')),
          'image/jpeg',
          0.92,
        ),
      );
      pages.push({
        bytes: new Uint8Array(await blob.arrayBuffer()),
        w: canvas.width,
        h: canvas.height,
      });
    }
    download(pdfFromJpegs(pages), filename(snapshot.date, 'pdf'));
  } finally {
    output.remove();
  }
}
export function downloadCsv(products: LabelProduct[]): void {
  const quoted = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const rows = [
    ['Назва', 'Категорія', 'Одиниця', 'Ціна, грн', 'Ціна за 100 г, грн', 'Акція'],
    ...products.map((product) => [
      product.name,
      product.category,
      product.unit,
      formatLabelMoney(product.salePrice),
      product.unit === 'кг' ? formatLabelMoney(product.salePrice / 10) : '',
      product.promotion ? 'Так' : 'Ні',
    ]),
  ];
  download(
    new Blob(['\uFEFF' + rows.map((row) => row.map(quoted).join(';')).join('\r\n')], {
      type: 'text/csv;charset=utf-8',
    }),
    filename(new Date(), 'csv'),
  );
}
