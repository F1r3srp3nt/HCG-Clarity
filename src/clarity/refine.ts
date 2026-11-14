/**
 * Glue between Clarity prompt documents (with their revision history) and the ported
 * HCG RePrompter library (src/refine). Revisions are never overwritten: every change, local or
 * AI, adds a revision linked to the one it came from.
 */
import {
  enhanceLocally,
  isEnhancementMode,
  makeExportDocument,
  PromptExporter,
  type EnhancementMode,
  type EnhancementResult,
  type ExportFormat,
} from '../refine';
import { currentRevision, newIdLocal, nowIso, type PromptDoc, type Revision, type RevisionKind } from './model';

export function newPromptDoc(title: string, text: string, kind: RevisionKind = 'original', summary = ''): PromptDoc {
  const t = nowIso();
  const rev: Revision = { id: newIdLocal('rev'), createdAt: t, kind, text, parentId: null, summary, changes: [], warnings: [], mode: null, model: null };
  return { id: newIdLocal('prm'), title: title.trim() || 'Untitled prompt', createdAt: t, updatedAt: t, distillationId: null, revisions: [rev], currentRevisionId: rev.id };
}

/** Appends a revision and makes it current. Returns the new revision. */
export function addRevision(doc: PromptDoc, fields: Omit<Revision, 'id' | 'createdAt' | 'parentId'> & { parentId?: string | null }): Revision {
  const rev: Revision = { id: newIdLocal('rev'), createdAt: nowIso(), parentId: fields.parentId ?? doc.currentRevisionId, ...fields };
  doc.revisions.push(rev);
  doc.currentRevisionId = rev.id;
  doc.updatedAt = rev.createdAt;
  return rev;
}

/** Turns a validated RePrompter result into revision fields. Nothing in the report is dropped silently. */
export function revisionFieldsFromResult(result: EnhancementResult, kind: 'ai' | 'local-format') {
  const r = result.report;
  const warnings = [
    ...result.warnings.map((w) => w.message),
    ...result.preservation.missing.map((a) => `Possibly not preserved (${a.kind}): ${a.value}`),
  ];
  const changes = [
    ...r.structuralChanges,
    ...r.missingInformation.map((q) => `Open question: ${q}`),
    ...r.assumptions.map((a) => `Assumption: ${a}`),
    ...r.optionalSuggestions.map((s) => `Optional suggestion (not applied): ${s}`),
  ];
  return {
    kind,
    text: result.enhancedPrompt,
    summary: r.objective ? `Objective: ${r.objective}` : '',
    changes,
    warnings,
    mode: result.mode,
    model: result.processor.kind === 'ai' ? result.processor.model : null,
  } satisfies Omit<Revision, 'id' | 'createdAt' | 'parentId'>;
}

/** RePrompter's local formatter (no AI, no network) applied to the current revision. */
export function formatLocally(doc: PromptDoc, mode: EnhancementMode = 'structured') {
  const result = enhanceLocally({ originalPrompt: currentRevision(doc).text, mode });
  return revisionFieldsFromResult(result, 'local-format');
}

/** RePrompter's exporter: the first revision is the original, the current one the enhanced prompt. */
export function exportPrompt(doc: PromptDoc, format: ExportFormat, at = new Date()): string {
  const original = doc.revisions[0];
  const current = currentRevision(doc);
  const mode = isEnhancementMode(current.mode) ? current.mode : null;
  const document = makeExportDocument({
    title: doc.title,
    originalPrompt: original.text,
    enhancedPrompt: current.id === original.id ? null : current.text,
    mode,
    exportedAt: at,
  });
  return PromptExporter.export(document, format);
}
