# Notices and provenance

## Origin of the code

HCG Clarity 0.1.0 was assembled from the following sources. None of the original repositories
was modified.

| Origin | Revision | Brought in as | Location in HCG Clarity |
|---|---|---|---|
| HCG RePrompter — `Sources/RePrompterCore`, request/response logic of `Sources/RePrompterProviders`, `Tests/RePrompterTests` | `0e91066` | Ported from Swift to TypeScript; each file's header names its Swift source | `src/refine/`, `tests/refine/` |
| The Last Sprint — `distil/Sources/TokenLabCore`, `distil/Tests/TokenLabCoreTests` | `03cc61d` | Ported from Swift to TypeScript; each file's header names its Swift source | `src/distil/`, `tests/distil/` |
| The Last Sprint — `presentation-studio/` (source, tests, e2e, desktop shell, samples, scripts, configuration) | `03cc61d` | Copied, then renamed to HCG Clarity and adapted where listed in `docs/AUDIT.md` §4 | `src/shared/`, `src/export/`, `src/project/`, `src/client/` (except `views/`, `files.ts`, `recovery.ts`), `server/`, `desktop/`, `tests/*.test.ts`, `tests/fixtures/`, `e2e/run-e2e.mjs`, `e2e/run-desktop-e2e.mjs`, `e2e/mock-providers.*`, `samples/` (except `clarity-upload-notes.md`), `scripts/`, `docs/DESKTOP.md`, build configuration |
| New for HCG Clarity | — | — | `src/clarity/`, `src/client/views/`, `src/client/files.ts`, `src/client/recovery.ts`, `src/client/styles/clarity.css`, `tests/clarity/`, `e2e/run-clarity-e2e.mjs`, docs |

HCG RePrompter is © 2026 Hakmi Capital Group, all rights reserved. Distil and Presentation
Studio were written for Oslo Sprint 2026 (The Last Sprint) and carry no separate licence. The HCG
logo (`public/hcg-mark.png`, `desktop/resources/`) belongs to Hakmi Capital Group. All sample
content in `samples/` and in the tests is synthetic.

## Third-party software

Runtime dependencies (licences from their `package.json`; full texts are in each package and,
for the desktop backend bundle, in `build/desktop/backend.cjs.LEGAL.txt` when built):

| Package | Version | Licence |
|---|---|---|
| @anthropic-ai/sdk | 1.6.0 | Apache-2.0 |
| dotenv | 18.0.9 | BSD-2-Clause |
| express | 5.3.0 | MIT |
| jszip | 3.10.2 | MIT or GPL-3.0-or-later (used under MIT) |
| pdfjs-dist (PDF text extraction) | 6.5.438 | Apache-2.0 |
| mammoth (Word .docx text extraction) | 1.13.0 | BSD-2-Clause; its dependencies: bluebird 3.7.2, underscore 1.13.8, xmlbuilder 15.1.1, base64-js 1.5.1, @xmldom/xmldom 0.8.15 (MIT), lop 0.4.2, dingbat-to-unicode 1.0.2 (BSD-2-Clause), argparse 2.0.1 (Python-2.0, command-line tool only, not bundled) |
| multer | 2.5.0 | MIT |
| pptxgenjs | 4.0.1 | MIT |
| react, react-dom | 19.3.1 | MIT |
| tsx | 4.23.15 | MIT |
| zod | 4.6.7 | MIT |
| tesseract.js (on-device OCR) | 7.0.0 | Apache-2.0; its dependencies: bmp-js 0.1.0, is-url 1.2.4, node-fetch 2.7.0, regenerator-runtime 0.13.11, zlibjs 0.3.1 (MIT), idb-keyval 6.3.0, wasm-feature-detect 1.10.1 (Apache-2.0) |
| tesseract.js-core (Tesseract OCR engine compiled to WebAssembly; includes Tesseract and Leptonica) | 7.0.0 | Apache-2.0 (Leptonica: BSD-2-Clause-style) |
| @tesseract.js-data/eng, @tesseract.js-data/nor (OCR language data, `4.0.0_best_int`) | 1.0.0 | MIT packaging of the Tesseract `tessdata` models (Apache-2.0) |
| electron (desktop app) | 44.9.3 | MIT; bundles Chromium (see `LICENSES.chromium.html` in the packaged app) |

Node tests only: @napi-rs/canvas 1.1.1 (MIT; optional dependency of pdfjs-dist, used to render PDF pages for OCR outside the browser).

Development-only: vite, vitest, typescript (Apache-2.0), playwright (Apache-2.0), electron-builder,
@electron/fuses, esbuild, concurrently and type packages (MIT unless stated).
