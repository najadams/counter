import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/index.css';
import { FRIENDLY_UI_ENABLED } from '../shared/lib/buildFlags';

// The Friendly build restyles focus rings and illustrations through this hook.
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
