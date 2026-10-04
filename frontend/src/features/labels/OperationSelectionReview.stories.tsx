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
