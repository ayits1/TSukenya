import { flushSync } from 'react-dom';
import { Label } from './Label';
import { clippedLabel, pageGeometry } from './domain';
import { hiddenHost, abortable, assertActive, loadFonts } from './outputDom';
import type { LabelOutputSnapshot } from './output';

/** Validate every SKU at physical scale independently from the one visible preview page. */
export async function measureLabels(snapshot: LabelOutputSnapshot, signal: AbortSignal) {
  const unique = [...new Map(snapshot.products.map((product) => [product.id, product])).values()];
  const batchSize = pageGeometry(snapshot.config).perSheet;
  const output = hiddenHost();
  output.host.className = 'tk-label-validation';
  const knownFonts = new Set<string>();
  const clipped = new Set<string>();
  try {
    for (let index = 0; index < unique.length; index += batchSize) {
      await abortable(new Promise<void>((resolve) => window.setTimeout(resolve, 0)), signal);
      assertActive(signal);
      flushSync(() =>
        output.root.render(
          unique
            .slice(index, index + batchSize)
            .map((product) => (
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
      await loadFonts(output.host, { signal }, knownFonts);
      for (const label of output.host.querySelectorAll<HTMLElement>('.tk-label'))
        if (clippedLabel(label)) clipped.add(label.dataset.product!);
    }
    assertActive(signal);
    return [...clipped];
  } finally {
    output.remove();
  }
}
