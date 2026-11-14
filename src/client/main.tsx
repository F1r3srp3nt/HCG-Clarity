import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ClarityProvider } from './state';
import './styles/app.css';
import './styles/clarity.css';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { setPdfWorkerSrc } from '../clarity/extract';

setPdfWorkerSrc(pdfWorkerUrl);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ClarityProvider>
      <App />
    </ClarityProvider>
  </StrictMode>,
);
