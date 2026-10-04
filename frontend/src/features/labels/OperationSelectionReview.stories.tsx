import { StrictMode, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { OperationSelectionReview } from './OperationSelectionReview';
import {
  fixtureContext,
  fixtureOperation,
  fixtureResult,
  fixtureReview,
} from './operationSelection.fixtures';
import type { SelectionApi } from './operationSelection';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PricingContext } from '../promotions/PricingContext';
import type { PromotionApi } from '../promotions/api';
import { Button } from '../../shared/ui/Button';
function Example({ fail = false }: { fail?: boolean }) {
  const [applied, setApplied] = useState(''),
    [cancelled, setCancelled] = useState(false);
  const [api] = useState<SelectionApi>(() => ({
    result: async () => fixtureResult(),
    preview: async () => {
      if (fail) throw Error('503 — повторіть поточний перегляд');
      return fixtureReview();
    },
  }));
  return (
    <StrictMode>
      <div className="tk-root">
        {applied ? (
          <p role="status">{applied}</p>
        ) : cancelled ? (
          <p>Вибір і чернетка збережені</p>
        ) : (
          <OperationSelectionReview
            operation={fixtureOperation}
            selection={{ 'sample-1': 3, prior: 2 }}
            context={fixtureContext}
            promotions={{ context: async () => fixtureContext }}
            api={api}
            isDisabled={false}
            onCancel={() => setCancelled(true)}
            onApply={(selection) => setApplied(JSON.stringify(selection))}
          />
        )}
      </div>
    </StrictMode>
  );
}
const meta = { title: 'Labels/Operation selection', component: Example } satisfies Meta<
  typeof Example
>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ExplicitAdd: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await c.findByText('У групі 1.', { exact: false });
    await userEvent.click(c.getByRole('button', { name: 'Вибрати цю сторінку (1)' }));
    await userEvent.click(c.getByRole('button', { name: 'Прочитати поточні ціни вибраних' }));
    await c.findByRole('button', { name: 'Додати до вибраних' });
    await userEvent.click(c.getByRole('button', { name: 'Додати до вибраних' }));
    await waitFor(() => expect(c.getByRole('status')).toHaveTextContent('"sample-1":3,"prior":2'));
  },
};
export const ReadFailureAndKeyboardCancel: Story = {
  args: { fail: true },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await c.findByRole('button', { name: 'Вибрати цю сторінку (1)' });
    await userEvent.click(c.getByRole('button', { name: 'Вибрати цю сторінку (1)' }));
    await userEvent.click(c.getByRole('button', { name: 'Прочитати поточні ціни вибраних' }));
    await c.findByRole('alert');
    const cancel = c.getByRole('button', { name: 'Скасувати передавання' });
    cancel.focus();
    await userEvent.keyboard('{Enter}');
    await c.findByText('Вибір і чернетка збережені');
  },
};

function ContextRaceExample() {
  const [selection, setSelection] = useState<Record<string, number>>({ 'sample-1': 3, prior: 2 });
  const [applied, setApplied] = useState(false);
  const [services] = useState(() => {
    let finishApply = () => {};
    let failContext = () => {};
    return {
      client: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      promotions: {
        context: async (store) => {
          if (store === undefined || store === null) return fixtureContext;
          return new Promise((_, reject) => {
            failContext = () => reject(Error('Новий магазин 503'));
          });
        },
      } as PromotionApi,
      selection: {
        result: async () => fixtureResult(),
        preview: async (_, body) => {
          if (!body.snapshot) return fixtureReview();
          return new Promise((resolve) => {
            finishApply = () => resolve(fixtureReview());
          });
        },
      } satisfies SelectionApi,
      finish: () => finishApply(),
      fail: () => failContext(),
    };
  });
  return (
    <QueryClientProvider client={services.client}>
      <div className="tk-root">
        <Button onPress={services.finish}>Відповісти на старе застосування</Button>
        <Button onPress={services.fail}>Помилка нового магазину</Button>
        <p data-testid="copies">{JSON.stringify(selection)}</p>
        <p data-testid="adoption">{applied ? 'Застосовано' : 'Вибір збережено'}</p>
        <PricingContext api={services.promotions}>
          {(_, __, context, promotions, controls) => (
            <OperationSelectionReview
              operation={fixtureOperation}
              selection={selection}
              context={context}
              contextGuard={controls.guard}
              promotions={promotions}
              api={services.selection}
              isDisabled={false}
              onCancel={() => {}}
              onApply={(next, _, nextContext) => {
                controls.adopt(nextContext);
                setSelection(next);
                setApplied(true);
              }}
            />
          )}
        </PricingContext>
      </div>
    </QueryClientProvider>
  );
}
export const NewContextFencesPendingApply: Story = {
  render: () => (
    <StrictMode>
      <ContextRaceExample />
    </StrictMode>
  ),
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await c.findByRole('button', { name: 'Вибрати цю сторінку (1)' });
    await userEvent.click(c.getByRole('button', { name: 'Вибрати цю сторінку (1)' }));
    await userEvent.click(c.getByRole('button', { name: 'Прочитати поточні ціни вибраних' }));
    await userEvent.click(await c.findByRole('button', { name: 'Замінити вибір' }));
    const store = c.getByRole('button', { name: /Ціни та друк для/ });
    store.focus();
    await userEvent.keyboard('{Enter}{End}{Enter}');
    const workspace = canvasElement.querySelector('.tk-pricing-workspace')!;
    await expect(workspace).toHaveAttribute('inert');
    await userEvent.click(c.getByRole('button', { name: 'Відповісти на старе застосування' }));
    await c.findByText(/Вибір магазину змінився. Прочитайте перегляд повторно./);
    await expect(c.getByTestId('copies')).toHaveTextContent('"sample-1":3,"prior":2');
    await expect(c.getByTestId('adoption')).toHaveTextContent('Вибір збережено');
    await expect(store).toHaveTextContent('Магазин 1');
    await userEvent.click(c.getByRole('button', { name: 'Помилка нового магазину' }));
    await c.findByText('Новий магазин 503');
    await expect(workspace).toHaveAttribute('inert');
    const cancel = c.getByRole('button', { name: 'Скасувати зміну магазину' });
    cancel.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(workspace).not.toHaveAttribute('inert'));
    await expect(c.queryByRole('button', { name: 'Замінити вибір' })).not.toBeInTheDocument();
    await expect(c.getByTestId('copies')).toHaveTextContent('"sample-1":3,"prior":2');
  },
};
