import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor } from 'storybook/test';
import { pageGeometry, MAX_LABEL_COPIES } from './domain';
import { studioConfig, studioProducts, studioSettings } from './fixtures';
import { exportPdf, printLabels } from './output';
import type { LabelOutputProgress, LabelOutputSnapshot } from './output';

function OutputChecks() {
  return <p>Перевірка підготовки цінників: скасування, очищення та фізичні розміри PDF.</p>;
}
const meta = {
  title: 'Цінники/Підготовка друку та PDF',
  component: OutputChecks,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof OutputChecks>;
export default meta;
type Story = StoryObj<typeof meta>;
const snapshot: LabelOutputSnapshot = {
  products: [studioProducts[0]!],
  config: studioConfig,
  settings: studioSettings,
  date: new Date('2026-10-01T12:00:00Z'),
};
function cleanOutput() {
  expect(document.querySelector('#printArea')).toBeNull();
  expect(document.querySelector('.tk-label')).toBeNull();
}
async function interceptDownloads(run: (blobs: Blob[]) => Promise<void>) {
  const originalCreate = URL.createObjectURL;
  const originalClick = HTMLAnchorElement.prototype.click;
  const blobs: Blob[] = [];
  let clicks = 0;
  URL.createObjectURL = (value) => {
    if (!(value instanceof Blob)) throw new Error('Очікується файл Blob.');
    blobs.push(value);
    return 'blob:synthetic-label-output';
  };
  HTMLAnchorElement.prototype.click = function () {
    clicks++;
  };
  try {
    await run(blobs);
    expect(clicks).toBe(blobs.length);
  } finally {
    URL.createObjectURL = originalCreate;
    HTMLAnchorElement.prototype.click = originalClick;
  }
}
function outcome(promise: Promise<void>) {
  return promise.then(
    () => 'completed',
    (error: unknown) => error,
  );
}

export const CancelFontWaitAndRetry: Story = {
  play: async () => {
    await interceptDownloads(async (blobs) => {
      for (const prepare of [exportPdf, printLabels]) {
        const originalLoad = document.fonts.load;
        const controller = new AbortController();
        let loads = 0;
        let resolveFonts!: (fonts: FontFace[]) => void;
        const pending = new Promise<FontFace[]>((resolve) => {
          resolveFonts = resolve;
        });
        document.fonts.load = () => {
          loads++;
          return pending;
        };
        try {
          const result = outcome(prepare(snapshot, { signal: controller.signal }));
          await waitFor(() => expect(loads).toBeGreaterThan(0));
          controller.abort();
          expect(await result).toMatchObject({ name: 'AbortError' });
          cleanOutput();
          expect(blobs).toHaveLength(0);
          resolveFonts([]);
          await Promise.resolve();
          cleanOutput();
        } finally {
          document.fonts.load = originalLoad;
          resolveFonts([]);
        }
      }
      await exportPdf(snapshot);
      expect(blobs).toHaveLength(1);
      cleanOutput();
      const originalPrint = window.print;
      let prints = 0;
      window.print = () => {
        prints++;
        expect(document.querySelector('#printArea .tk-label')).not.toBeNull();
      };
      try {
        await printLabels(snapshot);
        expect(prints).toBe(1);
        window.dispatchEvent(new Event('afterprint'));
        cleanOutput();
      } finally {
        window.print = originalPrint;
        window.dispatchEvent(new Event('afterprint'));
      }
    });
  },
};

export const CancelEncodingAndRetry: Story = {
  play: async () => {
    await interceptDownloads(async (blobs) => {
      const originalEncode = HTMLCanvasElement.prototype.toBlob;
      let encoding: { canvas: HTMLCanvasElement; callback: BlobCallback } | undefined;
      HTMLCanvasElement.prototype.toBlob = function (callback) {
        encoding = { canvas: this, callback };
      };
      const controller = new AbortController();
      try {
        const result = outcome(exportPdf(snapshot, { signal: controller.signal }));
        await waitFor(() => expect(encoding).toBeDefined());
        expect(encoding!.canvas.width).toBe(Math.round((210 * 300) / 25.4));
        expect(encoding!.canvas.height).toBe(Math.round((297 * 300) / 25.4));
        controller.abort();
        expect(await result).toMatchObject({ name: 'AbortError' });
        expect(encoding!.canvas.width).toBe(0);
        expect(encoding!.canvas.height).toBe(0);
        cleanOutput();
        encoding!.callback(new Blob(['late encoder result'], { type: 'image/jpeg' }));
        await Promise.resolve();
        expect(blobs).toHaveLength(0);
        cleanOutput();
      } finally {
        HTMLCanvasElement.prototype.toBlob = originalEncode;
      }
      await exportPdf(snapshot);
      expect(blobs).toHaveLength(1);
      cleanOutput();
    });
  },
};

export const CancelBetweenPagesAndBeforeDownload: Story = {
  play: async () => {
    await interceptDownloads(async (blobs) => {
      const geometry = pageGeometry(snapshot.config);
      const pages = {
        ...snapshot,
        products: Array.from({ length: geometry.perSheet + 1 }, () => snapshot.products[0]!),
      };
      for (const stage of ['pages', 'download'] as const) {
        const controller = new AbortController();
        const events: LabelOutputProgress[] = [];
        const result = await outcome(
          exportPdf(pages, {
            signal: controller.signal,
            onProgress: (value) => {
              events.push(value);
              if (
                (stage === 'pages' && value.stage === 'pages' && value.completed === 1) ||
                (stage === 'download' && value.stage === 'download' && value.completed === 0)
              )
                controller.abort();
            },
          }),
        );
        expect(result).toMatchObject({ name: 'AbortError' });
        expect(events).toContainEqual({ stage: 'pages', completed: 1, total: 2 });
        expect(blobs).toHaveLength(0);
        cleanOutput();
      }
      const originalPrint = window.print;
      let prints = 0;
      window.print = () => {
        prints++;
      };
      const controller = new AbortController();
      try {
        expect(
          await outcome(
            printLabels(snapshot, {
              signal: controller.signal,
              onProgress: (value) => {
                if (value.stage === 'print') controller.abort();
              },
            }),
          ),
        ).toMatchObject({ name: 'AbortError' });
        expect(prints).toBe(0);
        cleanOutput();
      } finally {
        window.print = originalPrint;
      }
    });
  },
};

export const MaximumCopiesAt300Dpi: Story = {
  play: async ({ canvasElement }) => {
    await interceptDownloads(async (blobs) => {
      const events: LabelOutputProgress[] = [];
      const copies = {
        ...snapshot,
        config: { ...snapshot.config, size: 'l' as const },
        products: Array.from({ length: MAX_LABEL_COPIES }, () => snapshot.products[0]!),
      };
      const total = Math.ceil(MAX_LABEL_COPIES / pageGeometry(copies.config).perSheet);
      const started = performance.now();
      await exportPdf(copies, { onProgress: (value) => events.push(value) });
      const elapsed = Math.round(performance.now() - started);
      expect(blobs).toHaveLength(1);
      const blob = blobs[0]!;
      expect(blob.type).toBe('application/pdf');
      expect(blob.size).toBeGreaterThan(1000);
      const pdf = await blob.text();
      expect(pdf).toContain(`/Type /Pages /Count ${total} `);
      expect(pdf.match(/\/MediaBox \[0 0 595\.28 841\.89\]/g)).toHaveLength(total);
      expect(pdf.match(/\/Width 2480 \/Height 3508/g)).toHaveLength(total);
      expect(events.filter((value) => value.stage === 'pages')).toEqual(
        Array.from({ length: total + 1 }, (_, completed) => ({ stage: 'pages', completed, total })),
      );
      expect(events.at(-1)).toEqual({ stage: 'download', completed: 1, total: 1 });
      cleanOutput();
      const proof = `${MAX_LABEL_COPIES} цінників; ${total} аркушів A4, 300 dpi; ${blob.size} байтів; ${elapsed} мс.`;
      canvasElement.querySelector('p')!.textContent = proof;
      console.info(proof);
    });
  },
};

export const CancelMaximumDistinctCapture: Story = {
  play: async () => {
    await interceptDownloads(async (blobs) => {
      const controller = new AbortController();
      const events: LabelOutputProgress[] = [];
      let timerHandled = false;
      const result = await outcome(
        exportPdf(
          {
            ...snapshot,
            products: Array.from({ length: MAX_LABEL_COPIES }, (_, index) => ({
              ...snapshot.products[0]!,
              id: `distinct-${index}`,
            })),
          },
          {
            signal: controller.signal,
            onProgress: (value) => {
              events.push(value);
              if (value.stage === 'capture' && value.completed > 0 && !timerHandled) {
                window.setTimeout(() => {
                  timerHandled = true;
                  controller.abort();
                }, 0);
              }
            },
          },
        ),
      );
      expect(result).toMatchObject({ name: 'AbortError' });
      expect(timerHandled).toBe(true);
      expect(events.some((value) => value.stage === 'capture' && value.completed > 0)).toBe(true);
      expect(events).toContainEqual({ stage: 'capture', completed: 0, total: MAX_LABEL_COPIES });
      expect(
        events.some((value) => value.stage === 'capture' && value.completed === MAX_LABEL_COPIES),
      ).toBe(false);
      expect(blobs).toHaveLength(0);
      cleanOutput();
      await exportPdf(snapshot);
      expect(blobs).toHaveLength(1);
      cleanOutput();
    });
  },
};
