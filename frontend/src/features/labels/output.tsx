import { flushSync } from 'react-dom';
import { csv } from '../../shared/csv';
import { createRoot } from 'react-dom/client';
import { Label, PrintPages } from './Label';
import {
  clippedLabel,
  formatLabelMoney,
  formatPer100,
  hasPromotionPrice,
  MAX_LABEL_COPIES,
  pageGeometry,
} from './domain';
import type { LabelConfig, LabelProduct, LabelSettings } from './domain';

export type LabelOutputSnapshot = {
  products: LabelProduct[];
  config: LabelConfig;
  settings: LabelSettings;
  date: Date;
};
export type LabelOutputProgress = {
  stage: 'fonts' | 'capture' | 'pages' | 'download' | 'print';
  completed: number;
  total: number;
};
export type LabelOutputOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: LabelOutputProgress) => void;
};
const DPI = 300;
const PX_MM = DPI / 25.4;
type Box = { x: number; y: number; w: number; h: number };
type CapturedLabel = {
  w: number;
  h: number;
  background: (Box & { color: string })[];
  text: {
    x: number;
    y: number;
    font: string;
    color: string;
    ascent: number;
    value: string;
    strike: boolean;
    strikeOffset: number;
    strikeWidth: number;
  }[];
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
  if (snapshot.products.some((product) => product.promotion && !hasPromotionPrice(product)))
    throw new Error('Задайте окрему акційну ціну або вимкніть акцію перед друком.');
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
function assertActive(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Підготовку скасовано.', 'AbortError');
}
/** Font loading and canvas encoding continue in the browser, but never retain the output root. */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  assertActive(signal);
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(new DOMException('Підготовку скасовано.', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}
function progress(options: LabelOutputOptions, value: LabelOutputProgress) {
  assertActive(options.signal);
  options.onProgress?.(value);
  assertActive(options.signal);
}
async function readyFonts(host: HTMLElement, options: LabelOutputOptions) {
  progress(options, { stage: 'fonts', completed: 0, total: 1 });
  const fonts = new Set(
    [...host.querySelectorAll<HTMLElement>('[data-field]')].map((field) => {
      const style = getComputedStyle(field);
      return `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    }),
  );
  await abortable(
    Promise.all([...fonts].map((font) => document.fonts.load(font, 'Абвґєіїй 0123456789'))),
    options.signal,
  );
  await abortable(document.fonts.ready, options.signal);
  progress(options, { stage: 'fonts', completed: 1, total: 1 });
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
export async function printLabels(
  snapshot: LabelOutputSnapshot,
  options: LabelOutputOptions = {},
): Promise<void> {
  assertActive(options.signal);
  assertSnapshot(snapshot);
  if (document.querySelector('#printArea'))
    throw new Error('Дочекайтеся завершення попереднього друку.');
  const output = hiddenHost();
  try {
    flushSync(() => output.root.render(<PrintPages {...snapshot} />));
    await readyFonts(output.host, options);
    assertFits(output.host);
    progress(options, { stage: 'print', completed: 0, total: 1 });
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
      assertActive(options.signal);
      window.print();
      options.onProgress?.({ stage: 'print', completed: 1, total: 1 });
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
        current = {
          x,
          y,
          font,
          color: style.color,
          ascent,
          value: char,
          strike: style.textDecorationLine.includes('line-through'),
          strikeOffset: size * 0.3,
          strikeWidth: Number.parseFloat(style.textDecorationThickness) * scale || scale,
        };
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
    if (line.strike) {
      context.beginPath();
      context.strokeStyle = line.color;
      context.lineWidth = line.strikeWidth;
      const y = line.y + line.ascent - line.strikeOffset;
      context.moveTo(line.x, y);
      context.lineTo(line.x + context.measureText(line.value).width, y);
      context.stroke();
    }
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
export async function exportPdf(
  snapshot: LabelOutputSnapshot,
  options: LabelOutputOptions = {},
): Promise<void> {
  assertActive(options.signal);
  assertSnapshot(snapshot);
  const output = hiddenHost();
  let canvas: HTMLCanvasElement | undefined;
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
    await readyFonts(output.host, options);
    assertFits(output.host);
    const geometry = pageGeometry(snapshot.config);
    canvas = document.createElement('canvas');
    canvas.width = Math.round(geometry.pageWidth * PX_MM);
    canvas.height = Math.round(geometry.pageHeight * PX_MM);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Браузер не підтримує створення PDF.');
    const labels = [...output.host.querySelectorAll<HTMLElement>('.tk-label')];
    const layouts = new Map<string | undefined, CapturedLabel>();
    progress(options, { stage: 'capture', completed: 0, total: labels.length });
    let captured = 0;
    while (captured < labels.length) {
      // Keep the browser responsive for batches of distinct products without changing capture.
      await abortable(
        new Promise<void>((resolve) => window.setTimeout(resolve, 0)),
        options.signal,
      );
      const started = performance.now();
      do {
        assertActive(options.signal);
        const label = labels[captured]!;
        layouts.set(label.dataset.product, capture(label, context));
        captured++;
      } while (captured < labels.length && performance.now() - started < 16);
      progress(options, { stage: 'capture', completed: captured, total: labels.length });
    }
    const pages: PdfPage[] = [];
    const total = Math.ceil(snapshot.products.length / geometry.perSheet);
    progress(options, { stage: 'pages', completed: 0, total });
    for (let start = 0; start < snapshot.products.length; start += geometry.perSheet) {
      // A task boundary lets the cancel control respond even when encoding finishes quickly.
      await abortable(
        new Promise<void>((resolve) => window.setTimeout(resolve, 0)),
        options.signal,
      );
      assertActive(options.signal);
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
      const blob = await abortable(
        new Promise<Blob>((resolve, reject) =>
          canvas!.toBlob(
            (value) =>
              value ? resolve(value) : reject(new Error('Не вдалося сформувати сторінку PDF.')),
            'image/jpeg',
            0.92,
          ),
        ),
        options.signal,
      );
      pages.push({
        bytes: new Uint8Array(await abortable(blob.arrayBuffer(), options.signal)),
        w: canvas.width,
        h: canvas.height,
      });
      progress(options, { stage: 'pages', completed: pages.length, total });
    }
    const pdf = pdfFromJpegs(pages);
    progress(options, { stage: 'download', completed: 0, total: 1 });
    download(pdf, filename(snapshot.date, 'pdf'));
    options.onProgress?.({ stage: 'download', completed: 1, total: 1 });
  } finally {
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
    output.remove();
  }
}
export function downloadCsv(products: LabelProduct[]): void {
  const headers = [
    'Назва',
    'Категорія',
    'Одиниця',
    'Звичайна ціна, грн',
    'Акційна ціна, грн',
    'Діюча ціна, грн',
    'Ціна за 100 г, грн',
    'Акція',
  ];
  const rows = products.map((product) => [
    product.name,
    product.category,
    product.unit,
    formatLabelMoney(product.regularPrice ?? product.salePrice),
    hasPromotionPrice(product) ? formatLabelMoney(product.salePrice) : '',
    formatLabelMoney(product.salePrice),
    product.unit === 'кг' ? formatPer100(product.salePrice) : '',
    product.promotion ? 'Так' : 'Ні',
  ]);
  download(
    new Blob(
      [
        csv.serialize(
          headers.map((label, index) => ({
            label: String(label),
            kind: index >= 3 && index <= 6 ? 'number' : 'text',
          })),
          rows,
          { reversible: true },
        ),
      ],
      {
        type: 'text/csv;charset=utf-8',
      },
    ),
    filename(new Date(), 'csv'),
  );
}
