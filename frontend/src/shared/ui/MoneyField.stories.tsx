import { useState } from 'react';
import { Form } from 'react-aria-components';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { MoneyField } from './MoneyField';
import { Button } from './Button';

function Example({ initial = '21.99', disabled = false }) {
  const [value, setValue] = useState(initial);
  const [saved, setSaved] = useState('');
  return (
    <Form
      className="tk-stack"
      onSubmit={(event) => {
        event.preventDefault();
        setSaved(value);
      }}
    >
      <MoneyField
        label="Продаж"
        value={value}
        onChange={setValue}
        isRequired
        isDisabled={disabled}
      />
      <Button type="submit" isDisabled={disabled}>
        Зберегти
      </Button>
      <output aria-label="Десяткова сума">{value}</output>
      <output aria-label="Збережена сума">{saved}</output>
      <Button onPress={() => setValue('136.50')}>Оновити з сервера</Button>
    </Form>
  );
}
const meta = { title: 'Основа/Грошове поле', component: Example } satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Empty: Story = { args: { initial: '' } };
export const Disabled: Story = { args: { disabled: true } };
export const KeyboardAndPaste: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const hryvnias = canvas.getByRole('textbox', { name: 'Продаж: гривні' });
    const kopecks = canvas.getByRole('textbox', { name: 'Продаж: копійки' });
    await expect(hryvnias).toHaveValue('21');
    await expect(kopecks).toHaveValue('99');
    await userEvent.clear(kopecks);
    await userEvent.type(kopecks, '5');
    await expect(canvas.getByLabelText('Десяткова сума')).toHaveTextContent('21.05');
    await userEvent.tab();
    await expect(kopecks).toHaveValue('05');
    await userEvent.click(hryvnias);
    await userEvent.keyboard(',');
    await expect(kopecks).toHaveFocus();
    await userEvent.keyboard('00');
    await userEvent.click(canvas.getByRole('button', { name: 'Зберегти' }));
    await expect(canvas.getByLabelText('Збережена сума')).toHaveTextContent('21.00');
    await userEvent.click(hryvnias);
    await userEvent.paste('1 234,90');
    await expect(hryvnias).toHaveValue('1234');
    await expect(kopecks).toHaveValue('90');
    await expect(canvas.getByLabelText('Десяткова сума')).toHaveTextContent('1234.90');
    await userEvent.click(kopecks);
    await userEvent.paste('0.09');
    await expect(hryvnias).toHaveValue('0');
    await expect(kopecks).toHaveValue('09');
    await userEvent.click(canvas.getByRole('button', { name: 'Оновити з сервера' }));
    await expect(hryvnias).toHaveValue('136');
    await expect(kopecks).toHaveValue('50');
    await userEvent.clear(hryvnias);
    await userEvent.click(canvas.getByRole('button', { name: 'Зберегти' }));
    await expect(canvas.getByLabelText('Збережена сума')).toHaveTextContent('21.00');
  },
};
export const KopecksWithoutHryvnias: Story = {
  args: { initial: '' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const hryvnias = canvas.getByRole('textbox', { name: 'Продаж: гривні' });
    const kopecks = canvas.getByRole('textbox', { name: 'Продаж: копійки' });
    const amount = canvas.getByLabelText('Десяткова сума');
    const save = canvas.getByRole('button', { name: 'Зберегти' });
    // Kopecks without гривні are a whole amount, not an empty one the server rejects.
    await expect(amount).toBeEmptyDOMElement();
    await userEvent.click(hryvnias);
    await userEvent.keyboard(',50');
    await expect(amount).toHaveTextContent('0.50');
    await userEvent.tab();
    await expect(hryvnias).toHaveValue('0');
    await expect(kopecks).toHaveValue('50');
    await userEvent.click(save);
    await expect(canvas.getByLabelText('Збережена сума')).toHaveTextContent('0.50');
  },
};
export const Invalid: Story = {
  args: { initial: '21.999' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Зберегти' }));
    await expect(canvas.getByText('Копійки: від 0 до 99.')).toBeVisible();
    await expect(canvas.getByLabelText('Збережена сума')).toBeEmptyDOMElement();
  },
};
