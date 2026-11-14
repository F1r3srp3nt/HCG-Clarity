/**
 * Glue between the Clarity project model and the ported Distil engine (src/distil).
 * The engine itself is unchanged; this file adds source provenance: every block is an excerpt
 * that records its source and line range, so a reference can always be traced back.
 */
import {
  ApproximateCounter,
  Comparison,
  ContextSplitter,
  makeSettings,
  SelectionEngine,
  type ContextBlock,
  type ContextCategory,
  type Draft,
  type SelectionReport,
  type SelectionStrategy,
} from '../distil';
import { pagesWithOcr } from './extract';
import { hasText, excerptRef, newIdLocal, nowIso, type ClarityProject, type Distillation, type Excerpt, type Source, type StrategyId } from './model';

export const STRATEGY_TO_DISTIL: Record<StrategyId, SelectionStrategy> = {
  full: 'baseline',
  dedupe: 'exactDeduplication',
  priority: 'budgetSelection',
  relevance: 'taskRelevance',
};

export const STRATEGY_LABEL: Record<StrategyId, string> = {
  full: 'Full context',
  dedupe: 'Exact deduplication',
  priority: 'Manual-priority budget',
  relevance: 'Task-relevance budget',
};

/** Cuts text sources into excerpts. Each excerpt is an exact run of whole lines of one source. */
export function cutExcerpts(sources: Source[], mode: Distillation['splitMode']): Excerpt[] {
  const out: Excerpt[] = [];
  for (const s of sources) {
    if (!hasText(s)) continue;
    const blocks = mode === 'whole' ? ContextSplitter.keepAsOneBlock(s.text, s.name) : ContextSplitter.split(s.text);
    for (const b of blocks) {
      out.push({
        id: newIdLocal('exc'),
        sourceId: s.id,
        sourceName: s.name,
        lineStart: b.lineStart,
        lineEnd: b.lineEnd,
        title: b.title || s.name,
        category: b.category,
        priority: 2,
        required: b.required,
        text: b.text,
        pages: s.extraction ? pagesWithOcr(s.extraction, b.lineStart, b.lineEnd) : '',
      });
    }
  }
  return out;
}

/** Checks an excerpt against its source: true when the source still has exactly these lines. */
export function excerptMatchesSource(e: Excerpt, source: Source | undefined): boolean {
  if (!source || !hasText(source)) return false;
  const lines = source.text.split('\n').slice(e.lineStart - 1, e.lineEnd).join('\n');
  // A CRLF source: the splitter leaves out the final "\r" of the last line (as Distil does).
  return lines === e.text || lines === `${e.text}\r`;
}

export function newDistillation(project: ClarityProject, sourceIds: string[]): Distillation {
  const t = nowIso();
  const sources = project.sources.filter((s) => sourceIds.includes(s.id) && hasText(s));
  return {
    id: newIdLocal('dst'),
    title: `Distillation ${project.distillations.length + 1}`,
    createdAt: t,
    updatedAt: t,
    sourceIds,
    splitMode: 'split',
    task: '',
    instructions: '',
    strategy: 'relevance',
    budget: 2000,
    dedupe: true,
    excerpts: cutExcerpts(sources, 'split'),
    aiNotes: null,
  };
}

export function toDraft(d: Distillation): Draft {
  return {
    task: d.task,
    instructions: d.instructions,
    blocks: d.excerpts.map(
      (e): ContextBlock => ({
        id: e.id,
        title: e.title,
        text: e.text,
        category: e.category as ContextCategory,
        priority: e.priority,
        required: e.required,
        pastedSourceID: e.sourceId,
        lineStart: e.lineStart,
        lineEnd: e.lineEnd,
      }),
    ),
  };
}

function settingsFor(d: Distillation) {
  return makeSettings({ strategy: STRATEGY_TO_DISTIL[d.strategy], budget: d.budget, deduplicateBeforeBudget: d.dedupe });
}

const counter = new ApproximateCounter(4);

export function runDistillation(d: Distillation): SelectionReport {
  return SelectionEngine.run(toDraft(d), settingsFor(d), counter);
}

export function compareDistillation(d: Distillation) {
  return Comparison.run(toDraft(d), settingsFor(d), counter);
}

/** Excerpts the report kept, in their original order. */
export function keptExcerpts(d: Distillation, report: SelectionReport): Excerpt[] {
  const kept = new Set(report.decisions.filter((x) => x.kept).map((x) => x.id));
  return d.excerpts.filter((e) => kept.has(e.id));
}

/**
 * Source material for the presentation brief: kept excerpts with their references, and AI notes
 * clearly labelled as derived. Only verified citations are shown as references.
 */
export function deckMaterial(d: Distillation, report: SelectionReport): string {
  const parts: string[] = [];
  for (const e of keptExcerpts(d, report)) parts.push(`[Excerpt — ${excerptRef(e)}]\n${e.text}`);
  if (d.aiNotes) {
    const byId = new Map(d.excerpts.map((e) => [e.id, e]));
    for (const n of d.aiNotes.notes) {
      const refs = n.citations.filter((c) => c.verified && byId.has(c.excerptId)).map((c) => excerptRef(byId.get(c.excerptId)!));
      parts.push(`[AI-derived note${refs.length ? ` — from ${[...new Set(refs)].join('; ')}` : ' — no verified reference'}] ${n.heading}: ${n.text}`);
    }
  }
  return parts.join('\n\n');
}
