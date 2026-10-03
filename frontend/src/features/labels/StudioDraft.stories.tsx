import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fireEvent, spyOn, userEvent, waitFor, within } from 'storybook/test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '../../shared/api/client';
import { Button } from '../../shared/ui/Button';
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

/** Real Studio container with synthetic services; later layout reloads wait for the story. */
function Draft() {
  const [services] = useState(() => {
    let opened = false;
    let release = () => {};
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
      client: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      release: () => release(),
      memory: {
        ...initialStudioMemory(),
        preview: adaptLabelProduct(product, Number(product.salePrice)),
      },
      labels: {
        workspace: async () => {
          if (!opened) {
            opened = true;
            return workspace;
          }
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return { ...workspace, revision: 'synthetic-reloaded' };
        },
        save: async () => {
          throw new ApiError(409, 'Макет змінено в іншому вікні. Завантажте актуальний макет.');
        },
        prepare: async () => {
          throw new Error('Друк не використовується в цьому сценарії.');
        },
      } satisfies LabelApi,
      catalog: {
        session: async () => ({ role: 'owner', csrf: 'synthetic' }),
        list: async () => catalogPage,
        product: async () => product,
        previewPrice: fixturePricePreview,
        save: async () => product,
        remove: async () => true,
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
      <Button onPress={services.release}>Відповісти на завантаження макета</Button>
    </QueryClientProvider>
  );
}

const meta = {
  title: 'Цінники/Чернетка макета',
  component: Draft,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof Draft>;
export default meta;
type Story = StoryObj<typeof meta>;
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

export const LateReloadKeepsNewerEdits: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const confirm = spyOn(window, 'confirm').mockReturnValue(true);
    try {
      const size = await canvas.findByLabelText('Розмір, pt');
      await expect(size).toHaveValue('13');
      await userEvent.clear(size);
      await userEvent.type(size, '18');
      await userEvent.tab();
      await userEvent.click(canvas.getByRole('button', { name: 'Зберегти макет' }));
      const reload = await canvas.findByRole('button', { name: 'Завантажити збережений макет' });
      await userEvent.click(reload);
      await expect(confirm).toHaveBeenCalledOnce();
      await expect(reload).toBeDisabled();
      // The owner keeps editing while the saved layout is still on its way.
      await userEvent.clear(size);
      await userEvent.type(size, '20');
      await userEvent.tab();
      await userEvent.click(
        canvas.getByRole('button', { name: 'Відповісти на завантаження макета' }),
      );
      await settle();
      await expect(size).toHaveValue('20');
      await expect(canvas.getByRole('button', { name: 'Скасувати зміну' })).toBeEnabled();
      await expect(canvas.getByText('Макет змінили в іншому вікні')).toBeVisible();
      // A reload that nothing overtakes still replaces the draft and its history.
      await expect(reload).toBeEnabled();
      await userEvent.click(reload);
      await userEvent.click(
        canvas.getByRole('button', { name: 'Відповісти на завантаження макета' }),
      );
      await waitFor(() => expect(size).toHaveValue('13'));
      await expect(canvas.getByText('Макет збережено')).toBeVisible();
      await expect(canvas.getByRole('button', { name: 'Скасувати зміну' })).toBeDisabled();
    } finally {
      confirm.mockRestore();
    }
  },
};

export const ColourDragIsOneUndoStep: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const colour = await canvas.findByLabelText('Колір');
    const undo = canvas.getByRole('button', { name: 'Скасувати зміну' });
    const original = (colour as HTMLInputElement).value;
    // A drag in the native picker reports every intermediate colour; more than the 40-step cap.
    for (let step = 1; step <= 45; step++)
      fireEvent.input(colour, {
        target: { value: `#${(step * 5).toString(16).padStart(2, '0')}0000` },
      });
    await expect(colour).toHaveValue('#e10000');
    await expect(canvas.getByText('Є незбережені зміни')).toBeVisible();
    await userEvent.click(undo);
    await expect(colour).toHaveValue(original);
    await expect(undo).toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: 'Повторити зміну' }));
    await expect(colour).toHaveValue('#e10000');
    // Another property is a separate step.
    const size = canvas.getByLabelText('Розмір, pt');
    await userEvent.clear(size);
    await userEvent.type(size, '15');
    await userEvent.tab();
    await userEvent.click(undo);
    await expect(size).toHaveValue('13');
    await expect(colour).toHaveValue('#e10000');
  },
};

export const CancelledPresetLeavesNoChoice: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const page = within(document.body);
    const confirm = spyOn(window, 'confirm').mockReturnValue(false);
    try {
      await userEvent.click(await canvas.findByText('Параметри шаблону та магазину'));
      const trigger = canvas.getByRole('button', { name: /Готове оформлення/ });
      await userEvent.click(trigger);
      await userEvent.click(await page.findByRole('option', { name: 'Тільки головне' }));
      await expect(confirm).toHaveBeenCalledOnce();
      await expect(trigger).toHaveTextContent('Оберіть варіант');
      await expect(canvas.getByText('Макет збережено')).toBeVisible();
      // Choosing the same preset again asks again and can now be applied.
      confirm.mockReturnValue(true);
      await userEvent.click(trigger);
      await userEvent.click(await page.findByRole('option', { name: 'Тільки головне' }));
      await expect(confirm).toHaveBeenCalledTimes(2);
      await expect(canvas.getByText('Є незбережені зміни')).toBeVisible();
      await expect(trigger).toHaveTextContent('Оберіть варіант');
    } finally {
      confirm.mockRestore();
    }
  },
};
