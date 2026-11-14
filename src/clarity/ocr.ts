/**
 * Optical character recognition (Tesseract via tesseract.js, WebAssembly) for scanned PDF pages.
 * Runs on this device. Nothing is downloaded at run time: the worker script, the WebAssembly core
 * and the language data are served by HCG Clarity itself (see vite.config.ts), and every path is
 * set explicitly because tesseract.js otherwise falls back to a public CDN.
 */
import { SourceError } from './common';

export const OCR_LANGUAGES = { eng: 'English', nor: 'Norwegian' } as const;
export type OcrLanguage = keyof typeof OCR_LANGUAGES;

export interface OcrPaths {
  /** Browser only. Node uses tesseract.js's own worker script and core. */
  workerPath?: string;
  corePath?: string;
  /** Folder (URL in the browser, file path in Node) containing `<lang>.traineddata.gz`. */
  langPath: string;
}

let paths: OcrPaths | null = null;
export function configureOcr(p: OcrPaths): void {
  paths = p;
}
export function ocrAvailable(): boolean {
  return paths !== null;
}

export class OcrCancelled extends SourceError {
  constructor() {
    super('Text recognition was stopped. Nothing was added.');
  }
}

export interface OcrPageResult {
  text: string;
  /** Tesseract's mean word confidence, 0–100. */
  confidence: number;
}

/** What tesseract.js accepts as an image: a PNG buffer (Node) or a canvas (browser). */
export type OcrImage = Uint8Array | HTMLCanvasElement | OffscreenCanvas;

export interface OcrRun {
  languages: OcrLanguage[];
  signal?: AbortSignal;
  /** Called before each page with (pages done, pages total). */
  onProgress?: (done: number, total: number) => void;
}

/** Recognises the given page images one after another with a single worker. */
export async function recognisePages(images: (() => Promise<OcrImage>)[], run: OcrRun): Promise<OcrPageResult[]> {
  if (!paths) throw new SourceError('Text recognition (OCR) is not set up in this build.');
  if (!run.languages.length) throw new SourceError('Choose at least one OCR language.');
  if (run.signal?.aborted) throw new OcrCancelled();
  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker(run.languages.join('+'), 1 /* LSTM only */, {
    langPath: paths.langPath,
    ...(paths.workerPath ? { workerPath: paths.workerPath, workerBlobURL: false } : {}),
    ...(paths.corePath ? { corePath: paths.corePath } : {}),
    gzip: true,
    cacheMethod: 'none',
  });
  let cancelled = false;
  const onAbort = () => {
    cancelled = true;
    void worker.terminate();
  };
  run.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const out: OcrPageResult[] = [];
    for (let i = 0; i < images.length; i++) {
      run.onProgress?.(i, images.length);
      if (cancelled) throw new OcrCancelled();
      const image = await images[i]();
      if (cancelled) throw new OcrCancelled();
      const { data } = await worker.recognize(image as Parameters<typeof worker.recognize>[0]);
      out.push({ text: data.text, confidence: Math.round(data.confidence) });
    }
    run.onProgress?.(images.length, images.length);
    return out;
  } catch (e) {
    if (cancelled) throw new OcrCancelled();
    if (e instanceof SourceError) throw e;
    throw new SourceError(`Text recognition failed: ${(e as Error)?.message ?? String(e)}`);
  } finally {
    run.signal?.removeEventListener('abort', onAbort);
    if (!cancelled) await worker.terminate().catch(() => {});
  }
}
