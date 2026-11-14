// Ported from The Last Sprint — distil/Sources/TokenLabCore/Models.swift (commit 03cc61d)
// Behaviour change: structs are plain objects built by make…() helpers; identifiers are strings; the BPE
// counter choice, ReviewTemplate and the file-related LabError cases are not ported; blocks may carry
// optional lineStart/lineEnd provenance.

import { newID } from './text';

// MARK: - Context

export const ContextCategory = {
  reference: 'Reference',
  conversation: 'Conversation',
  code: 'Code',
  toolOutput: 'Tool output',
} as const;
export type ContextCategory = (typeof ContextCategory)[keyof typeof ContextCategory];
export const allContextCategories: readonly ContextCategory[] = ['Reference', 'Conversation', 'Code', 'Tool output'];

/** Priority of optional context. Higher numbers are considered first by budget selection. */
export const ContextPriority = {
  low: 1,
  medium: 2,
  high: 3,
  /** Inclusive valid range. */
  range: { min: 1, max: 3 },
  label(value: number): string {
    switch (value) {
      case 1:
        return 'Low';
      case 2:
        return 'Medium';
      case 3:
        return 'High';
      default:
        return `Invalid (${value})`;
    }
  },
} as const;

export interface ContextBlock {
  id: string;
  title: string;
  text: string;
  category: ContextCategory;
  priority: number;
  /** Required blocks are always kept verbatim, regardless of strategy or budget. */
  required: boolean;
  /** When the block was inserted from a context library, the library item it was copied from. */
  libraryOrigin?: string;
  /** When the block came from pasted material, the `PastedSource` that holds the original. */
  pastedSourceID?: string;
  /** Addition to the Swift model: 1-based inclusive line range in the pasted original (see `ContextSplitter`). */
  lineStart?: number;
  lineEnd?: number;
}

/** Swift `ContextBlock.init` defaults: title "Untitled context", empty text, Reference, medium priority, optional. */
export function makeBlock(fields: Partial<ContextBlock> = {}): ContextBlock {
  return {
    id: newID(),
    title: 'Untitled context',
    text: '',
    category: ContextCategory.reference,
    priority: ContextPriority.medium,
    required: false,
    ...fields,
  };
}

/** A copy with a fresh identifier, suitable for inserting elsewhere. */
export function independentCopy(block: ContextBlock, origin?: string): ContextBlock {
  const copy: ContextBlock = { ...block, id: newID() };
  if (origin === undefined) delete copy.libraryOrigin;
  else copy.libraryOrigin = origin;
  return copy;
}

/**
 * The inputs being prepared. Assembled prompt order (see `SelectionEngine.assemble`):
 * protected instructions, then retained context in original order, then the task.
 */
export interface Draft {
  /** The current task or question. Always kept verbatim; placed last in the assembled prompt. */
  task: string;
  /** Protected instructions and constraints. Always kept verbatim; placed first. */
  instructions: string;
  /** Optional or required context in prompt order. Retained blocks keep this order. */
  blocks: ContextBlock[];
}

export function makeDraft(fields: Partial<Draft> = {}): Draft {
  return { task: '', instructions: '', blocks: [], ...fields };
}

/** Value copy of a draft (Swift structs copy on assignment; JS objects do not). */
export function copyDraft(draft: Draft): Draft {
  return { task: draft.task, instructions: draft.instructions, blocks: draft.blocks.map((b) => ({ ...b })) };
}

// MARK: - Selection settings

/**
 * - `baseline`: A. Keep every non-empty block.
 * - `exactDeduplication`: B. Remove only optional blocks whose text is byte-identical to retained text.
 * - `budgetSelection`: C. Choose optional blocks by manual priority until the token budget is reached.
 * - `taskRelevance`: D. Choose optional blocks by local task-term relevance, then priority, until the budget is reached.
 */
export type SelectionStrategy = 'baseline' | 'exactDeduplication' | 'budgetSelection' | 'taskRelevance';

export const allSelectionStrategies: readonly SelectionStrategy[] = [
  'baseline',
  'exactDeduplication',
  'budgetSelection',
  'taskRelevance',
];

export function strategyDisplayName(strategy: SelectionStrategy): string {
  switch (strategy) {
    case 'baseline':
      return 'Full context';
    case 'exactDeduplication':
      return 'Exact deduplication';
    case 'budgetSelection':
      return 'Manual-priority budget';
    case 'taskRelevance':
      return 'Task-relevance budget';
  }
}

/** Compact label for segmented controls. */
export function strategyShortName(strategy: SelectionStrategy): string {
  switch (strategy) {
    case 'baseline':
      return 'Full';
    case 'exactDeduplication':
      return 'Dedupe';
    case 'budgetSelection':
      return 'Priority';
    case 'taskRelevance':
      return 'Relevance';
  }
}

export function strategySummary(strategy: SelectionStrategy): string {
  switch (strategy) {
    case 'baseline':
      return 'Retains all context. Use it as the full-context reference for comparisons.';
    case 'exactDeduplication':
      return 'Removes optional blocks whose text is byte-for-byte identical to the task, the instructions, a required block or a higher-priority copy. Nothing else is removed and the budget is not applied.';
    case 'budgetSelection':
      return 'Keeps required content, then adds optional blocks from highest to lowest manual priority (ties in prompt order) while the whole assembled prompt stays within the budget. Exact deduplication runs first only if enabled.';
    case 'taskRelevance':
      return 'Keeps required content, then adds optional blocks in order of keyword relevance to the task (manual priority, then prompt order, break ties) while the whole assembled prompt stays within the budget. Retained blocks keep their original order. Keyword matching is not semantic understanding.';
  }
}

/** Which token counter is used. Only the labelled approximate counter is ported (Swift also has `.bpe`). */
export interface CounterChoice {
  kind: 'approximate';
  bytesPerToken: number;
}

export const bytesPerTokenRange = { min: 1, max: 8 } as const;

export function approximateCounterChoice(bytesPerToken = 4): CounterChoice {
  return { kind: 'approximate', bytesPerToken };
}

export function validateCounterChoice(choice: CounterChoice): void {
  const n = choice.bytesPerToken;
  if (!Number.isInteger(n) || n < bytesPerTokenRange.min || n > bytesPerTokenRange.max) {
    throw new LabError('invalid', `Approximate counter must use 1–8 bytes per token (found ${n}).`);
  }
}

export function counterChoiceShortName(choice: CounterChoice): string {
  return `Approximate (UTF-8 bytes ÷ ${choice.bytesPerToken})`;
}

export interface SelectionSettings {
  strategy: SelectionStrategy;
  /**
   * Token budget for the whole assembled prompt, measured with the counter. Enforced by the two budget
   * strategies; reported for all strategies.
   */
  budget: number;
  /** Only used by the two budget strategies: remove exact duplicates before selecting by budget. */
  deduplicateBeforeBudget: boolean;
  counter: CounterChoice;
}

export const budgetRange = { min: 1, max: 1_000_000 } as const;

/** Swift `SelectionSettings.init` defaults: budgetSelection, 1000, no dedupe, approximate ÷ 4. */
export function makeSettings(fields: Partial<SelectionSettings> = {}): SelectionSettings {
  return {
    strategy: 'budgetSelection',
    budget: 1000,
    deduplicateBeforeBudget: false,
    counter: approximateCounterChoice(4),
    ...fields,
  };
}

/** Whether this configuration performs exact deduplication. */
export function settingsDeduplicate(settings: SelectionSettings): boolean {
  switch (settings.strategy) {
    case 'baseline':
      return false;
    case 'exactDeduplication':
      return true;
    case 'budgetSelection':
    case 'taskRelevance':
      return settings.deduplicateBeforeBudget;
  }
}

export function settingsEnforceBudget(settings: SelectionSettings): boolean {
  return settings.strategy === 'budgetSelection' || settings.strategy === 'taskRelevance';
}

export function validateSettings(settings: SelectionSettings): void {
  const budget = settings.budget;
  if (!Number.isInteger(budget) || budget < budgetRange.min || budget > budgetRange.max) {
    throw new LabError('invalid', `Budget must be between 1 and 1,000,000 tokens (found ${budget}).`);
  }
  validateCounterChoice(settings.counter);
}

// MARK: - Errors

export type LabErrorKind = 'invalid' | 'counterUnavailable';

/** Swift `LabError` (`.invalid` and `.counterUnavailable` only); `message` is the Swift `errorDescription`. */
export class LabError extends Error {
  readonly kind: LabErrorKind;
  constructor(kind: LabErrorKind, message: string) {
    super(message);
    this.name = 'LabError';
    this.kind = kind;
  }
}

/** Swift `CancellationError`: thrown when `isCancelled()` returns true during a run. */
export class CancellationError extends Error {
  constructor() {
    super('The operation was cancelled.');
    this.name = 'CancellationError';
  }
}
