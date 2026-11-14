// Ported from The Last Sprint — distil/Tests/TokenLabCoreTests/RelevanceAndComparisonTests.swift (commit 03cc61d)
// Relevance and comparison parts only. Tests that need the coding-task demo use the pasted-notes fixture;
// tests that need Evaluation, ProjectCodec or schema migration are not ported (listed as skipped).

import { describe, expect, it } from 'vitest';
import type { ContextBlock, RankerDescriptor, RelevanceRanker, RelevanceScore, SelectionSettings } from '../../src/distil';
import {
  ApproximateCounter,
  CancellationError,
  Comparison,
  KeywordOverlapRanker,
  LatestResultGate,
  SelectionEngine,
  allComparisonVariants,
  allSelectionStrategies,
  copyDraft,
  isReportCurrent,
  isZeroMatch,
  makeBlock,
  makeDraft,
  makeSettings,
} from '../../src/distil';
import { makePastedNotesDemo } from './fixtures/pastedNotes';
import { bytes1, utf8 } from './helpers';

const ranker = new KeywordOverlapRanker();

function relevance(budget = 1000, dedupe = false): SelectionSettings {
  return makeSettings({ strategy: 'taskRelevance', budget, deduplicateBeforeBudget: dedupe, counter: { kind: 'approximate', bytesPerToken: 1 } });
}

describe('RankingTests', () => {
  it('testTermExtraction', () => {
    expect(KeywordOverlapRanker.terms('Fix parseDueDate for the 2026-3-07 case!')).toEqual(['fix', 'parse', 'due', 'date', '2026', '07', 'case']);
    expect(KeywordOverlapRanker.terms('HTTPServer snake_case_name')).toEqual(['httpserver', 'snake', 'case', 'name']);
    // Canonical forms compare equal for ranking only
    expect(KeywordOverlapRanker.terms('café café')).toEqual(['café', 'café']);
    // No stemming: plural is a different term
    expect(ranker.taskTerms('date Date DATE dates')).toEqual(['date', 'dates']);
    expect(ranker.taskTerms('What is the and of it?')).toEqual([]);
  });

  it('testRareTermsWeighMoreAndRepetitionDoesNotCount', () => {
    const a = makeBlock({ text: 'invoice invoice invoice invoice' });
    const b = makeBlock({ text: 'invoice refund' });
    const c = makeBlock({ text: 'invoice shipping' });
    const scores = ranker.scores('refund invoice', [a, b, c]);
    // N = 3; df(invoice) = 3 → weight 1; df(refund) = 1 → weight 1 + ln(4/2).
    expect(scores.get(a.id)?.score).toBe(1.0);
    expect(scores.get(a.id)?.matchedTerms[0]?.occurrences).toBe(4);
    expect(Math.abs((scores.get(b.id)?.score ?? 0) - KeywordOverlapRanker.round3(2 + Math.log(2)))).toBeLessThanOrEqual(0.0005);
    // Contributions follow task-term order
    expect(scores.get(b.id)?.matchedTerms.map((t) => t.term)).toEqual(['refund', 'invoice']);
    expect(scores.get(c.id)?.score).toBe(1.0);
  });

  // Swift uses the coding-task demo (not ported); the pasted-notes demo is used instead.
  it('testRankingIsDeterministic', () => {
    const demo = makePastedNotesDemo();
    expect(ranker.scores(demo.draft.task, demo.draft.blocks)).toEqual(ranker.scores(demo.draft.task, demo.draft.blocks));
  });

  // Port-specific: Unicode letters/digits, title-case and astral scalars.
  it('term extraction is Unicode-aware', () => {
    expect(KeywordOverlapRanker.terms('Ærlig blåbærSyltetøy ９９ x')).toEqual(['ærlig', 'blåbær', 'syltetøy', '９９']);
    // Deseret capitals (astral) lower-case; a single astral letter is one character, so it is too short
    // even though it is two UTF-16 units. Mathematical bold letters have no case mapping (as in Swift).
    expect(KeywordOverlapRanker.terms('\u{10400}\u{10401} \u{10402} ab')).toEqual(['\u{10428}\u{10429}', 'ab']);
    expect(KeywordOverlapRanker.terms('\u{1D400}\u{1D401}')).toEqual(['\u{1D400}\u{1D401}']);
  });
});

describe('TaskRelevanceSelectionTests', () => {
  it('testRelevanceChoosesButOriginalOrderIsKept', () => {
    const draft = makeDraft({
      task: 'alpha beta',
      instructions: 'INSTR',
      blocks: [
        makeBlock({ title: 'noise', text: 'gamma' }),
        makeBlock({ title: 'one match', text: 'alpha' }),
        makeBlock({ title: 'two matches', text: 'alpha beta' }),
      ],
    });
    // Protected: "INSTR\n\nalpha beta" = 17 bytes. +two matches (12) = 29. +one match (7) = 36. +noise (7) = 43.
    const report = SelectionEngine.run(draft, relevance(36), bytes1);
    expect(report.decisions.map((d) => d.considerationRank)).toEqual([3, 2, 1]);
    expect(report.decisions.map((d) => d.kept)).toEqual([false, true, true]);
    // Instructions first, retained blocks in original order, task last
    expect(report.selectedPrompt).toBe('INSTR\n\nalpha\n\nalpha beta\n\nalpha beta');
    expect(report.selectedTokens).toBe(36); // Budget covers the complete assembled prompt
    expect(report.taskTerms).toEqual(['alpha', 'beta']);
    expect(report.ranker?.id).toBe('keyword-overlap-idf');
    // Port-specific: exact reason wording, including the "%.2f" score.
    expect(report.decisions[2].reason).toBe('Kept: relevance 2.98 from alpha, beta; considered 1 of 3; assembled prompt 29 of 36 after adding it.');
  });

  it('testZeroMatchBlocksComeLastButAreKeptWhenTheyFit', () => {
    const draft = makeDraft({
      task: 'alpha',
      blocks: [
        makeBlock({ title: 'zero, high priority', text: 'zzz', priority: 3 }),
        makeBlock({ title: 'match, low priority', text: 'alpha', priority: 1 }),
      ],
    });
    const fits = SelectionEngine.run(draft, relevance(100), bytes1);
    expect(fits.decisions.map((d) => d.considerationRank)).toEqual([2, 1]);
    expect(fits.decisions.map((d) => d.kept)).toEqual([true, true]); // Zero-match blocks are not removed for scoring 0
    expect(fits.decisions[0].reason.includes('no task terms found')).toBe(true);
    expect(fits.decisions[0].relevance ? isZeroMatch(fits.decisions[0].relevance) : false).toBe(true);

    // "alpha\n\nalpha" = 12; adding "zzz" → 17.
    const tight = SelectionEngine.run(draft, relevance(12), bytes1);
    expect(tight.decisions.map((d) => d.kept)).toEqual([false, true]);
    expect(tight.decisions[0].reason.includes('not shortened')).toBe(true);
  });

  it('testTiesAreBrokenByPriorityThenPromptOrderAndExplained', () => {
    const draft = makeDraft({
      task: 'alpha',
      blocks: [
        makeBlock({ title: 'A', text: 'alpha 1', priority: 2 }),
        makeBlock({ title: 'B', text: 'alpha 2', priority: 3 }),
        makeBlock({ title: 'C', text: 'alpha 3', priority: 2 }),
      ],
    });
    const report = SelectionEngine.run(draft, relevance(), bytes1);
    expect(report.decisions.map((d) => d.considerationRank)).toEqual([2, 1, 3]);
    expect(report.decisions.every((d) => d.reason.includes('tied with 2 other blocks'))).toBe(true);
  });

  it('testRequiredBlocksAlwaysRemainEvenWithZeroRelevanceAndOverflow', () => {
    const code = 'func f() {\n\treturn 1   \r\n}';
    const draft = makeDraft({
      task: 'alpha',
      instructions: 'Keep   spacing.\n',
      blocks: [makeBlock({ title: 'Required code', text: code, category: 'Code', required: true }), makeBlock({ title: 'Relevant', text: 'alpha' })],
    });
    const report = SelectionEngine.run(draft, relevance(1), bytes1);
    expect(report.decisions[0].kind).toBe('required');
    // Relevance is still reported for required blocks
    expect(report.decisions[0].relevance ? isZeroMatch(report.decisions[0].relevance) : false).toBe(true);
    expect(report.decisions[1].kind).toBe('excludedByBudget');
    expect(utf8(report.selectedPrompt)).toEqual(utf8('Keep   spacing.\n' + '\n\n' + code + '\n\n' + 'alpha'));
    expect(report.protectedExceedsBudget).toBe(true);
    expect(report.budgetSummary.includes('not truncated')).toBe(true);
  });

  it('testTaskIsProtectedUnderEveryStrategy', () => {
    const task = 'Explain\tthis   exactly.\r\n';
    const draft = makeDraft({ task, blocks: [makeBlock({ text: 'context' })] });
    for (const strategy of allSelectionStrategies) {
      const report = SelectionEngine.run(draft, { ...relevance(1), strategy }, bytes1);
      const bytes = utf8(report.selectedPrompt);
      expect(bytes.slice(bytes.length - utf8(task).length), strategy).toEqual(utf8(task));
    }
  });

  it('testDeduplicationAlsoRemovesCopiesOfTheTask', () => {
    const draft = makeDraft({ task: 'Same words', blocks: [makeBlock({ text: 'Same words' })] });
    const report = SelectionEngine.run(draft, relevance(1000, true), bytes1);
    expect(report.decisions[0].kind).toBe('duplicateRemoved');
    expect(report.decisions[0].reason.includes('task')).toBe(true);
  });

  it('testEmptyTaskFallsBackToPriorityOrderAndSaysSo', () => {
    const draft = makeDraft({ blocks: [makeBlock({ text: 'low', priority: 1 }), makeBlock({ text: 'high', priority: 3 })] });
    const report = SelectionEngine.run(draft, relevance(), bytes1);
    expect(report.decisions.map((d) => d.considerationRank)).toEqual([2, 1]);
    expect(report.relevanceNote).toBeDefined();
  });

  it('testRankerIsReplaceable', () => {
    class ReverseRanker implements RelevanceRanker {
      get descriptor(): RankerDescriptor {
        return { id: 'reverse', displayName: 'Reverse', version: '1', method: 'test', limitations: [] };
      }
      taskTerms(): string[] {
        return ['x'];
      }
      scores(_task: string, blocks: ContextBlock[]): Map<string, RelevanceScore> {
        return new Map(blocks.map((b, i) => [b.id, { score: i, matchedTerms: [{ term: 'x', weight: 1, occurrences: 1 }] }]));
      }
    }
    const draft = makeDraft({ task: 't', blocks: [makeBlock({ text: 'aaaa' }), makeBlock({ text: 'bbbb' })] });
    // "bbbb\n\nt" = 7 bytes fits; adding "aaaa" would make 13.
    const report = SelectionEngine.run(draft, relevance(7), bytes1, { ranker: new ReverseRanker() });
    expect(report.decisions.map((d) => d.kept)).toEqual([false, true]);
    expect(report.ranker?.id).toBe('reverse');
  });

  it('testPriorityStrategyIgnoresRelevance', () => {
    const draft = makeDraft({ task: 'alpha', blocks: [makeBlock({ text: 'alpha', priority: 1 }), makeBlock({ text: 'zzzzz', priority: 3 })] });
    const report = SelectionEngine.run(draft, { ...relevance(5), strategy: 'budgetSelection' }, bytes1);
    expect(report.decisions.map((d) => d.kept)).toEqual([false, false]); // Neither fits beside the 5-byte task
    expect(report.decisions[0].relevance).toBeUndefined();
    expect(report.ranker).toBeUndefined();
  });

  // Port-specific: Swift String(format: "%.2f") sends an exact binary tie to even; toFixed would round up.
  it('relevance scores are formatted like Swift "%.2f", including exact ties', () => {
    class FixedRanker implements RelevanceRanker {
      constructor(private readonly value: number) {}
      get descriptor(): RankerDescriptor {
        return { id: 'fixed', displayName: 'Fixed', version: '1', method: 'test', limitations: [] };
      }
      taskTerms(): string[] {
        return ['x'];
      }
      scores(_task: string, blocks: ContextBlock[]): Map<string, RelevanceScore> {
        return new Map(blocks.map((b) => [b.id, { score: this.value, matchedTerms: [{ term: 'x', weight: this.value, occurrences: 1 }] }]));
      }
    }
    const draft = makeDraft({ task: 't', blocks: [makeBlock({ text: 'a' })] });
    const reason = (v: number) => SelectionEngine.run(draft, relevance(), bytes1, { ranker: new FixedRanker(v) }).decisions[0].reason;
    expect(reason(1.125)).toContain('relevance 1.12 from x');
    expect(reason(1.375)).toContain('relevance 1.38 from x');
    expect(reason(2.693)).toContain('relevance 2.69 from x');
  });
});

describe('StaleResultTests', () => {
  it('testOlderCalculationCannotReplaceNewerOne', () => {
    const gate = new LatestResultGate();
    const first = gate.begin();
    const second = gate.begin();
    expect(gate.isLatest(first)).toBe(false); // A slow, older result must be discarded
    expect(gate.isLatest(second)).toBe(true);
    gate.invalidate();
    expect(gate.isLatest(second)).toBe(false); // Editing inputs makes in-flight results stale
  });

  it('testEngineStopsWhenCancelled', () => {
    const draft = makeDraft({ task: 'a', blocks: [makeBlock({ text: 'a' }), makeBlock({ text: 'b' })] });
    expect(() => SelectionEngine.run(draft, relevance(), bytes1, { isCancelled: () => true })).toThrow(CancellationError);
    expect(() => Comparison.run(draft, relevance(), bytes1, { isCancelled: () => true })).toThrow(CancellationError);
  });

  it('testTaskEditsMakePreviewsStale', () => {
    const draft = makeDraft({ task: 'one', blocks: [makeBlock({ text: 'x' })] });
    const report = SelectionEngine.run(draft, relevance(), bytes1);
    const edited = { ...copyDraft(draft), task: 'one ' };
    expect(isReportCurrent(report, draft, relevance(), bytes1.descriptor)).toBe(true);
    expect(isReportCurrent(report, edited, relevance(), bytes1.descriptor)).toBe(false);
  });
});

describe('ComparisonTests', () => {
  // Swift uses the coding-task demo (not ported); the pasted-notes demo is used instead.
  it('testFourVariantsShareInputsAndDifferOnlyInStrategy', () => {
    const demo = makePastedNotesDemo();
    const entries = Comparison.run(demo.draft, demo.settings, new ApproximateCounter());
    expect(entries.map((e) => e.variant)).toEqual(allComparisonVariants);
    expect(entries.map((e) => e.report.settings.strategy)).toEqual(['baseline', 'exactDeduplication', 'budgetSelection', 'taskRelevance']);
    for (const entry of entries) {
      expect(entry.report.input).toEqual(demo.draft);
      expect(entry.report.settings.budget).toBe(demo.settings.budget);
      expect(entry.report.counter).toEqual(new ApproximateCounter().descriptor);
      expect(entry.report.originalTokens).toBe(entries[0].report.originalTokens);
    }
    expect(entries[0].report.selectedPrompt).toBe(entries[0].report.originalPrompt);
    expect(Comparison.isCurrent(entries, demo.draft, demo.settings, new ApproximateCounter().descriptor)).toBe(true);
    const edited = copyDraft(demo.draft);
    edited.blocks[0].priority = 3;
    expect(Comparison.isCurrent(entries, edited, demo.settings, new ApproximateCounter().descriptor)).toBe(false);
    // Port-specific: recorded estimates for the four variants on this demo.
    expect(entries.map((e) => e.report.selectedTokens)).toEqual([323, 290, 221, 221]);
  });

  it.skip('testSavedComparisonIsReproducibleAndKeepsReviews (Evaluation/ProjectCodec not ported)', () => {});
  it.skip('testMislabelledComparisonVariantIsRejected (Experiment validation not ported)', () => {});
});
