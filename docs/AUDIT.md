# Source audit and migration map

This records what was inspected before HCG Clarity was built, what each source actually does,
and what was reused, adapted, deferred or excluded, with the reason.

Sources inspected (read-only; none of them was modified):

| Source | Revision inspected | Location |
|---|---|---|
| HCG RePrompter | `0e91066` | `F1r3srp3nt/HCG-RePrompter` |
| The Last Sprint (contains Distil, Relay, Presentation Studio) | `03cc61d` | `F1r3srp3nt/The-Last-Sprint` |

Distil is not a separate repository; it is `distil/` inside The Last Sprint.

## 1. What each source actually is

### HCG RePrompter (`0.1.0`, “offline workspace milestone”)

- **Stack:** Swift 6 package. `RePrompterCore`, `RePrompterProviders` and `RePrompterPersistence`
  are Foundation-only and build on Linux; `RePrompterUI` and the app are SwiftUI, macOS 15+.
  No third-party packages.
- **Works (with tests):** local prompt analysis (objective, requirements, constraints, missing
  information, vague wording), a deterministic local formatter, text segmentation/sanitising,
  input validation, a word-level diff, a preservation checker (numbers, quotes, URLs, identifiers,
  code, negations), 10 built-in templates, TXT/Markdown/JSON export, a JSON prompt library with
  backup import/export, session restore.
- **Present but switched off in the shipped app:** an Anthropic provider and a strict AI
  enhancement contract (system prompt that fences the user's prompt as untrusted data, JSON schema,
  response validator). The README states the app does not use it; the UI shows a disabled
  “Reprompt with HCG AI” button. The adapter has tests against a fake transport only.
- **Integration points:** `HCGIdentityProviding` (HCG Connect), `HCGEntitlementChecking`,
  `HCGProductRegistryReporting` are **protocols only** — nothing implements or calls them and no
  endpoint is defined. HCG AI is a permanently unavailable stub.
- **Credentials:** Keychain store for an Anthropic key (Providers module).
- **Licence:** “© 2026 Hakmi Capital Group. All rights reserved.” No open-source licence file.

### Distil (The Last Sprint `distil/`, “native macOS prototype 0.5”)

- **Stack:** Swift 5.9 package (`TokenLab*` module names). Core builds on Linux; SwiftUI app macOS 14+.
  No third-party packages.
- **What it does:** deterministic context **selection**, not summarisation. Pasted text is split
  into blocks that are exact runs of whole lines (Markdown headings, else blank lines; fenced code
  never split). Four strategies (full, exact dedupe, manual-priority budget, task-relevance budget
  via keyword overlap) select blocks under an estimated-token budget and explain every decision;
  “prepared prompt” = instructions + kept blocks + task, verbatim. Comparison runs all four.
- **Works (with tests):** splitter, approximate counter, keyword ranker, selection engine,
  comparison, secret scanner, BPE tokenizer for `cl100k_base`/`o200k_base` with SHA-checked
  vocabulary files, versioned JSON project files (schemas 1–3 with migration), manual answer
  evaluation. 125 tests pass on Linux per its README.
- **Prototype / unverified:** the SwiftUI app was only launched by CI for screenshots;
  interaction “not verified: needs a person on a Mac”. Answers are entered by hand: there is no
  provider call (`ProviderAdapter` is an interface).
- **Licence:** none stated. Source is described as newly written for the project; the HCG logo is used.

### Presentation Studio (The Last Sprint `presentation-studio/`)

- **Stack:** TypeScript. React 19 + Vite client, Express 5 server holding provider keys,
  Electron 44 desktop shell (safeStorage/Keychain, sandboxed renderer, token-protected backend).
  Node 22.12+.
- **Works (with tests, mock providers):** image upload; brief; template deck without AI;
  AI outline + per-slide generation through the official Anthropic SDK with structured outputs,
  double validation, resume, prompt-injection boundary for image content; slide editor with ten
  layouts and three themes; restyle; **real editable `.pptx` export** via PptxGenJS (text boxes,
  native shapes, pictures with native crop, speaker notes), checked with python-pptx and
  LibreOffice; ElevenLabs spoken brief and narration (+ ZIP with mapping); presentation mode;
  `.pstudio` project files. 78 unit/API tests, 27 browser e2e steps, a packaged-desktop e2e.
- **Not verified (per its README):** real Anthropic/ElevenLabs calls, Microsoft PowerPoint/Keynote,
  real microphones.
- **Licence:** none stated for the app. Dependencies are MIT/Apache-2.0/BSD (see `NOTICE.md`).

### Relay (The Last Sprint `relay/`)

- **Stack:** Swift; macOS SwiftUI app plus a Linux-capable core and `relay-runner` CLI.
- **What it does:** an assistant for three hackathon side challenges: a **simulated** “Wybe Night
  Shift” environment (its own `sim.` commands and scores, all labelled SIMULATED), **synthetic**
  warehouse-procedure training (Holio), and ElevenLabs STT/TTS adapters. A rule-based reasoner,
  a task queue with approval states, an event log with credential redaction.
- **Real but unexercised:** ElevenLabs calls and the Wybe connection check (never run with a key).
  **Not implemented by design:** live Wybe command mapping, any Holio integration, any
  language-model reasoning.

## 2. Duplicates and incompatible assumptions

| Topic | Found in | Decision |
|---|---|---|
| Anthropic access | RePrompter (Swift adapter, unused), Presentation Studio (official TS SDK, server-side) | Use Presentation Studio's server; keep RePrompter's **contract** (prompt + validator) and run it through that server |
| ElevenLabs | Relay (Swift, never called live), Presentation Studio (TS, tested against mocks, wired into narration) | Presentation Studio's |
| Credential storage | RePrompter Keychain, Relay Keychain, Presentation Studio safeStorage + `.env` | Presentation Studio's (desktop: OS keychain via safeStorage; web: server-side `.env`) |
| Design system | Distil and Relay share one SwiftUI skin; Presentation Studio has a matching navy/cyan CSS palette | Presentation Studio's CSS tokens, extended for the shell |
| Project files | RePrompter JSON library, Distil versioned JSON, Presentation Studio ZIP | New `.clarity` ZIP that embeds the deck model; older files are migrated on open |
| Platform | Two SwiftUI macOS-only apps vs. one cross-platform TS web + Electron app | TypeScript app (see §3) |
| Character counting | Swift grapheme clusters vs. JS UTF-16 | Ports use `Intl.Segmenter` where counts matter |

## 3. Architecture choice

The only stack with a working output/export path, a provider server, secure credential storage,
desktop packaging and browser-testable UI is Presentation Studio's TypeScript stack. The two Swift
products' valuable parts are pure, Foundation-only libraries without UI coupling, so they were
**ported to TypeScript faithfully, with their tests**, rather than re-implemented. Rewriting the
working React/Express/Electron code in SwiftUI would have thrown away the export, the desktop
shell and all browser tests, and would limit the app to macOS. A Swift toolchain is not required
to build HCG Clarity.

Layering (document processing separate from presentation and providers):

```
src/distil/   Distil engine (port)            ─┐ pure TS, no DOM/Node/network
src/refine/   RePrompter library (port)       ─┤
src/clarity/  project model, file format, provenance, migration, notes validation, brief
src/shared/, src/export/, src/project/  deck model, renderer, PPTX/ZIP export (Presentation Studio)
server/       Express: provider keys, Anthropic calls, ElevenLabs (Presentation Studio + 2 routes)
src/client/   React UI: shell + Sources/Distil/Refine/Create/History views, deck workspace
desktop/      Electron shell (Presentation Studio)
```

## 4. Migration map

| Component | Decision | Where in HCG Clarity | Reason / behaviour change |
|---|---|---|---|
| Presentation Studio client, server, export, project model, desktop shell, tests, samples | **Reused** (copied, renamed) | `src/shared`, `src/export`, `src/project`, `server`, `desktop`, `tests`, `e2e`, `samples` | Working, tested, produces real editable PPTX. Renamed to HCG Clarity; `.pstudio` kept as the deck's legacy format |
| Presentation Studio `App.tsx` | **Adapted** | `src/client/views/DeckWorkspace.tsx` | Became Create → Presentation inside the shared shell. Open/save moved to the shell; exports recorded in History |
| Presentation Studio state | **Adapted** | `src/client/state.tsx` | One Clarity project; `useStudio()` kept as an adapter so the editor components run unchanged |
| Presentation Studio brief | **Adapted** | `src/shared/model.ts`, `server/prompts.ts` | New `material` field (distilled excerpts/notes) sent as `<source_material>`, explicitly not instructions; provenance ids. Old files load with defaults; resume fingerprint unchanged for them |
| Presentation Studio images step | **Adapted** | `src/client/components/SourcesStep.tsx` | Images are Sources shared with the deck (same id, one stored original); removing from the deck keeps the source |
| Distil core: models, splitter, approximate counter, relevance, selection engine, comparison, secret scanner | **Ported** (TS, same algorithms and wording) | `src/distil/` + `tests/distil/` (74 tests, demo numbers reproduced) | Added 1-based `lineStart`/`lineEnd` to every block for source references |
| Distil BPE tokenizer + vocab import | **Deferred** | — | Needs downloaded vocabulary files and their UI; the approximate counter is labelled as an estimate everywhere |
| Distil evaluation/experiments, answer recording | **Deferred** | — | Manual A/B answer evaluation is a research workflow, not part of import → distil → refine → create |
| Distil project files (schema 3) | **Migrated on open** | `src/clarity/projectFile.ts` | Pasted originals + loose blocks → text sources; task/instructions/strategy/budget → a distillation. Experiments, library, Required marks not carried over (stated in the migration notice). Schemas 1–2: user is asked to re-save in Distil 0.5 |
| Distil SwiftUI app | **Excluded** | — | Replaced by the Distil view |
| RePrompter core: analyzer, formatter, local enhancer, segmentation, sanitiser, validation, diff, preservation checker, modes, models, contract, templates, exporter | **Ported** | `src/refine/` + `tests/refine/` (98 tests) | Exporter and contract name the product “HCG Clarity” |
| RePrompter provider request/response logic | **Ported as pure functions** | `src/refine/providers.ts`, `src/clarity/refineAi.ts`, `server` route | Request built from the contract; the reply is validated in the browser before a revision is stored. Transport/retry/Keychain not ported (server + SDK do this) |
| RePrompter persistence (library, collections, workspace restore) | **Adapted** | prompts + revisions in the project; autosave recovery in `src/client/recovery.ts` | Prompts belong to a project; every change is a revision (RePrompter kept one enhanced version). Collections deferred |
| RePrompter backup files | **Migrated on open** | `src/clarity/projectFile.ts` | Records → prompts with original (+ enhanced) revisions; rejected enhancements left out; templates/collections not carried over |
| RePrompter HCG integration protocols, HCG AI stub | **Excluded** | — | Interfaces only, no implementation exists to reuse. No account system was created (see §6) |
| RePrompter SwiftUI app | **Excluded** | — | Replaced by the Refine view |
| Relay | **Excluded** | — | Its orchestration serves simulated/synthetic hackathon challenges, not this workflow; its ElevenLabs adapter duplicates Presentation Studio's tested one and never ran live; there is no supported integration (Wybe live mode, Holio) to carry over. Its useful ideas — approval before paid calls, visible task state, never logging secrets — already exist in Presentation Studio's server and UI (explicit confirmations, per-step progress, code-only logging). Adding its task queue would have created a second orchestration system |
| The Last Sprint `submissions/` (built `.app`, `.dmg`, zips) | **Excluded** | — | Build artefacts |
| Screenshots of the old apps | **Excluded** | — | New screenshots from this app's e2e are in `docs/screenshots` |
| Presentation Studio `docs/screenshots` | **Excluded** | — | They show the old UI |
| Branding | **Reused** | `public/hcg-mark.png`, `desktop/resources` | HCG logo as used by the sources |

## 5. External services and credentials

| Service | Used for | Credential | Without it |
|---|---|---|---|
| Anthropic Messages API | Distil AI notes, Refine AI enhancement, slide generation and rewrite | `ANTHROPIC_API_KEY` (web: `.env`, server only) or desktop Setup (OS keychain) | AI buttons lead to Setup; everything else works |
| ElevenLabs | Spoken brief, slide narration | `ELEVENLABS_API_KEY` likewise | Typing and export work |

No real key was available. All provider traffic in tests goes to local mock servers
(`e2e/mock-providers.mjs`). **No live integration has been verified.**

## 6. HCG Connect

No source contains an HCG Connect implementation — RePrompter has only an unimplemented
`HCGIdentityProviding` protocol and no endpoint. HCG Clarity therefore has **no account system**
and creates none; it is single-user and local. Account integration is deferred until an HCG Connect
API exists to reuse.

## 7. Changes after 0.1.0

- **PDF and Word (.docx) import** (previously deferred). Text is extracted in the app with
  pdf.js (Apache-2.0) and mammoth (BSD-2-Clause); the original file is what is stored and hashed,
  the extracted text is recorded on the source with the method used, and PDF excerpts carry page
  numbers. Scanned PDFs (no text layer), `.doc`, PowerPoint and RTF remain unsupported.
- **OCR for scanned PDFs.** Pages without a text layer can be read with Tesseract (tesseract.js,
  WebAssembly, Apache-2.0) on the user's device after confirmation, in English and/or Norwegian.
  All OCR files are served by the app; the desktop CSP gained `'wasm-unsafe-eval'` for this. OCR
  pages are recorded on the source and marked `(OCR)` in references; confidence is reported.
- **OCR for image sources.** An image source's text can be recognised on demand with the same
  on-device OCR. The image stays the stored original (still usable in the deck); the recognised
  text is stored on the source, labelled as OCR, and can be used by Distil. Reading it again is
  blocked while excerpts point into the current text, so references cannot silently change.

