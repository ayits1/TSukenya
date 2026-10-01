import type { Preview } from '@storybook/react-vite';
import { I18nProvider } from 'react-aria-components';
import '../src/shared/ui/controls.css';

const preview: Preview = {
  decorators: [
    (Story) => (
      <I18nProvider locale="uk-UA">
        <main className="tk-root tk-story">
          <Story />
        </main>
      </I18nProvider>
    ),
  ],
  parameters: {
    layout: 'padded',
    a11y: { test: 'error' },
    controls: { expanded: true },
  },
  tags: ['autodocs'],
};
export default preview;
