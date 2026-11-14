# Test results

Last full run: 14 November 2026, Linux container, Node 22.23, Chromium (Playwright 1.63),
python-pptx 1.0.2, LibreOffice. All provider traffic went to the local **mock** servers in
`e2e/mock-providers.mjs`; no real API key was used and no paid call was made.

| Command | Result |
|---|---|
| `npm run typecheck` (client, server, desktop) | Pass, no errors |
| `npm test` | **278 passed, 3 skipped**, 0 failed (15 files) |
| — of which `tests/distil` (Distil port) | 74 passed, 3 skipped |
| — of which `tests/refine` (RePrompter port) | 98 passed |
| — of which `tests/clarity` (new) | 28 passed |
| — of which Presentation Studio tests | 78 passed |
| `npm run test:e2e:clarity` | **18/18** browser steps |
| `npm run test:e2e` | **27/27** browser steps |
| `npm run desktop:pack` + `npm run desktop:test` (packaged Linux Electron app, own Xvfb) | **14/14** steps |
| `./scripts/check-no-secrets.sh` | Pass |

The 3 skipped Distil tests are kept as `it.skip` on purpose: they test Swift types that were
not ported (SampleProject, Evaluation/ProjectCodec, Experiment validation).

## What the requested checks map to

| Requirement | Covered by |
|---|---|
| Importing supported source material | e2e “Sources: import…” (text + image; PDF refused with a message; duplicate refused); `tests/clarity/workflow.test.ts` “sources” (strict UTF-8, BOM, empty) |
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
- macOS desktop build (`npm run desktop:dist:mac`), Windows, and any run by a person on a Mac.
- Microsoft PowerPoint and Keynote; screen readers; very large projects.
