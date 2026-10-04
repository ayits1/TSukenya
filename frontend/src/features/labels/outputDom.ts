import { createRoot } from 'react-dom/client';
import { clippedLabel } from './domain';
import type { LabelOutputOptions } from './output';

export function hiddenHost() {
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
export function assertActive(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Підготовку скасовано.', 'AbortError');
}
/** Font loading and canvas encoding continue in the browser, but never retain the output root. */
export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
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
function fontNames(host: HTMLElement) {
  return new Set(
    [...host.querySelectorAll<HTMLElement>('[data-field]')].map((field) => {
      const style = getComputedStyle(field);
      return `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    }),
  );
}
export async function loadFonts(
  host: HTMLElement,
  options: LabelOutputOptions,
  known = new Set<string>(),
) {
  const fonts = [...fontNames(host)].filter((font) => !known.has(font));
  await abortable(
    Promise.all(fonts.map((font) => document.fonts.load(font, 'Абвґєіїй 0123456789'))),
    options.signal,
  );
  await abortable(document.fonts.ready, options.signal);
  for (const font of fonts) known.add(font);
}
export function assertFits(host: HTMLElement) {
  if ([...host.querySelectorAll<HTMLElement>('.tk-label')].some(clippedLabel))
    throw new Error('Текст не вміщується на ціннику. Зменште шрифт або приховайте зайві поля.');
}
