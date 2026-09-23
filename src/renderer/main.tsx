import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
// Fonts ship inside the bundle: a till with no internet must still render them.
import '@fontsource-variable/geist';
import '@fontsource-variable/geist/wght-italic.css';
import '@fontsource-variable/geist-mono';
// Atkinson Hyperlegible in the Friendly build, empty elsewhere (vite.config.mts).
import 'virtual:friendly-fonts';
import './styles/index.css';
import { FRIENDLY_UI_ENABLED } from '../shared/lib/buildFlags';

// The Friendly build restyles type, focus rings and illustrations through this hook.
if (FRIENDLY_UI_ENABLED) document.documentElement.dataset.ui = 'friendly';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Counter: no #root element in DOM. index.html is broken.');
}

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
