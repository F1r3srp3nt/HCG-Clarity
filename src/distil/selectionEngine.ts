// Ported from The Last Sprint — distil/Sources/TokenLabCore/SelectionEngine.swift (commit 03cc61d)
// Behaviour change: report-derived values (overBudget, budgetSummary, outcome, …) are computed once when
// the report is made and stored on it, and the report holds copies of its inputs.

import type { ContextBlock, ContextCategory, Draft, SelectionSettings } from './models';
import {
  CancellationError,
  ContextPriority,
  LabError,
  copyDraft,
  settingsDeduplicate,
  settingsEnforceBudget,
  validateSettings,
} from './models';
import type { RankerDescriptor, RelevanceRanker, RelevanceScore } from './relevance';
import { KeywordOverlapRanker } from './relevance';
import type { TokenCounter, TokenCounterDescriptor } from './tokenCounting';
import { countJoined } from './tokenCounting';
import { deepEqual, graphemes, utf8Length } from './text';

/**
 * - `required`: required context, always kept verbatim.
 * - `retained`: optional context kept by the strategy.
 * - `emptySkipped`: empty text contributes nothing to the prompt.
 * - `duplicateRemoved`: optional context byte-identical to retained text (only when deduplication is active).
 * - `excludedByBudget`: optional context that did not fit the budget.
 */
export type DecisionKind = 'required' | 'retained' | 'emptySkipped' | 'duplicateRemoved' | 'excludedByBudget';

export function decisionKindKept(kind: DecisionKind): boolean {
  return kind === 'required' || kind === 'retained';
}

export interface BlockDecision {
  id: string;
  title: string;
  category: ContextCategory;
  priority: number;
  required: boolean;
  kind: DecisionKind;
  /** `decisionKindKept(kind)`. */
  kept: boolean;
  /** Human-readable explanation of why the block was kept or removed. */
  reason: string;
  /** Tokens of this block's text on its own, with the report's counter. */
  standaloneTokens: number;
  /** For removed duplicates: the block whose identical text was kept (absent if it matched the task or instructions). */
  duplicateOf?: string;
  /** Keyword relevance (task-relevance strategy only). */
  relevance?: RelevanceScore;
  /** 1-based position in which the strategy considered this optional block (budget strategies only). */
  considerationRank?: number;
}

/** What a selection run actually did, in plain terms. An unchanged prompt is never described as optimised. */
export type SelectionOutcome =
  /** No context block has text: the prompt is only the task and instructions. */
  | { kind: 'noContext' }
  /** The full-context strategy kept everything by design. */
  | { kind: 'fullContextRetained' }
  /** A reducing strategy ran but removed nothing. */
  | { kind: 'nothingRemoved' }
  /** Only exact duplicates were removed. */
  | { kind: 'duplicatesRemoved'; count: number }
  /** Optional blocks were left out because of the budget (plus any duplicates removed). */
  | { kind: 'excludedForBudget'; excluded: number; duplicates: number }
  /** Task, instructions and required blocks alone are over the budget; they were kept intact. */
  | { kind: 'protectedExceedsBudget'; overBy: number; excluded: number };

export function outcomeTitle(outcome: SelectionOutcome): string {
  switch (outcome.kind) {
    case 'noContext':
      return 'No context to optimise';
    case 'fullContextRetained':
      return 'Full context: everything retained';
    case 'nothingRemoved':
      return 'Nothing removed by this strategy';
    case 'duplicatesRemoved':
      return 'Exact duplicates removed';
    case 'excludedForBudget':
      return 'Optional context excluded for the budget';
    case 'protectedExceedsBudget':
      return 'Protected content exceeds the budget';
  }
}

function capitalizedFirst(s: string): string {
  const chars = graphemes(s);
  return chars.length === 0 ? s : chars[0].toUpperCase() + chars.slice(1).join('');
}

export function outcomeExplanation(outcome: SelectionOutcome): string {
  const blocks = (n: number): string => `${n} optional block${n === 1 ? '' : 's'}`;
  switch (outcome.kind) {
    case 'noContext':
      return 'There are no context blocks with text, so the prompt is just the task and instructions.';
    case 'fullContextRetained':
      return 'This strategy keeps every block. Use it as the reference when comparing answers.';
    case 'nothingRemoved':
      return 'Every context block was kept, so the prepared prompt is the same as the full-context prompt.';
    case 'duplicatesRemoved': {
      const n = outcome.count;
      return `${capitalizedFirst(blocks(n))} ${n === 1 ? 'was a byte-for-byte copy' : 'were byte-for-byte copies'} of kept text. Nothing else was removed.`;
    }
    case 'excludedForBudget': {
      const { excluded, duplicates } = outcome;
      const dup = duplicates > 0 ? ` ${duplicates} exact duplicate${duplicates === 1 ? ' was' : 's were'} also removed.` : '';
      return `${capitalizedFirst(blocks(excluded))} did not fit the budget and ${excluded === 1 ? 'was' : 'were'} left out whole, not shortened.${dup} Check them for information the task needs.`;
    }
    case 'protectedExceedsBudget':
      return `The task, instructions and required blocks alone are ${outcome.overBy} over the budget. They were kept intact and all optional context was left out.`;
  }
}

/** True when the prepared prompt differs from the full-context prompt. */
export function outcomeRemovedContext(outcome: SelectionOutcome): boolean {
  switch (outcome.kind) {
    case 'noContext':
    case 'fullContextRetained':
    case 'nothingRemoved':
      return false;
    case 'duplicatesRemoved':
    case 'excludedForBudget':
      return true;
    case 'protectedExceedsBudget':
      return outcome.excluded > 0;
  }
}

/** A complete, reproducible record of one selection run. Treat it as an immutable snapshot. */
export interface SelectionReport {
  engineVersion: string;
  input: Draft;
  settings: SelectionSettings;
  counter: TokenCounterDescriptor;
  /** Instructions, all non-empty context and the task: the full-context prompt. */
  originalPrompt: string;
  /** Instructions, retained context in original order, and the task: the prepared prompt. */
  selectedPrompt: string;
  originalTokens: number;
  selectedTokens: number;
  /** Tokens for instructions, task and required context alone (assembled). */
  protectedTokens: number;
  decisions: BlockDecision[];
  /** Tokens of the task and the instructions on their own. */
  taskTokens: number;
  instructionsTokens: number;
  /** Ranking details (task-relevance strategy only). */
  ranker?: RankerDescriptor;
  taskTerms?: string[];
  relevanceNote?: string;

  // Derived (Swift computed properties), stored when the report is made.
  budget: number;
  budgetEnforced: boolean;
  /** How far the selected prompt exceeds the budget (0 when within it). */
  overBudgetBy: number;
  overBudget: boolean;
  /** True when protected content alone is larger than the budget. */
  protectedExceedsBudget: boolean;
  /** Estimated reduction with this report's counter. Not provider usage and not a cost saving. */
  estimatedReduction: number;
  /** `undefined` when the original prompt has 0 tokens. */
  estimatedReductionPercent?: number;
  keptCount: number;
  removedCount: number;
  /** One-sentence honest summary of the budget situation. */
  budgetSummary: string;
  outcome: SelectionOutcome;
}

export const currentEngineVersion = 'selection-engine-3';
export const promptSeparator = '\n\n';

/** Whether this report was produced from exactly these inputs and counter. Used to hide stale previews. */
export function isReportCurrent(
  report: SelectionReport,
  draft: Draft,
  settings: SelectionSettings,
  counter: TokenCounterDescriptor,
): boolean {
  return (
    report.engineVersion === currentEngineVersion &&
    deepEqual(report.input, draft) &&
    deepEqual(report.settings, settings) &&
    deepEqual(report.counter, counter)
  );
}

export interface RunOptions {
  /** Defaults to `new KeywordOverlapRanker()`. */
  ranker?: RelevanceRanker;
  /** Polled during the run; returning true throws `CancellationError`. */
  isCancelled?: () => boolean;
}

function parts(draft: Draft, keeping?: ReadonlySet<string>): string[] {
  return [draft.instructions, ...draft.blocks.filter((b) => !keeping || keeping.has(b.id)).map((b) => b.text), draft.task].filter(
    (p) => p.length > 0,
  );
}

function format2(value: number): string {
  // Swift String(format: "%.2f") rounds the exact binary value; an exact tie goes to even.
  // toFixed also rounds the exact binary value but sends ties up, so ties are handled here.
  const abs = Math.abs(value);
  if (Number.isInteger(abs * 8) && !Number.isInteger(abs * 100)) {
    const floor = Math.floor(abs * 100);
    const cents = floor % 2 === 0 ? floor : floor + 1;
    const text = `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
    return value < 0 ? `-${text}` : text;
  }
  return value.toFixed(2);
}

function relevanceExplanation(block: ContextBlock, score: RelevanceScore | undefined, rank: number, total: number, ties: number): string {
  const value = score?.score ?? 0;
  let text: string;
  if (score && score.matchedTerms.length > 0) {
    text = `relevance ${format2(value)} from ${score.matchedTerms.map((t) => t.term).join(', ')}; considered ${rank} of ${total}`;
  } else {
    text = `relevance 0 (no task terms found; considered after every matching block, ${rank} of ${total})`;
  }
  if (ties > 0) {
    text += `; tied with ${ties} other block${ties === 1 ? '' : 's'}, so manual priority (${ContextPriority.label(block.priority).toLowerCase()}) then prompt order decided`;
  }
  return text;
}

function budgetSummaryFor(r: {
  counter: TokenCounterDescriptor;
  budgetEnforced: boolean;
  protectedExceedsBudget: boolean;
  protectedTokens: number;
  budget: number;
  selectedTokens: number;
  overBudget: boolean;
  overBudgetBy: number;
}): string {
  const unit = r.counter.kind === 'approximation' ? 'estimated tokens' : `${r.counter.encoding} tokens`;
  if (r.budgetEnforced) {
    if (r.protectedExceedsBudget) {
      return `Protected content alone (task, instructions and required blocks) is ${r.protectedTokens} ${unit}, ${r.protectedTokens - r.budget} over the budget of ${r.budget}. It was kept intact and not truncated; all optional context was excluded.`;
    }
    return `The whole assembled prompt is ${r.selectedTokens} of ${r.budget} ${unit}.`;
  }
  if (r.overBudget) {
    return `This strategy does not apply the budget. The assembled prompt is ${r.selectedTokens} ${unit}, ${r.overBudgetBy} over the budget of ${r.budget}.`;
  }
  return `This strategy does not apply the budget. The assembled prompt is ${r.selectedTokens} ${unit}, within the budget of ${r.budget}.`;
}

/**
 * Deterministic, explainable context selection. Pure: same inputs, counter and ranker always give the
 * same report. Ranking (`RelevanceRanker`) and counting (`TokenCounter`) are injected, not built in.
 */
export const SelectionEngine = {
  maxBlocks: 500,
  maxTextBytes: 2_000_000,

  validate(draft: Draft): void {
    if (draft.blocks.length > SelectionEngine.maxBlocks) {
      throw new LabError('invalid', `A workspace supports up to ${SelectionEngine.maxBlocks} context blocks.`);
    }
    if (new Set(draft.blocks.map((b) => b.id)).size !== draft.blocks.length) {
      throw new LabError('invalid', 'Context block identifiers must be unique.');
    }
    const bad = draft.blocks.find(
      (b) => !Number.isInteger(b.priority) || b.priority < ContextPriority.range.min || b.priority > ContextPriority.range.max,
    );
    if (bad) {
      throw new LabError('invalid', `Priority must be between 1 and 3 (block “${bad.title}” has ${bad.priority}).`);
    }
    const bytes =
      utf8Length(draft.task) + utf8Length(draft.instructions) + draft.blocks.reduce((sum, b) => sum + utf8Length(b.text), 0);
    if (bytes > SelectionEngine.maxTextBytes) {
      throw new LabError('invalid', 'Workspace text is limited to 2 MB in this prototype.');
    }
  },

  /**
   * Assemble a prompt: protected instructions, then the kept blocks in their original order, then the task.
   * Parts are joined with a blank line; no text is added, removed or reformatted. Omit `kept` to keep all.
   */
  assemble(draft: Draft, kept?: ReadonlySet<string>): string {
    return parts(draft, kept).join(promptSeparator);
  },

  run(draft: Draft, settings: SelectionSettings, counter: TokenCounter, options: RunOptions = {}): SelectionReport {
    const ranker = options.ranker ?? new KeywordOverlapRanker();
    const isCancelled = options.isCancelled ?? (() => false);
    SelectionEngine.validate(draft);
    validateSettings(settings);

    const blocks = draft.blocks;
    const title = (b: ContextBlock): string => (b.title.length === 0 ? 'Untitled context' : b.title);
    const kinds = new Map<string, DecisionKind>();
    const reasons = new Map<string, string>();
    const duplicateOf = new Map<string, string>();
    const ranks = new Map<string, number>();

    // 1. Empty and required blocks are decided the same way under every strategy.
    for (const block of blocks) {
      if (block.text.length === 0) {
        kinds.set(block.id, 'emptySkipped');
        reasons.set(block.id, 'Skipped: the block is empty and adds no text.');
      } else if (block.required) {
        kinds.set(block.id, 'required');
        reasons.set(
          block.id,
          settings.strategy === 'taskRelevance'
            ? 'Kept: marked required, preserved verbatim. Relevance is shown for information only.'
            : 'Kept: marked required, preserved verbatim.',
        );
      }
    }
    const optional = blocks.map((element, offset) => ({ offset, element })).filter((e) => !kinds.has(e.element.id));

    // 2. Optional exact deduplication (code-unit comparison = byte comparison; no Unicode normalisation).
    if (settingsDeduplicate(settings)) {
      const requiredByText = new Map<string, ContextBlock>();
      for (const block of blocks) {
        if (block.required && block.text.length > 0 && !requiredByText.has(block.text)) requiredByText.set(block.text, block);
      }
      // Keep the highest-priority optional copy; ties keep the earliest.
      const ordered = [...optional].sort((a, b) =>
        a.element.priority !== b.element.priority ? b.element.priority - a.element.priority : a.offset - b.offset,
      );
      const keptCopy = new Map<string, ContextBlock>();
      for (const { element: block } of ordered) {
        const key = block.text;
        const original = requiredByText.get(key);
        const earlier = keptCopy.get(key);
        if (draft.task.length > 0 && key === draft.task) {
          kinds.set(block.id, 'duplicateRemoved');
          reasons.set(block.id, 'Removed: exact duplicate of the task.');
        } else if (draft.instructions.length > 0 && key === draft.instructions) {
          kinds.set(block.id, 'duplicateRemoved');
          reasons.set(block.id, 'Removed: exact duplicate of the protected instructions.');
        } else if (original) {
          kinds.set(block.id, 'duplicateRemoved');
          duplicateOf.set(block.id, original.id);
          reasons.set(block.id, `Removed: exact duplicate of required block “${title(original)}”.`);
        } else if (earlier) {
          kinds.set(block.id, 'duplicateRemoved');
          duplicateOf.set(block.id, earlier.id);
          const why = earlier.priority > block.priority ? 'higher priority' : 'same priority, earlier in the prompt';
          reasons.set(block.id, `Removed: exact duplicate of “${title(earlier)}”, which was kept (${why}).`);
        } else {
          keptCopy.set(key, block);
        }
      }
    }

    // 3. Relevance scores (task-relevance strategy only). Ranking never edits or selects text itself.
    let relevance = new Map<string, RelevanceScore>();
    let taskTerms: string[] | undefined;
    let relevanceNote: string | undefined;
    if (settings.strategy === 'taskRelevance') {
      relevance = ranker.scores(draft.task, blocks);
      const terms = ranker.taskTerms(draft.task);
      taskTerms = terms;
      if (terms.length === 0) {
        relevanceNote =
          'The task has no usable terms, so every block scores 0. Optional blocks were considered in manual-priority order, then prompt order.';
      } else if (optional.every((e) => (relevance.get(e.element.id)?.score ?? 0) === 0)) {
        relevanceNote =
          'No optional block contains any task term. Optional blocks were considered in manual-priority order, then prompt order.';
      }
    }

    // 4. Strategy-specific selection of the remaining optional blocks.
    const remaining = optional.filter((e) => !kinds.has(e.element.id));
    switch (settings.strategy) {
      case 'baseline':
        for (const { element: block } of remaining) {
          kinds.set(block.id, 'retained');
          reasons.set(block.id, 'Kept: the full-context strategy retains all context.');
        }
        break;
      case 'exactDeduplication':
        for (const { element: block } of remaining) {
          kinds.set(block.id, 'retained');
          reasons.set(block.id, 'Kept: no exact duplicate of this text is retained elsewhere.');
        }
        break;
      case 'budgetSelection':
      case 'taskRelevance': {
        const byRelevance = settings.strategy === 'taskRelevance';
        const score = (b: ContextBlock): number => relevance.get(b.id)?.score ?? 0;
        const candidates = [...remaining].sort((a, b) => {
          if (byRelevance && score(a.element) !== score(b.element)) return score(b.element) - score(a.element);
          if (a.element.priority !== b.element.priority) return b.element.priority - a.element.priority;
          return a.offset - b.offset;
        });
        const kept = new Set(blocks.filter((b) => kinds.get(b.id) === 'required').map((b) => b.id));
        const protectedTokens = countJoined(counter, parts(draft, kept), promptSeparator);
        candidates.forEach(({ element: block }, position) => {
          if (isCancelled()) throw new CancellationError();
          ranks.set(block.id, position + 1);
          const because = byRelevance
            ? relevanceExplanation(
                block,
                relevance.get(block.id),
                position + 1,
                candidates.length,
                candidates.filter((c) => c.element.id !== block.id && score(c.element) === score(block)).length,
              )
            : `${ContextPriority.label(block.priority).toLowerCase()} priority`;
          if (protectedTokens > settings.budget) {
            kinds.set(block.id, 'excludedByBudget');
            reasons.set(
              block.id,
              `Excluded: ${because}; protected content alone (${protectedTokens}) already exceeds the budget of ${settings.budget}.`,
            );
            return;
          }
          kept.add(block.id);
          const total = countJoined(counter, parts(draft, kept), promptSeparator);
          if (total <= settings.budget) {
            kinds.set(block.id, 'retained');
            reasons.set(block.id, `Kept: ${because}; assembled prompt ${total} of ${settings.budget} after adding it.`);
          } else {
            kept.delete(block.id);
            kinds.set(block.id, 'excludedByBudget');
            reasons.set(
              block.id,
              `Excluded: ${because}; adding it would make the assembled prompt ${total}, over the budget of ${settings.budget}. The block was not shortened.`,
            );
          }
        });
        break;
      }
    }

    if (isCancelled()) throw new CancellationError();
    const keptIDs = new Set(blocks.filter((b) => decisionKindKept(kinds.get(b.id) as DecisionKind)).map((b) => b.id));
    const requiredIDs = new Set(blocks.filter((b) => kinds.get(b.id) === 'required').map((b) => b.id));
    const originalParts = parts(draft, undefined);
    const selectedParts = parts(draft, keptIDs);
    const decisions: BlockDecision[] = blocks.map((block) => {
      const kind = kinds.get(block.id) as DecisionKind;
      const decision: BlockDecision = {
        id: block.id,
        title: title(block),
        category: block.category,
        priority: block.priority,
        required: block.required,
        kind,
        kept: decisionKindKept(kind),
        reason: reasons.get(block.id) as string,
        standaloneTokens: counter.count(block.text),
      };
      const dup = duplicateOf.get(block.id);
      if (dup !== undefined) decision.duplicateOf = dup;
      const rel = relevance.get(block.id);
      if (rel !== undefined) decision.relevance = rel;
      const rank = ranks.get(block.id);
      if (rank !== undefined) decision.considerationRank = rank;
      return decision;
    });

    const originalTokens = countJoined(counter, originalParts, promptSeparator);
    const selectedTokens = countJoined(counter, selectedParts, promptSeparator);
    const protectedTokens = countJoined(counter, parts(draft, requiredIDs), promptSeparator);
    const budget = settings.budget;
    const budgetEnforced = settingsEnforceBudget(settings);
    const overBudgetBy = Math.max(0, selectedTokens - budget);
    const protectedExceedsBudget = protectedTokens > budget;
    const descriptor = counter.descriptor;
    const excluded = decisions.filter((d) => d.kind === 'excludedByBudget').length;
    const duplicates = decisions.filter((d) => d.kind === 'duplicateRemoved').length;
    let outcome: SelectionOutcome;
    if (budgetEnforced && protectedExceedsBudget) {
      outcome = { kind: 'protectedExceedsBudget', overBy: protectedTokens - budget, excluded };
    } else if (decisions.every((d) => d.kind === 'emptySkipped')) {
      outcome = { kind: 'noContext' };
    } else if (settings.strategy === 'baseline') {
      outcome = { kind: 'fullContextRetained' };
    } else if (excluded > 0) {
      outcome = { kind: 'excludedForBudget', excluded, duplicates };
    } else if (duplicates > 0) {
      outcome = { kind: 'duplicatesRemoved', count: duplicates };
    } else {
      outcome = { kind: 'nothingRemoved' };
    }

    const report: SelectionReport = {
      engineVersion: currentEngineVersion,
      input: copyDraft(draft),
      settings: { ...settings, counter: { ...settings.counter } },
      counter: descriptor,
      originalPrompt: originalParts.join(promptSeparator),
      selectedPrompt: selectedParts.join(promptSeparator),
      originalTokens,
      selectedTokens,
      protectedTokens,
      decisions,
      taskTokens: counter.count(draft.task),
      instructionsTokens: counter.count(draft.instructions),
      budget,
      budgetEnforced,
      overBudgetBy,
      overBudget: overBudgetBy > 0,
      protectedExceedsBudget,
      estimatedReduction: originalTokens - selectedTokens,
      keptCount: decisions.filter((d) => d.kept).length,
      removedCount: decisions.filter((d) => !d.kept && d.kind !== 'emptySkipped').length,
      budgetSummary: budgetSummaryFor({
        counter: descriptor,
        budgetEnforced,
        protectedExceedsBudget,
        protectedTokens,
        budget,
        selectedTokens,
        overBudget: overBudgetBy > 0,
        overBudgetBy,
      }),
      outcome,
    };
    if (originalTokens !== 0) report.estimatedReductionPercent = ((originalTokens - selectedTokens) / originalTokens) * 100;
    if (settings.strategy === 'taskRelevance') report.ranker = ranker.descriptor;
    if (taskTerms !== undefined) report.taskTerms = taskTerms;
    if (relevanceNote !== undefined) report.relevanceNote = relevanceNote;
    return report;
  },
};

/** Tracks which background calculation is the latest, so an older result can never replace a newer one. */
export class LatestResultGate {
  private current = 0;
  get generation(): number {
    return this.current;
  }
  /** Start a calculation; returns its ticket. */
  begin(): number {
    this.current += 1;
    return this.current;
  }
  /** Make every outstanding ticket stale (for example when inputs change). */
  invalidate(): void {
    this.current += 1;
  }
  isLatest(ticket: number): boolean {
    return ticket === this.current;
  }
}
