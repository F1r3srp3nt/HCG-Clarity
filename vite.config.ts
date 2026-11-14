import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { copyFileSync, createReadStream, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const apiPort = Number(process.env.PORT ?? 8787);

/**
 * OCR files served by the app itself under /ocr/ (never fetched from a CDN at run time):
 * the tesseract.js worker, the WebAssembly core (SIMD, LSTM engine) and the language data.
 */
const require = createRequire(import.meta.url);
const pkgDir = (name: string) => dirname(require.resolve(`${name}/package.json`));
export const OCR_FILES: Record<string, string> = {
  'ocr/worker.min.js': join(pkgDir('tesseract.js'), 'dist', 'worker.min.js'),
  'ocr/tesseract-core-simd-lstm.wasm.js': join(pkgDir('tesseract.js-core'), 'tesseract-core-simd-lstm.wasm.js'),
  'ocr/eng.traineddata.gz': join(pkgDir('@tesseract.js-data/eng'), '4.0.0_best_int', 'eng.traineddata.gz'),
  'ocr/nor.traineddata.gz': join(pkgDir('@tesseract.js-data/nor'), '4.0.0_best_int', 'nor.traineddata.gz'),
};

function ocrAssets(): Plugin {
  return {
    name: 'hcg-clarity-ocr-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const file = OCR_FILES[(req.url ?? '').split('?')[0].replace(/^\//, '')];
        if (!file) return next();
        res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'application/octet-stream');
        createReadStream(file).pipe(res);
      });
    },
    // Copied after the bundle is written (as emitted assets, .js files would be treated as code).
    writeBundle(options) {
      const outDir = options.dir ?? 'dist';
      for (const [fileName, file] of Object.entries(OCR_FILES)) {
        mkdirSync(dirname(join(outDir, fileName)), { recursive: true });
        copyFileSync(file, join(outDir, fileName));
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), ocrAssets()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': `http://127.0.0.1:${apiPort}` },
  },
  build: { outDir: 'dist', chunkSizeWarningLimit: 2000 },
});
