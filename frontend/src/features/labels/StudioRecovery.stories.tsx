import { fixtureReferenceDirectory } from '../catalog/referenceDirectoryFixtures';
import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within, waitFor } from 'storybook/test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Studio, initialStudioMemory } from './Studio';
import { adaptLabelProduct } from './domain';
import { studioConfig, studioSettings } from './fixtures';
import {
  catalogPage,
  catalogProducts,
  catalogReferences,
  fixturePricePreview,
} from '../catalog/fixtures';
import type { CatalogApi } from '../catalog/api';
import type { LabelApi } from './api';

function Recovery() {
  const [services] = useState(() => {
    let requests = 0;
    const product = catalogProducts[0]!;
    const workspace = {
      config: studioConfig,
      settings: studioSettings,
      revision: 'synthetic-revision',
      csrf: 'synthetic-csrf',
      canEdit: true,
      warnings: [],
    };
    return {
      client: new QueryClient(),
      memory: {
        ...initialStudioMemory(),
        selection: { [product.id]: 3 },
        records: { [product.id]: adaptLabelProduct(product, Number(product.salePrice)) },
      },
      labels: {
        workspace: async () => workspace,
        save: async () => workspace,
        prepare: async () => {
          throw new Error('Друк не використовується в цьому сценарії.');
        },
      } satisfies LabelApi,
      catalog: {
        session: async () => ({ role: 'owner', csrf: 'synthetic' }),
        list: async () => {
          requests++;
          await new Promise((resolve) => setTimeout(resolve, 30));
          if (requests <= 2) throw new Error('Товари тимчасово недоступні.');
          return catalogPage;
        },
        product: async () => product,
        visibility: async (product, hidden) => ({ ...product, hidden }),
        previewPrice: fixturePricePreview,
        save: async () => product,
        remove: async () => true,
        referenceDirectory: fixtureReferenceDirectory(async () => catalogReferences),
        references: async () => catalogReferences,
        createReference: async () => {
          throw new Error('Довідники не використовуються в цьому сценарії.');
        },
      } satisfies CatalogApi,
    };
  });
  return (
    <QueryClientProvider client={services.client}>
      <Studio
        api={services.labels}
        catalog={services.catalog}
        initialMemory={services.memory}
        onMemory={() => {}}
        onDirty={() => {}}
        onChanged={() => {}}
      />
    </QueryClientProvider>
  );
}

const meta = {
  title: 'Цінники/Відновлення запиту',
  component: Recovery,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof Recovery>;
export default meta;
type Story = StoryObj<typeof meta>;
export const RetryPreservesDraftAndSelection: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('alert')).toHaveTextContent('Товари тимчасово недоступні');
    const size = canvas.getByLabelText('Розмір, pt');
    await userEvent.clear(size);
    await userEvent.type(size, '18');
    await userEvent.tab();
    await userEvent.click(canvas.getByRole('button', { name: 'Завантажити товари повторно' }));
    await waitFor(() => expect(canvas.queryByRole('alert')).not.toBeInTheDocument());
    await expect(size).toHaveValue('18');
    await expect(canvas.getByText('Є незбережені зміни')).toBeVisible();
    await userEvent.click(canvas.getByRole('tab', { name: /Товари для друку/ }));
    await expect(canvas.getByRole('checkbox', { name: catalogProducts[0]!.name })).toBeChecked();
    await expect(canvas.getByLabelText(`Копій: ${catalogProducts[0]!.name}`)).toHaveValue('3');
  },
};
