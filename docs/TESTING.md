# Test results

Last full run: 14 November 2026, Linux container, Node 22.23, Chromium (Playwright 1.63),
python-pptx 1.0.2, LibreOffice. All provider traffic went to the local **mock** servers in
`e2e/mock-providers.mjs`; no real API key was used and no paid call was made.

| Command | Result |
|---|---|
| `npm run typecheck` (client, server, desktop) | Pass, no errors |
| `npm test` | **297 passed, 3 skipped**, 0 failed (18 files) |
| — of which `tests/distil` (Distil port) | 74 passed, 3 skipped |
| — of which `tests/refine` (RePrompter port) | 98 passed |
| — of which `tests/clarity` (new) | 47 passed |
| — of which Presentation Studio tests | 78 passed |
| `npm run test:e2e:clarity` | **21/21** browser steps |
| `npm run test:e2e` | **27/27** browser steps |
| `npm run desktop:pack` + `npm run desktop:test` (packaged Linux Electron app, own Xvfb) | **15/15** steps (includes PDF import, scanned-PDF OCR and image OCR under the app's CSP) |
| `./scripts/check-no-secrets.sh` | Pass |

**CI** ([run 43546700506](https://github.com/F1r3srp3nt/HCG-Clarity/actions/runs/43546700506), commit `a359fb0`, GitHub-hosted runners): all four jobs passed —
type-check/unit tests/build and both browser e2e suites on `ubuntu-24.04`, the packaged Linux
desktop app (14/14), and on `macos-15` (Apple Silicon) the `.app` + DMG build with signature,
bundle and fuse checks followed by the packaged-app test (14/14, including python-pptx opening the
exported deck).

The 3 skipped Distil tests are kept as `it.skip` on purpose: they test Swift types that were
not ported (SampleProject, Evaluation/ProjectCodec, Experiment validation).

## What the requested checks map to

| Requirement | Covered by |
|---|---|
| Importing supported source material | e2e “Sources: import…” (text + image; damaged PDF, PowerPoint and duplicate refused with messages) and “PDF and Word import” (extracted text, page dividers, page references in Distil and the brief, scanned PDF refused); `tests/clarity/extract.test.ts` (extraction, page mapping, original bytes kept, damaged/fake files); OCR: `tests/clarity/ocr.test.ts` (scanned and mixed PDFs, OCR labels in references, progress, cancellation) and the e2e “OCR” step (confirmation, Stop, mixed PDF without scanned pages, no request outside the app); image OCR: `tests/clarity/image-ocr.test.ts` (labels, Distil, save/reopen, brief, blank image, cancellation) and the e2e “OCR for an image source” step (WebP decoded in the browser, references, re-reading blocked once excerpts exist); `tests/clarity/workflow.test.ts` “sources” (strict UTF-8, BOM, empty) |
| Saving and reopening a project | `tests/clarity/projectFile.test.ts` “save and reopen” (byte-identical sources/images/outputs, revisions, links, same selection result); e2e “Reopen in a fresh page…”; desktop e2e save/open dialogs |
| Distilling without losing provenance | `workflow.test.ts` excerpts equal the exact source lines (incl. CRLF, fences), demo reproduces 323 → 221; e2e checks every reference names valid lines; notes with fabricated quotes are marked unverified (unit, server and e2e); brief keeps excerpts verbatim with references |
| Refining and preserving prompt revisions | `workflow.test.ts` “Refine revisions”; e2e local format → manual edit → AI → restore = 5 revisions, diff view, reopened with 5 revisions |
| Producing and reopening exports | e2e: prepared prompt `.txt`, prompt `.md`, brief `.md`, `.pptx` (python-pptx: 4 slides); History re-download is byte-identical after reopening; inherited e2e validates `.pptx` with python-pptx and LibreOffice and the narration ZIP |
| Cancellation | `tests/clarity/server.test.ts` and e2e: Stop aborts the browser request **and** the upstream provider request (the mock records the disconnect); nothing is changed |
| Recoverable failures | Rate limit → error with Retry → retry succeeds (e2e); invalid model output → no revision, Retry offered (e2e, server test); damaged/foreign/newer/missing-file projects (unit); tampered source checksum warning (unit); crash/closed-tab recovery from autosave (e2e) |
| Missing credentials / unavailable providers | 503 with setup hint for both new routes (server test); AI buttons lead to Setup while local features work (e2e); unreachable server banner (e2e); keys never in page, storage, files or logs (inherited e2e and desktop e2e) |
| Migration of existing user data | Presentation Studio `.pstudio`, Distil schema-3 JSON, HCG RePrompter backup (unit); RePrompter backup in the browser with migration notice (e2e); older Distil schemas refused with instructions |

## Not tested

- Real Anthropic or ElevenLabs calls (no keys were available). Output quality, real error bodies
  and real prompt-injection resistance are therefore unverified.
- The original Swift test suites of RePrompter and Distil: no Swift toolchain in this
  environment. Their tests were ported and run against the TypeScript ports instead.
- Any run of the macOS app by a person on a Mac (the CI runner drives it automatically, with a
  test keystore instead of the real Keychain), notarised distribution, and Windows.
- Microsoft PowerPoint and Keynote; screen readers; very large projects.
- PDF, Word and OCR were tested with synthetic files (made by LibreOffice; the scans are those pages rasterised at 150 dpi). Real scans (skewed, low-contrast, handwritten, mixed languages) will recognise less accurately.
- Real-world documents (multi-column layouts, tables, right-to-left text, unusual fonts or encodings) may extract in a different reading order or with gaps; the source view shows the extracted text so it can be checked.
