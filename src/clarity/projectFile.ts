/**
 * HCG Clarity project files (.clarity) are ZIP archives:
 *   clarity.json      the project model (sources metadata, distillations, prompts, outputs, deck)
 *   files/<id>        binary data by id: original sources (byte-for-byte), deck images,
 *                     narration audio and exported output files
 * No credentials are ever written here.
 *
 * Opening also accepts files from the applications HCG Clarity replaces, and migrates them:
 *   .pstudio          Presentation Studio project → the project's deck (+ its images as sources)
 *   Distil .json      Distil project (schema 3)    → pasted originals and context blocks as text sources,
 *                                                     task and instructions as a distillation
 *   RePrompter .json  HCG RePrompter backup        → prompts with their original and enhanced revisions
 * Nothing is guessed during migration; what was and was not carried over is recorded in migrationNotes.
 */
import JSZip from 'jszip';
import { ProjectSchema as DeckSchema, type BinaryStore } from '../shared/model';
import { loadProject as loadDeckProject } from '../project/projectFile';
import { bytesToBlob } from '../shared/util';
import {
  ClarityProjectSchema,
  emptyClarityProject,
  newIdLocal,
  nowIso,
  type ClarityProject,
  type Distillation,
  type PromptDoc,
  type Revision,
  type Source,
} from './model';
import { sha256Hex, textSourceFromBytes } from './sources';

export const CLARITY_EXTENSION = '.clarity';
export const MAX_PROJECT_BYTES = 1024 * 1024 * 1024;

export interface LoadedClarity {
  project: ClarityProject;
  store: BinaryStore;
  warnings: string[];
  /** Set when the file came from an older application and was converted. */
  migratedFrom: 'presentation-studio' | 'distil' | 'reprompter' | null;
}

/** Every id whose bytes belong in the file. */
function binaryIds(p: ClarityProject): { id: string; label: string }[] {
  const ids = new Map<string, string>();
  for (const s of p.sources) ids.set(s.id, `source "${s.name}"`);
  for (const a of p.deck.assets) ids.set(a.id, `image "${a.name}"`);
  for (const s of p.deck.slides) if (s.narration) ids.set(s.narration.audioId, `narration for "${s.title || s.id}"`);
  for (const o of p.outputs) ids.set(o.id, `output "${o.fileName}"`);
  return [...ids].map(([id, label]) => ({ id, label }));
}

export async function saveClarityProject(project: ClarityProject, store: BinaryStore): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('clarity.json', JSON.stringify(project, null, 2));
  for (const { id, label } of binaryIds(project)) {
    const blob = store.get(id);
    if (!blob) {
      // Narration audio and outputs can be regenerated; sources and images cannot.
      if (project.sources.some((s) => s.id === id) || project.deck.assets.some((a) => a.id === id)) {
        throw new Error(`The ${label} is missing its data and cannot be saved.`);
      }
      continue;
    }
    zip.file(`files/${id}`, new Uint8Array(await blob.arrayBuffer()), { binary: true });
  }
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

async function toBytes(data: Uint8Array | ArrayBuffer | Blob): Promise<Uint8Array> {
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

function isZip(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

/** Opens a .clarity file, or migrates a supported older file. Never mutates anything on failure. */
export async function loadClarityProject(data: Uint8Array | ArrayBuffer | Blob, fileName = 'project'): Promise<LoadedClarity> {
  const bytes = await toBytes(data);
  if (bytes.byteLength > MAX_PROJECT_BYTES) throw new Error('The file is larger than 1 GB.');
  if (isZip(bytes)) {
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(bytes);
    } catch {
      throw new Error('This file is not an HCG Clarity project (the archive is damaged).');
    }
    if (zip.file('clarity.json')) return loadClarityZip(zip);
    if (zip.file('project.json')) return migratePresentationStudio(bytes, fileName);
    throw new Error('This file is not an HCG Clarity project (clarity.json is missing).');
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('This file is not an HCG Clarity project, a Presentation Studio project, a Distil project or an HCG RePrompter backup.');
  }
  if (json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    if (o.format === 'hcg-reprompter-backup') return migrateRePrompter(o);
    if (typeof o.schemaVersion === 'number' && 'draft' in o && 'library' in o) return migrateDistil(o, fileName);
  }
  throw new Error('This JSON file is not a Distil project or an HCG RePrompter backup.');
}

async function loadClarityZip(zip: JSZip): Promise<LoadedClarity> {
  let json: unknown;
  try {
    json = JSON.parse(await zip.file('clarity.json')!.async('string'));
  } catch {
    throw new Error('clarity.json is not valid JSON.');
  }
  const version = (json as { version?: unknown })?.version;
  if (typeof version === 'number' && version > 1) throw new Error(`This project was saved by a newer version of HCG Clarity (format ${version}).`);
  const parsed = ClarityProjectSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new Error(`The project file is not in a supported format (${first.path.join('.') || 'root'}: ${first.message}).`);
  }
  const project = parsed.data;
  const store: BinaryStore = new Map();
  const warnings: string[] = [];
  const mimeOf = (id: string) =>
    project.sources.find((s) => s.id === id)?.mime ??
    project.deck.assets.find((a) => a.id === id)?.mime ??
    project.outputs.find((o) => o.id === id)?.mime ??
    project.deck.slides.find((s) => s.narration?.audioId === id)?.narration?.mime ??
    'application/octet-stream';
  const missing = new Set<string>();
  for (const { id, label } of binaryIds(project)) {
    const f = zip.file(`files/${id}`);
    if (!f) {
      missing.add(id);
      warnings.push(`The ${label} was missing from the file.`);
      continue;
    }
    store.set(id, bytesToBlob(await f.async('uint8array'), mimeOf(id)));
  }
  // Check originals against their recorded SHA-256, so a changed source is reported, not trusted.
  for (const s of project.sources) {
    const blob = store.get(s.id);
    if (!blob) continue;
    const hash = await sha256Hex(new Uint8Array(await blob.arrayBuffer()));
    if (hash !== s.sha256) warnings.push(`Source "${s.name}" does not match its recorded checksum; its original may have been altered outside HCG Clarity.`);
  }
  if (missing.size) {
    project.sources = project.sources.filter((s) => !missing.has(s.id));
    project.deck.assets = project.deck.assets.filter((a) => !missing.has(a.id));
    for (const s of project.deck.slides) {
      if (s.image && missing.has(s.image.assetId)) s.image = null;
      if (s.narration && missing.has(s.narration.audioId)) s.narration = null;
    }
    project.outputs = project.outputs.filter((o) => !missing.has(o.id));
  }
  return { project, store, warnings, migratedFrom: null };
}

// ---- Migration: Presentation Studio ------------------------------------------

async function migratePresentationStudio(bytes: Uint8Array, fileName: string): Promise<LoadedClarity> {
  const loaded = await loadDeckProject(bytes);
  const project = emptyClarityProject();
  project.title = loaded.project.title || fileName.replace(/\.[^.]+$/, '');
  project.deck = DeckSchema.parse(loaded.project);
  for (const a of loaded.project.assets) {
    const blob = loaded.store.get(a.id);
    if (!blob) continue;
    project.sources.push({
      id: a.id,
      name: a.name,
      kind: 'image',
      mime: a.mime,
      bytes: a.bytes,
      sha256: await sha256Hex(new Uint8Array(await blob.arrayBuffer())),
      origin: 'migrated',
      addedAt: nowIso(),
      text: '',
      width: a.width,
      height: a.height,
      note: a.caption,
    });
  }
  project.migrationNotes = [
    `Converted from the Presentation Studio project "${fileName}". The deck, its images, speaker notes and narration audio were kept unchanged; the images also appear under Sources.`,
  ];
  return { project, store: loaded.store, warnings: loaded.warnings, migratedFrom: 'presentation-studio' };
}

// ---- Migration: Distil ---------------------------------------------------------

const DISTIL_STRATEGY: Record<string, Distillation['strategy']> = {
  baseline: 'full',
  exactDeduplication: 'dedupe',
  budgetSelection: 'priority',
  taskRelevance: 'relevance',
};

async function migrateDistil(o: Record<string, unknown>, fileName: string): Promise<LoadedClarity> {
  if (o.schemaVersion !== 3) {
    throw new Error(`This Distil project uses schema ${String(o.schemaVersion)}. Open and save it once in Distil 0.5, then open it here (schema 3 is supported).`);
  }
  const project = emptyClarityProject();
  project.title = fileName.replace(/\.[^.]+$/, '') || 'Distil project';
  const store: BinaryStore = new Map();
  const warnings: string[] = [];
  const enc = new TextEncoder();
  const addText = async (name: string, text: string): Promise<Source | null> => {
    const b = enc.encode(text);
    try {
      const s = await textSourceFromBytes(name, b, 'migrated');
      store.set(s.id, bytesToBlob(b, s.mime));
      project.sources.push(s);
      return s;
    } catch (e) {
      warnings.push((e as Error).message);
      return null;
    }
  };
  const pasted = Array.isArray(o.pastedSources) ? (o.pastedSources as { id?: string; title?: string; text?: string }[]) : [];
  const pastedIds = new Set<string>();
  for (const p of pasted) {
    if (typeof p.text !== 'string') continue;
    if (p.id) pastedIds.add(p.id);
    await addText(p.title || 'Pasted original', p.text);
  }
  const draft = (o.draft ?? {}) as { task?: string; instructions?: string; blocks?: { title?: string; text?: string; pastedSourceID?: string }[] };
  let looseBlocks = 0;
  for (const b of draft.blocks ?? []) {
    // Blocks cut from a pasted original are already covered by that original.
    if (b.pastedSourceID && pastedIds.has(b.pastedSourceID)) continue;
    if (typeof b.text !== 'string' || !b.text.trim()) continue;
    if (await addText(b.title || 'Context block', b.text)) looseBlocks++;
  }
  const settings = (o.settings ?? {}) as { strategy?: string; budget?: number; deduplicateBeforeBudget?: boolean };
  const t = nowIso();
  if (project.sources.length || draft.task || draft.instructions) {
    project.distillations.push({
      id: newIdLocal('dst'),
      title: 'Migrated from Distil',
      createdAt: t,
      updatedAt: t,
      sourceIds: project.sources.map((s) => s.id),
      splitMode: 'split',
      task: draft.task ?? '',
      instructions: draft.instructions ?? '',
      strategy: DISTIL_STRATEGY[settings.strategy ?? ''] ?? 'relevance',
      budget: typeof settings.budget === 'number' && settings.budget > 0 ? Math.round(settings.budget) : 2000,
      dedupe: settings.deduplicateBeforeBudget ?? true,
      excerpts: [],
      aiNotes: null,
    });
  }
  project.migrationNotes = [
    `Converted from the Distil project "${fileName}": ${pasted.length} pasted original(s) and ${looseBlocks} other context block(s) became text sources; the task, instructions, strategy and budget became a distillation.`,
    'Not carried over: experiments, recorded answers, evaluations and the context library. Excerpts are re-cut from the sources when you open the distillation, so block-level Required marks must be set again.',
  ];
  return { project, store, warnings, migratedFrom: 'distil' };
}

// ---- Migration: HCG RePrompter -----------------------------------------------------

/** Swift's default JSONEncoder date: seconds since 2001-01-01T00:00:00Z. ISO strings are accepted too. */
function swiftDate(v: unknown): string {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(Date.UTC(2001, 0, 1) + v * 1000).toISOString();
  if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return nowIso();
}

function migrateRePrompter(o: Record<string, unknown>): LoadedClarity {
  if (typeof o.schemaVersion === 'number' && o.schemaVersion > 1) throw new Error(`This backup was created by a newer version of HCG RePrompter (schema ${o.schemaVersion}).`);
  const records = Array.isArray(o.records) ? (o.records as Record<string, unknown>[]) : [];
  const project = emptyClarityProject();
  project.title = 'Prompts from HCG RePrompter';
  let enhanced = 0;
  for (const r of records.slice(0, 10_000)) {
    if (typeof r.originalPrompt !== 'string') continue;
    const created = swiftDate(r.createdAt);
    const updated = swiftDate(r.updatedAt ?? r.createdAt);
    const original: Revision = {
      id: newIdLocal('rev'),
      createdAt: created,
      kind: 'original',
      text: r.originalPrompt,
      parentId: null,
      summary: 'Imported from HCG RePrompter.',
      changes: [],
      warnings: [],
      mode: null,
      model: null,
    };
    const revisions: Revision[] = [original];
    if (typeof r.enhancedPrompt === 'string' && r.enhancedPrompt.trim() && r.status !== 'rejected') {
      enhanced++;
      revisions.push({
        id: newIdLocal('rev'),
        createdAt: updated,
        kind: 'ai',
        text: r.enhancedPrompt,
        parentId: original.id,
        summary: `Enhanced prompt imported from HCG RePrompter (status: ${String(r.status ?? 'unknown')}).`,
        changes: [],
        warnings: [],
        mode: typeof r.mode === 'string' ? r.mode : null,
        model: null,
      });
    }
    const doc: PromptDoc = {
      id: newIdLocal('prm'),
      title: typeof r.title === 'string' && r.title.trim() ? r.title : 'Imported prompt',
      createdAt: created,
      updatedAt: updated,
      distillationId: null,
      revisions,
      currentRevisionId: revisions[revisions.length - 1].id,
    };
    project.prompts.push(doc);
  }
  project.migrationNotes = [
    `Imported ${project.prompts.length} prompt(s) from an HCG RePrompter backup, ${enhanced} with an enhanced revision.`,
    'Not carried over: collections, user templates and the enhancement reports. Rejected enhancements were left out.',
  ];
  return { project, store: new Map(), warnings: [], migratedFrom: 'reprompter' };
}
