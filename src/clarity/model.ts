/**
 * The HCG Clarity project: one file that keeps a project's sources, distillations,
 * prompt revisions, generated outputs and presentation deck, with links between them.
 *
 * Provenance rules (enforced by the functions in this folder, checked by tests):
 * - Sources are kept byte-for-byte in the binary store and are never edited.
 * - A distilled excerpt is an exact run of whole lines of one source, and records which
 *   source and which lines it came from. Excerpts are copies, so they survive edits elsewhere.
 * - AI notes are labelled as derived. Each citation names an excerpt and a quote; a citation
 *   whose quote is not found verbatim in that excerpt is marked unverified, never silently kept.
 */
import { z } from 'zod';
import { ProjectSchema as DeckSchema, emptyProject as emptyDeck } from '../shared/model';

export const CLARITY_FORMAT = 'hcg-clarity-project';
export const CLARITY_VERSION = 1;

// ---- Sources ----------------------------------------------------------------

export const SOURCE_KINDS = ['text', 'image'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const SourceSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  kind: z.enum(SOURCE_KINDS),
  mime: z.string(),
  /** Size of the original bytes. */
  bytes: z.number().int().nonnegative(),
  /** SHA-256 of the original bytes (hex). Lets anyone check that an original was not changed. */
  sha256: z.string(),
  /** How it arrived: a file the user chose, or text the user pasted. */
  origin: z.enum(['file', 'paste', 'migrated']),
  addedAt: z.string(),
  /** Decoded text for text sources (UTF-8, byte-order mark removed). Empty for images. */
  text: z.string(),
  /** Image size in pixels (images only). */
  width: z.number().int().nonnegative().default(0),
  height: z.number().int().nonnegative().default(0),
  note: z.string().default(''),
  /**
   * Set when `text` was extracted from a document (PDF or Word) rather than being the file itself.
   * The original document is what is stored byte-for-byte; references point into the extracted text.
   */
  extraction: z
    .object({
      from: z.enum(['pdf', 'docx', 'image']),
      method: z.string(),
      /** 1-based line where each page starts (PDF). */
      pageStartLines: z.array(z.number().int().positive()),
      warnings: z.array(z.string()),
      /** PDF pages whose text was recognised with OCR (less reliable than a text layer). */
      ocrPages: z.array(z.number().int().positive()).default([]),
    })
    .nullable()
    .default(null),
});
export type Source = z.infer<typeof SourceSchema>;

// ---- Distil -----------------------------------------------------------------

export const EXCERPT_CATEGORIES = ['instructions', 'requirements', 'reference', 'code', 'notes', 'other'] as const;

export const ExcerptSchema = z.object({
  id: z.string().min(1),
  /** The source this excerpt was cut from. May point to a removed source; the text is kept. */
  sourceId: z.string(),
  /** Name of the source at the time the excerpt was made, so references stay readable. */
  sourceName: z.string(),
  /** 1-based, inclusive line range in the source text. */
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
  title: z.string(),
  category: z.string(),
  /** Distil manual priority: 3 = high, 2 = medium, 1 = low. */
  priority: z.number().int().min(1).max(3),
  required: z.boolean(),
  /** Exact text of the lines. Never rewritten. */
  text: z.string(),
  /** Page(s) of the original document, e.g. "p. 3" (PDF sources only). */
  pages: z.string().default(''),
});
export type Excerpt = z.infer<typeof ExcerptSchema>;

export const CitationSchema = z.object({
  excerptId: z.string(),
  quote: z.string(),
  /** True only when the quote was found verbatim in the excerpt. */
  verified: z.boolean(),
});
export type Citation = z.infer<typeof CitationSchema>;

export const AiNoteSchema = z.object({
  id: z.string().min(1),
  heading: z.string(),
  text: z.string(),
  citations: z.array(CitationSchema),
});
export type AiNote = z.infer<typeof AiNoteSchema>;

export const AiNotesRunSchema = z.object({
  createdAt: z.string(),
  model: z.string(),
  notes: z.array(AiNoteSchema),
  /** Gaps the model reported instead of filling them, and validation messages. */
  gaps: z.array(z.string()),
  warnings: z.array(z.string()),
  /** Excerpt ids that were sent. */
  excerptIds: z.array(z.string()),
});
export type AiNotesRun = z.infer<typeof AiNotesRunSchema>;

export const STRATEGY_IDS = ['full', 'dedupe', 'priority', 'relevance'] as const;
export type StrategyId = (typeof STRATEGY_IDS)[number];

export const DistillationSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  sourceIds: z.array(z.string()),
  splitMode: z.enum(['split', 'whole']),
  task: z.string(),
  instructions: z.string(),
  strategy: z.enum(STRATEGY_IDS),
  /** Estimated-token budget for the whole prepared prompt. */
  budget: z.number().int().positive(),
  dedupe: z.boolean(),
  excerpts: z.array(ExcerptSchema),
  aiNotes: AiNotesRunSchema.nullable(),
});
export type Distillation = z.infer<typeof DistillationSchema>;

// ---- Refine -----------------------------------------------------------------

export const REVISION_KINDS = ['original', 'manual', 'local-format', 'ai', 'template', 'restored'] as const;
export type RevisionKind = (typeof REVISION_KINDS)[number];

export const RevisionSchema = z.object({
  id: z.string().min(1),
  createdAt: z.string(),
  kind: z.enum(REVISION_KINDS),
  text: z.string(),
  /** The revision this one was made from. */
  parentId: z.string().nullable(),
  /** Short explanation of what was done (e.g. the AI's change summary). */
  summary: z.string().default(''),
  changes: z.array(z.string()).default([]),
  /** Preservation-check and validation warnings at the time the revision was made. */
  warnings: z.array(z.string()).default([]),
  mode: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
});
export type Revision = z.infer<typeof RevisionSchema>;

export const PromptDocSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** The distillation this prompt was started from, if any. */
  distillationId: z.string().nullable(),
  revisions: z.array(RevisionSchema).min(1),
  /** Revision currently shown and used by Create. */
  currentRevisionId: z.string(),
});
export type PromptDoc = z.infer<typeof PromptDocSchema>;

// ---- Create -----------------------------------------------------------------

export const OUTPUT_KINDS = ['brief-md', 'prompt-txt', 'prompt-md', 'prompt-json', 'prepared-txt', 'pptx', 'pptx-narration-zip'] as const;
export type OutputKind = (typeof OUTPUT_KINDS)[number];

export const OutputSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(OUTPUT_KINDS),
  fileName: z.string(),
  mime: z.string(),
  bytes: z.number().int().nonnegative(),
  createdAt: z.string(),
  /** What it was made from. */
  promptId: z.string().nullable(),
  revisionId: z.string().nullable(),
  distillationId: z.string().nullable(),
  sourceIds: z.array(z.string()),
});
export type Output = z.infer<typeof OutputSchema>;

// ---- Project ----------------------------------------------------------------

export const ClarityProjectSchema = z.object({
  format: z.literal(CLARITY_FORMAT),
  version: z.literal(CLARITY_VERSION),
  id: z.string().min(1),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  sources: z.array(SourceSchema),
  distillations: z.array(DistillationSchema),
  prompts: z.array(PromptDocSchema),
  outputs: z.array(OutputSchema),
  deck: DeckSchema,
  /** Records of what was migrated from older files, shown once after opening. */
  migrationNotes: z.array(z.string()).default([]),
});
export type ClarityProject = z.infer<typeof ClarityProjectSchema>;

export function nowIso(): string {
  return new Date().toISOString();
}

export function newIdLocal(prefix: string): string {
  const c = globalThis.crypto;
  const raw = c && typeof c.randomUUID === 'function' ? c.randomUUID().replace(/-/g, '').slice(0, 12) : Math.random().toString(36).slice(2, 14);
  return `${prefix}_${raw}`;
}

export function emptyClarityProject(): ClarityProject {
  const t = nowIso();
  const deck = emptyDeck();
  return {
    format: CLARITY_FORMAT,
    version: CLARITY_VERSION,
    id: newIdLocal('prj'),
    title: 'Untitled project',
    createdAt: t,
    updatedAt: t,
    sources: [],
    distillations: [],
    prompts: [],
    outputs: [],
    deck,
    migrationNotes: [],
  };
}

/** True when a source has text Distil can use: a text source, or an image whose text was recognised. */
export function hasText(s: Pick<Source, 'kind' | 'text'>): boolean {
  return s.kind === 'text' || (s.kind === 'image' && s.text.trim().length > 0);
}

export function currentRevision(p: PromptDoc): Revision {
  return p.revisions.find((r) => r.id === p.currentRevisionId) ?? p.revisions[p.revisions.length - 1];
}

/** "notes.md · lines 4–12", or "report.pdf · p. 3 · lines 40–52" for a PDF (lines of the extracted text). */
export function excerptRef(e: Pick<Excerpt, 'sourceName' | 'lineStart' | 'lineEnd'> & { pages?: string }): string {
  const lines = e.lineStart === e.lineEnd ? `line ${e.lineStart}` : `lines ${e.lineStart}–${e.lineEnd}`;
  return `${e.sourceName} · ${e.pages ? `${e.pages} · ` : ''}${lines}`;
}
