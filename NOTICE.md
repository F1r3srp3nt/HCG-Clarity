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
| multer | 2.5.0 | MIT |
| pptxgenjs | 4.0.1 | MIT |
| react, react-dom | 19.3.1 | MIT |
| tsx | 4.23.15 | MIT |
| zod | 4.6.7 | MIT |
| electron (desktop app) | 44.9.3 | MIT; bundles Chromium (see `LICENSES.chromium.html` in the packaged app) |

Development-only: vite, vitest, typescript (Apache-2.0), playwright (Apache-2.0), electron-builder,
@electron/fuses, esbuild, concurrently and type packages (MIT unless stated).
