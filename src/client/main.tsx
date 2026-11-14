import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ClarityProvider } from './state';
import './styles/app.css';
import './styles/clarity.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ClarityProvider>
      <App />
    </ClarityProvider>
  </StrictMode>,
);
