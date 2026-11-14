import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ClarityProvider } from './state';
import './styles/app.css';
import './styles/clarity.css';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { setPdfWorkerSrc } from '../clarity/extract';
import { configureOcr } from '../clarity/ocr';

setPdfWorkerSrc(pdfWorkerUrl);
// OCR files are served by the app itself (vite.config.ts); never from a CDN.
const ocrBase = new URL('ocr/', document.baseURI).href;
configureOcr({ workerPath: `${ocrBase}worker.min.js`, corePath: `${ocrBase}tesseract-core-simd-lstm.wasm.js`, langPath: ocrBase.replace(/\/$/, '') });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ClarityProvider>
      <App />
    </ClarityProvider>
  </StrictMode>,
);
