// Ported from The Last Sprint — distil/Sources/TokenLabCore/Comparison.swift (commit 03cc61d)
// Behaviour change: ComparisonMembership and `experiments(from:…)` are not ported (they need Evaluation/Experiment).

import type { Draft, SelectionSettings, SelectionStrategy } from './models';
import { CancellationError, strategyDisplayName } from './models';
import type { RunOptions, SelectionReport } from './selectionEngine';
import { SelectionEngine, isReportCurrent } from './selectionEngine';
import type { TokenCounter, TokenCounterDescriptor } from './tokenCounting';

/** The four fixed configurations compared side by side for the same input. */
export type ComparisonVariant = 'fullContext' | 'exactDeduplication' | 'priorityBudget' | 'relevanceBudget';

export const allComparisonVariants: readonly ComparisonVariant[] = [
  'fullContext',
  'exactDeduplication',
  'priorityBudget',
  'relevanceBudget',
];

export function variantStrategy(variant: ComparisonVariant): SelectionStrategy {
  switch (variant) {
    case 'fullContext':
      return 'baseline';
    case 'exactDeduplication':
      return 'exactDeduplication';
    case 'priorityBudget':
      return 'budgetSelection';
    case 'relevanceBudget':
      return 'taskRelevance';
  }
}

export function variantLabel(variant: ComparisonVariant): string {
  return strategyDisplayName(variantStrategy(variant));
}

export interface ComparisonEntry {
  variant: ComparisonVariant;
  report: SelectionReport;
}

export const Comparison = {
  /**
   * Settings for one variant: the base budget, counter and dedupe-before-budget flag, with the variant's
   * strategy. Only the strategy differs between variants.
   */
  settings(variant: ComparisonVariant, base: SelectionSettings): SelectionSettings {
    return { ...base, counter: { ...base.counter }, strategy: variantStrategy(variant) };
  },

  run(draft: Draft, base: SelectionSettings, counter: TokenCounter, options: RunOptions = {}): ComparisonEntry[] {
    const isCancelled = options.isCancelled ?? (() => false);
    return allComparisonVariants.map((variant) => {
      if (isCancelled()) throw new CancellationError();
      return { variant, report: SelectionEngine.run(draft, Comparison.settings(variant, base), counter, options) };
    });
  },

  isCurrent(entries: ComparisonEntry[], draft: Draft, base: SelectionSettings, counter: TokenCounterDescriptor): boolean {
    return (
      entries.length === allComparisonVariants.length &&
      entries.every((e) => isReportCurrent(e.report, draft, Comparison.settings(e.variant, base), counter))
    );
  },
};
