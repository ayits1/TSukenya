import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { within, userEvent, expect } from 'storybook/test';
import { Select } from './Select';
function NativeDialog() {
  const [dialog, setDialog] = useState<HTMLDialogElement | null>(null),
    [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    dialog?.showModal();
    return () => dialog?.close();
  }, [dialog]);
  return (
    <dialog ref={setDialog} style={{ width: 'min(480px,calc(100vw - 40px))', padding: 16 }}>
      <h2>Список усередині нативного вікна</h2>
      {dialog ? (
        <Select
          label="Рядок накладної"
          options={[
            { id: '1', label: 'Партія A · 12.5000 грн' },
            { id: '2', label: 'Партія B · 13.1234 грн' },
          ]}
          selectedKey={selected}
          onSelectionChange={(key) => setSelected(String(key))}
          portalContainer={dialog}
        />
      ) : null}
      <p role="status">Вибрано: {selected || 'нічого'}</p>
    </dialog>
  );
}
const meta = { title: 'Controls/Select native dialog', component: NativeDialog } satisfies Meta<
  typeof NativeDialog
>;
export default meta;
type Story = StoryObj<typeof meta>;
export const KeyboardAndPointer: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const button = await c.findByRole('button', { name: /Рядок накладної/ });
    button.focus();
    await userEvent.keyboard('{Enter}{End}{Enter}');
    await expect(c.getByRole('status')).toHaveTextContent('2');
    await userEvent.click(button);
    await userEvent.click(c.getByRole('option', { name: 'Партія A · 12.5000 грн' }));
    await expect(c.getByRole('status')).toHaveTextContent('1');
    await expect(button).toHaveFocus();
  },
};
