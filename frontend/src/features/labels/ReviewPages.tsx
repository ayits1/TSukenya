import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../shared/ui/Button';
import { ComboBox } from '../../shared/ui/ComboBox';
import { PrintPages } from './Label';
import { pageGeometry } from './domain';
import { measureLabels } from './measureLabels';
import type { LabelConfig, LabelProduct, LabelSettings } from './domain';

export function ReviewPages({
  snapshot,
  products,
  config,
  settings,
  date,
  onMeasured,
  isDisabled = false,
}: {
  snapshot: string;
  products: LabelProduct[];
  config: LabelConfig;
  settings: LabelSettings;
  date: Date;
  onMeasured: (snapshot: string, clipped: string[]) => void;
  isDisabled?: boolean;
}) {
  const viewport = useRef<HTMLDivElement>(null),
    status = useRef<HTMLParagraphElement>(null);
  const [zoom, setZoom] = useState(1),
    [page, setPage] = useState(0),
    [retry, setRetry] = useState(0);
  const [check, setCheck] = useState<{ snapshot: string; error?: string } | null>(null);
  const dateStamp = date.getTime();
  const geometry = pageGeometry(config),
    pages = Math.max(1, Math.ceil(products.length / geometry.perSheet));
  const shown = Math.min(page, pages - 1);
  const choices = useMemo(
    () =>
      Array.from({ length: pages }, (_, index) => ({
        id: String(index),
        label: `Аркуш ${index + 1}`,
      })),
    [pages],
  );
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setZoom(Math.min(1, entry.contentRect.width / ((210 * 96) / 25.4)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void measureLabels(
      { products, config, settings, date: new Date(dateStamp) },
      controller.signal,
    ).then(
      (clipped) => {
        if (!controller.signal.aborted) {
          onMeasured(snapshot, clipped);
          setCheck({ snapshot });
        }
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setCheck({
            snapshot,
            error: error instanceof Error ? error.message : 'Не вдалося перевірити макет.',
          });
      },
    );
    return () => controller.abort();
  }, [snapshot, products, config, settings, dateStamp, onMeasured, retry]);
  const go = (next: number, focus = false) => {
    if (isDisabled || !Number.isInteger(next) || next < 0 || next >= pages) return;
    setPage(next);
    if (focus) requestAnimationFrame(() => status.current?.focus({ preventScroll: true }));
  };
  return (
    <>
      <div className="tk-studio-proof-navigation" aria-label="Навігація переддрукового перегляду">
        <ComboBox
          label="Аркуш для перегляду"
          options={choices}
          selectedKey={String(shown)}
          onSelectionChange={(key) => go(Number(key))}
          isDisabled={isDisabled}
        />
        <div className="tk-studio-proof-buttons">
          <Button onPress={() => go(shown - 1, true)} isDisabled={isDisabled || shown === 0}>
            Попередній аркуш
          </Button>
          <Button onPress={() => go(shown + 1, true)} isDisabled={isDisabled || shown + 1 >= pages}>
            Наступний аркуш
          </Button>
        </div>
      </div>
      <p ref={status} role="status" aria-live="polite" tabIndex={-1}>
        Аркуш {shown + 1} із {pages} · усі {products.length} цінників увійдуть у PDF та друк.
      </p>
      {check?.snapshot !== snapshot ? (
        <p role="status">Перевіряємо всі товари на обрізання тексту…</p>
      ) : check.error ? (
        <div role="alert">
          <p>{check.error}</p>
          <Button
            onPress={() => {
              setCheck(null);
              setRetry((value) => value + 1);
            }}
            isDisabled={isDisabled}
          >
            Повторити перевірку макета
          </Button>
        </div>
      ) : null}
      <div className="tk-studio-proof-viewport" ref={viewport}>
        <div
          className="tk-studio-proof-pages"
          style={{ zoom }}
          aria-label={`Аркуш ${shown + 1} із ${pages}`}
        >
          <PrintPages
            products={products.slice(shown * geometry.perSheet, (shown + 1) * geometry.perSheet)}
            config={config}
            settings={settings}
            date={date}
            pageOffset={shown}
          />
        </div>
      </div>
    </>
  );
}
