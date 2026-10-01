import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from 'react-aria-components';
import { App } from './app/App';
import './shared/ui/controls.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing React root');
createRoot(root).render(
  <StrictMode>
    <I18nProvider locale="uk-UA">
      <App />
    </I18nProvider>
  </StrictMode>,
);
