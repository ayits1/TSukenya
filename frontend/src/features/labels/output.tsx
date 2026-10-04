import { flushSync } from 'react-dom';
import { csv } from '../../shared/csv';
import { Label, PrintPages } from './Label';
import { RasterPdf } from './rasterPdf';
import { hiddenHost, assertActive, abortable, loadFonts, assertFits } from './outputDom';
import {
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
const CAPTURE_CACHE_LIMIT = 32;

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
function progress(options: LabelOutputOptions, value: LabelOutputProgress) {
  assertActive(options.signal);
  options.onProgress?.(value);
  assertActive(options.signal);
}
async function readyFonts(host: HTMLElement, options: LabelOutputOptions) {
  progress(options, { stage: 'fonts', completed: 0, total: 1 });
  await loadFonts(host, options);
  progress(options, { stage: 'fonts', completed: 1, total: 1 });
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
/** Raster capture keeps the existing 300 dpi PDF contract and supports every label font. */
export async function exportPdf(
  snapshot: LabelOutputSnapshot,
  options: LabelOutputOptions = {},
): Promise<void> {
  assertActive(options.signal);
  assertSnapshot(snapshot);
  const output = hiddenHost();
  let canvas: HTMLCanvasElement | undefined;
  let pdf: RasterPdf | undefined;
  try {
    const geometry = pageGeometry(snapshot.config);
    const total = Math.ceil(snapshot.products.length / geometry.perSheet);
    const uniqueCount = new Set(snapshot.products.map((product) => product.id)).size;
    const seen = new Set<string>();
    const layouts = new Map<string, CapturedLabel>();
    const knownFonts = new Set<string>();
    pdf = new RasterPdf(total);
    canvas = document.createElement('canvas');
    canvas.width = Math.round(geometry.pageWidth * PX_MM);
    canvas.height = Math.round(geometry.pageHeight * PX_MM);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Браузер не підтримує створення PDF.');
    progress(options, { stage: 'capture', completed: 0, total: uniqueCount });
    let pages = 0;
    for (let start = 0; start < snapshot.products.length; start += geometry.perSheet) {
      await abortable(
        new Promise<void>((resolve) => window.setTimeout(resolve, 0)),
        options.signal,
      );
      const products = snapshot.products.slice(start, start + geometry.perSheet);
      const unique = [...new Map(products.map((product) => [product.id, product])).values()];
      // Only this physical A4 is mounted: <=21 DOM labels, not every distinct SKU in the job.
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
      if (start === 0) progress(options, { stage: 'fonts', completed: 0, total: 1 });
      await loadFonts(output.host, options, knownFonts);
      if (start === 0) progress(options, { stage: 'fonts', completed: 1, total: 1 });
      assertFits(output.host);
      const labels = [...output.host.querySelectorAll<HTMLElement>('.tk-label')];
      let captured = 0;
      while (captured < labels.length) {
        await abortable(
          new Promise<void>((resolve) => window.setTimeout(resolve, 0)),
          options.signal,
        );
        const started = performance.now();
        do {
          assertActive(options.signal);
          const label = labels[captured++]!;
          const id = label.dataset.product!;
          const layout = layouts.get(id) || capture(label, context);
          // Touch both reused and new entries; one whole A4 fits within the bounded LRU.
          layouts.delete(id);
          layouts.set(id, layout);
          if (layouts.size > CAPTURE_CACHE_LIMIT) layouts.delete(layouts.keys().next().value!);
          seen.add(id);
        } while (captured < labels.length && performance.now() - started < 16);
        progress(options, { stage: 'capture', completed: seen.size, total: uniqueCount });
      }
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      products.forEach((product, index) => {
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
      progress(options, { stage: 'pages', completed: pages, total });
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
      pdf.append(blob, canvas.width, canvas.height);
      pages++;
    }
    progress(options, { stage: 'pages', completed: pages, total });
    const result = pdf.finish();
    progress(options, { stage: 'download', completed: 0, total: 1 });
    download(result, filename(snapshot.date, 'pdf'));
    options.onProgress?.({ stage: 'download', completed: 1, total: 1 });
  } finally {
    pdf?.dispose();
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
