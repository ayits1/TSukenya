import { useCallback, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { ReviewPages } from './ReviewPages';
import { studioConfig, studioProducts, studioSettings } from './fixtures';
import './studio.css';

const products = Array.from({ length: 1000 }, (_, index) => ({
  ...studioProducts[0]!,
  id: `preview-${index}`,
  name: index === 999 ? 'Останній товар '.repeat(100) : `Товар ${index + 1}`,
}));
const config = { ...studioConfig, size: 'l' as const };
function PreviewCheck() {
  const [measured, setMeasured] = useState<string[] | null>(null);
  const receive = useCallback((_snapshot: string, clipped: string[]) => setMeasured(clipped), []);
  return (
    <div className="tk-studio" style={{ width: 320, maxWidth: '100%', padding: 12 }}>
      <ReviewPages
        snapshot="synthetic-thousand"
        products={products}
        config={config}
        settings={studioSettings}
        date={new Date('2026-10-01T12:00:00')}
        onMeasured={receive}
      />
      <p data-measured>{measured ? measured.join(',') : 'Очікуємо перевірку'}</p>
    </div>
  );
}
const meta = {
  title: 'Цінники/Порційний переддруковий перегляд',
  component: PreviewCheck,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof PreviewCheck>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ThousandCopiesKeyboardAndOffscreenValidation: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(
      () => expect(canvasElement.querySelector('[data-measured]')).toHaveTextContent('preview-999'),
      { timeout: 15000 },
    );
    expect(document.querySelector('.tk-label-validation')).toBeNull();
    expect(canvasElement.querySelectorAll('.tk-label.tag')).toHaveLength(4);
    const input = canvas.getByRole('combobox', { name: 'Аркуш для перегляду' });
    await userEvent.click(input);
    await userEvent.clear(input);
    await userEvent.type(input, '250');
    await userEvent.keyboard('{ArrowDown}{Enter}');
    await waitFor(() =>
      expect(canvasElement.querySelector('.tk-label-print-page')).toHaveAttribute(
        'data-page',
        '250',
      ),
    );
    expect(canvasElement.querySelectorAll('.tk-label.tag')).toHaveLength(4);
    expect(canvas.getByText(/усі 1000 цінників увійдуть/)).toBeVisible();
    expect(canvas.getByRole('button', { name: 'Наступний аркуш' })).toBeDisabled();
    const previous = canvas.getByRole('button', { name: 'Попередній аркуш' });
    await userEvent.click(previous);
    await waitFor(() =>
      expect(canvasElement.querySelector('.tk-label-print-page')).toHaveAttribute(
        'data-page',
        '249',
      ),
    );
    expect(canvas.getByText(/Аркуш 249 із 250/)).toHaveFocus();
    const navigation = canvasElement.querySelector('.tk-studio-proof-navigation')!;
    expect(navigation.scrollWidth).toBeLessThanOrEqual(navigation.clientWidth + 1);
    for (const control of navigation.querySelectorAll('button,input'))
      expect(control.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    expect(canvasElement.querySelector('[data-measured]')).toHaveTextContent('preview-999');
  },
};
