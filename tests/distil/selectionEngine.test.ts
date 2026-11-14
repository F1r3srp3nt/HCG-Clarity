// Ported from The Last Sprint — distil/Tests/TokenLabCoreTests/SelectionEngineTests.swift and the
// SelectionOutcomeTests in ContextImportTests.swift (commit 03cc61d). SampleProject-based tests use the
// pasted-notes fixture instead, or are skipped where they assert SampleProject-specific titles.

import { describe, expect, it } from 'vitest';
import type { Draft } from '../../src/distil';
import {
  ApproximateCounter,
  LabError,
  SelectionEngine,
  allSelectionStrategies,
  copyDraft,
  isReportCurrent,
  makeBlock,
  makeDraft,
  makeSettings,
  outcomeExplanation,
  outcomeRemovedContext,
  outcomeTitle,
  validateSettings,
} from '../../src/distil';
import type { SelectionStrategy } from '../../src/distil';
import { makePastedNotesDemo } from './fixtures/pastedNotes';
import { bytes1, bytesContain, settings, utf8 } from './helpers';

describe('SelectionEngineTests', () => {
  // MARK: Protected content and budget honesty

  it('testProtectedInstructionsAndRequiredCodeAreVerbatimWhenOverBudget', () => {
    const instructions = 'Explain this function.\r\nKeep\ttabs, trailing spaces   \nand é/é exactly.  ';
    const code = 'func f() {\n\tlet x = 1   \n    return x // ✓\n}\n';
    const draft = makeDraft({
      instructions,
      blocks: [
        makeBlock({ title: 'Code', text: code, category: 'Code', required: true }),
        makeBlock({ title: 'Optional', text: 'nice to have', priority: 3 }),
      ],
    });
    const report = SelectionEngine.run(draft, settings('budgetSelection', 1), bytes1);
    expect(utf8(report.selectedPrompt)).toEqual(utf8(instructions + '\n\n' + code));
    expect(bytesContain(report.selectedPrompt, code)).toBe(true);
    expect(report.protectedExceedsBudget).toBe(true);
    expect(report.overBudget).toBe(true);
    expect(report.overBudgetBy).toBe(report.selectedTokens - 1);
    expect(report.decisions[0].kind).toBe('required');
    expect(report.decisions[1].kind).toBe('excludedByBudget');
    expect(report.decisions[1].reason.includes('already exceeds')).toBe(true);
    expect(report.budgetSummary.includes('not truncated')).toBe(true);
  });

  it('testRequiredContentIsVerbatimUnderEveryStrategy', () => {
    const code = '  if a {\n\t\tb()\r\n  }  ';
    const draft = makeDraft({
      instructions: 'Task',
      blocks: [makeBlock({ text: code, required: true }), makeBlock({ text: code, required: true }), makeBlock({ text: code })],
    });
    for (const strategy of allSelectionStrategies) {
      const report = SelectionEngine.run(draft, settings(strategy, 1, true), bytes1);
      expect(report.decisions[0].kept && report.decisions[1].kept, strategy).toBe(true);
      expect(bytesContain(report.selectedPrompt, 'Task\n\n' + code + '\n\n' + code), strategy).toBe(true);
    }
  });

  it('testNonEnforcingStrategiesReportOverflowWithoutClaimingCompliance', () => {
    const draft = makeDraft({ instructions: 'Instructions', blocks: [makeBlock({ text: 'A long optional block' })] });
    for (const strategy of ['baseline', 'exactDeduplication'] as SelectionStrategy[]) {
      const report = SelectionEngine.run(draft, settings(strategy, 5), bytes1);
      expect(report.budgetEnforced).toBe(false);
      expect(report.overBudget).toBe(true);
      expect(report.overBudgetBy).toBe(report.selectedTokens - 5);
      expect(report.budgetSummary.includes('does not apply the budget')).toBe(true);
      expect(report.decisions[0].kept).toBe(true);
    }
  });

  it('testBudgetIncludesSeparators', () => {
    const draft = makeDraft({ instructions: 'X', blocks: [makeBlock({ text: 'abcd' })] });
    // "X\n\nabcd" is 7 bytes.
    expect(SelectionEngine.run(draft, settings('budgetSelection', 6), bytes1).decisions[0].kept).toBe(false);
    const fits = SelectionEngine.run(draft, settings('budgetSelection', 7), bytes1);
    expect(fits.decisions[0].kept).toBe(true);
    expect(fits.selectedTokens).toBe(7);
    expect(fits.overBudget).toBe(false);
  });

  // MARK: Strategies

  it('testBaselineRetainsEverything', () => {
    const draft = makeDraft({
      instructions: 'I',
      blocks: [makeBlock({ text: 'same', priority: 1 }), makeBlock({ text: 'same', priority: 3 }), makeBlock({ text: 'other' })],
    });
    const report = SelectionEngine.run(draft, settings('baseline', 1), bytes1);
    expect(report.selectedPrompt).toBe(report.originalPrompt);
    expect(report.estimatedReduction).toBe(0);
    expect(report.decisions.every((d) => d.kind === 'retained')).toBe(true);
  });

  it('testExactDeduplicationRemovesOnlyRedundantOptionalContext', () => {
    const required = makeBlock({ title: 'Req', text: 'shared fact', required: true });
    const draft = makeDraft({
      instructions: 'Do the task.',
      blocks: [
        makeBlock({ title: 'Low copy', text: 'repeat', priority: 1 }), // 0: removed, lower priority
        makeBlock({ title: 'Optional copy of req', text: 'shared fact', priority: 3 }), // 1: removed, duplicates required
        required, // 2: required
        makeBlock({ title: 'High copy', text: 'repeat', priority: 3 }), // 3: kept (highest priority)
        makeBlock({ title: 'Same-priority copy', text: 'repeat', priority: 3 }), // 4: removed, later tie
        makeBlock({ title: 'Copy of instructions', text: 'Do the task.' }), // 5: removed
        makeBlock({ title: 'Unique', text: 'unique text', priority: 1 }), // 6: kept
      ],
    });
    const report = SelectionEngine.run(draft, settings('exactDeduplication', 1), bytes1);
    expect(report.decisions.map((d) => d.kind)).toEqual([
      'duplicateRemoved', 'duplicateRemoved', 'required', 'retained', 'duplicateRemoved', 'duplicateRemoved', 'retained',
    ]);
    expect(report.decisions[0].duplicateOf).toBe(draft.blocks[3].id);
    expect(report.decisions[1].duplicateOf).toBe(required.id);
    expect(report.decisions[4].duplicateOf).toBe(draft.blocks[3].id);
    expect(report.decisions[5].duplicateOf).toBeUndefined();
    expect(report.decisions[4].reason.includes('earlier')).toBe(true);
    expect(report.decisions[0].reason.includes('higher priority')).toBe(true);
    expect(report.decisions[5].reason.includes('instructions')).toBe(true);
    // The budget of 1 is not applied by this strategy.
    expect(report.selectedPrompt).toBe('Do the task.\n\nshared fact\n\nrepeat\n\nunique text');
  });

  it('testDeduplicationIsByteExactNotCanonical', () => {
    const draft = makeDraft({ blocks: [makeBlock({ text: 'café' }), makeBlock({ text: 'café' })] });
    expect(SelectionEngine.run(draft, settings('exactDeduplication'), bytes1).keptCount).toBe(2);
  });

  it('testBudgetSelectionDeduplicatesOnlyWhenEnabled', () => {
    const draft = makeDraft({ blocks: [makeBlock({ text: 'dup' }), makeBlock({ text: 'dup' })] });
    expect(SelectionEngine.run(draft, settings('budgetSelection', 100, false), bytes1).keptCount).toBe(2);
    const on = SelectionEngine.run(draft, settings('budgetSelection', 100, true), bytes1);
    expect(on.decisions.map((d) => d.kind)).toEqual(['retained', 'duplicateRemoved']);
  });

  it('testBudgetSelectionUsesPriorityAndPreservesOriginalOrder', () => {
    const draft = makeDraft({
      instructions: 'I',
      blocks: [
        makeBlock({ title: 'A', text: 'aaaa', priority: 1 }),
        makeBlock({ title: 'B', text: 'bbbb', priority: 3 }),
        makeBlock({ title: 'C', text: 'cccc', priority: 2 }),
        makeBlock({ title: 'D', text: 'dddd', priority: 3 }),
      ],
    });
    // Each block adds 6 bytes (separator + 4). Protected = 1; +B = 7; +D = 13; +C = 19; +A = 25.
    const report = SelectionEngine.run(draft, settings('budgetSelection', 19), bytes1);
    expect(report.decisions.map((d) => d.kept)).toEqual([false, true, true, true]);
    expect(report.selectedPrompt).toBe('I\n\nbbbb\n\ncccc\n\ndddd');
    expect(report.selectedTokens).toBe(19);
    expect(report.decisions[0].reason.includes('over the budget')).toBe(true);
    expect(report.decisions[1].reason).toBe('Kept: high priority; assembled prompt 7 of 19 after adding it.');
    expect(report.decisions[0].reason).toBe(
      'Excluded: low priority; adding it would make the assembled prompt 25, over the budget of 19. The block was not shortened.',
    );
  });

  it('testTiesAreBrokenByOriginalOrder', () => {
    const draft = makeDraft({ blocks: [makeBlock({ title: 'first', text: '1111' }), makeBlock({ title: 'second', text: '2222' })] });
    expect(SelectionEngine.run(draft, settings('budgetSelection', 4), bytes1).decisions.map((d) => d.kept)).toEqual([true, false]);
  });

  it('testGreedySelectionCanKeepSmallerLowerPriorityBlockAndExplainsIt', () => {
    const draft = makeDraft({
      instructions: 'I',
      blocks: [makeBlock({ title: 'Big', text: 'x'.repeat(10), priority: 3 }), makeBlock({ title: 'Small', text: 'yy', priority: 1 })],
    });
    const report = SelectionEngine.run(draft, settings('budgetSelection', 6), bytes1);
    expect(report.decisions.map((d) => d.kind)).toEqual(['excludedByBudget', 'retained']);
    expect(report.decisions[0].reason.includes('13')).toBe(true);
    expect(report.decisions[1].reason.includes('5 of 6')).toBe(true);
  });

  // Swift uses SampleProject (not ported); the pasted-notes demonstration is used instead.
  it('testSelectionIsDeterministic', () => {
    const demo = makePastedNotesDemo();
    const a = SelectionEngine.run(demo.draft, demo.settings, new ApproximateCounter());
    const b = SelectionEngine.run(demo.draft, demo.settings, new ApproximateCounter());
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('testEmptyBlocksAreSkippedAndEveryDecisionIsExplained', () => {
    const draft = makeDraft({
      instructions: 'I',
      blocks: [makeBlock({ text: '' }), makeBlock({ text: 'x' }), makeBlock({ text: '', required: true })],
    });
    for (const strategy of allSelectionStrategies) {
      const report = SelectionEngine.run(draft, settings(strategy, 1000, true), bytes1);
      expect(report.decisions[0].kind).toBe('emptySkipped');
      expect(report.decisions[2].kind).toBe('emptySkipped');
      expect(report.decisions.every((d) => d.reason.length > 0)).toBe(true);
    }
  });

  it('testEmptyWorkspaceHasNoReductionPercent', () => {
    const report = SelectionEngine.run(makeDraft(), settings('budgetSelection'), bytes1);
    expect(report.estimatedReductionPercent).toBeUndefined();
    expect(report.selectedPrompt).toBe('');
  });

  // Needs SampleProject.swift, which is out of scope for this port. Kept here so the gap is visible.
  it.skip('testSampleProjectDemonstratesEachOutcome (SampleProject not ported)', () => {});

  // MARK: Validation

  it('testInvalidBudgetsAreRejected', () => {
    const draft = makeDraft({ instructions: 'x' });
    for (const budget of [0, -1, 1_000_001]) {
      expect(() => SelectionEngine.run(draft, settings('budgetSelection', budget), bytes1), `${budget}`).toThrow(LabError);
      expect(() => SelectionEngine.run(draft, settings('baseline', budget), bytes1), `${budget}`).toThrow(LabError);
    }
    expect(() => SelectionEngine.run(draft, settings('budgetSelection', 1_000_000), bytes1)).not.toThrow();
  });

  it('testInvalidCounterSettingsAreRejected', () => {
    for (const n of [0, 9]) {
      expect(() => validateSettings(makeSettings({ counter: { kind: 'approximate', bytesPerToken: n } }))).toThrow(LabError);
    }
  });

  it('testDuplicateIDsAndInvalidPrioritiesAreRejected', () => {
    const block = makeBlock({ text: 'x' });
    expect(() => SelectionEngine.run(makeDraft({ blocks: [block, block] }), settings('baseline'), bytes1)).toThrow(LabError);
    for (const priority of [0, 4]) {
      expect(() => SelectionEngine.run(makeDraft({ blocks: [makeBlock({ text: 'x', priority })] }), settings('baseline'), bytes1)).toThrow(
        LabError,
      );
    }
  });

  it('testSizeLimitsAreEnforced', () => {
    const many = makeDraft({ blocks: Array.from({ length: SelectionEngine.maxBlocks + 1 }, () => makeBlock({ text: 'x' })) });
    expect(() => SelectionEngine.validate(many)).toThrow(LabError);
    const huge = makeDraft({ instructions: 'a'.repeat(SelectionEngine.maxTextBytes + 1) });
    expect(() => SelectionEngine.validate(huge)).toThrow(LabError);
  });

  // MARK: Stale previews

  it('testReportIsStaleAfterAnyRelevantChange', () => {
    const draft = makeDraft({ instructions: 'I', blocks: [makeBlock({ text: 'abc', priority: 2 })] });
    const s = settings('budgetSelection', 100);
    const report = SelectionEngine.run(draft, s, bytes1);
    const d = bytes1.descriptor;
    expect(isReportCurrent(report, draft, s, d)).toBe(true);

    const edit = (f: (x: Draft) => void): Draft => {
      const c = copyDraft(draft);
      f(c);
      return c;
    };
    expect(isReportCurrent(report, edit((c) => (c.instructions += ' ')), s, d)).toBe(false);
    expect(isReportCurrent(report, edit((c) => (c.blocks[0].text = 'abd')), s, d)).toBe(false);
    expect(isReportCurrent(report, edit((c) => (c.blocks[0].priority = 3)), s, d)).toBe(false);
    expect(isReportCurrent(report, edit((c) => (c.blocks[0].required = true)), s, d)).toBe(false);
    expect(isReportCurrent(report, edit((c) => c.blocks.push(makeBlock())), s, d)).toBe(false);
    // Titles appear in decisions, so they invalidate too
    expect(isReportCurrent(report, edit((c) => (c.blocks[0].title = 'renamed')), s, d)).toBe(false);

    expect(isReportCurrent(report, draft, { ...s, budget: 99 }, d)).toBe(false);
    expect(isReportCurrent(report, draft, { ...s, strategy: 'baseline' }, d)).toBe(false);
    expect(isReportCurrent(report, draft, { ...s, deduplicateBeforeBudget: true }, d)).toBe(false);
    expect(isReportCurrent(report, draft, s, new ApproximateCounter(2).descriptor)).toBe(false);

    // Port-specific: the report holds a copy, so mutating the caller's draft afterwards is detected.
    draft.blocks[0].text = 'mutated';
    expect(report.input.blocks[0].text).toBe('abc');
    expect(isReportCurrent(report, draft, s, d)).toBe(false);
  });
});

describe('SelectionOutcomeTests', () => {
  const run = (draft: Draft, strategy: SelectionStrategy, budget = 1000, dedupe = true) =>
    SelectionEngine.run(draft, settings(strategy, budget, dedupe), bytes1);

  it('testEachOutcomeIsReportedAccurately', () => {
    expect(run(makeDraft({ task: 'T', blocks: [makeBlock({ text: '' })] }), 'budgetSelection').outcome).toEqual({ kind: 'noContext' });

    const two = makeDraft({ task: 'T', blocks: [makeBlock({ text: 'aaaa' }), makeBlock({ text: 'bbbb' })] });
    expect(run(two, 'baseline').outcome).toEqual({ kind: 'fullContextRetained' });
    expect(run(two, 'budgetSelection').outcome).toEqual({ kind: 'nothingRemoved' });
    expect(run(two, 'exactDeduplication').outcome).toEqual({ kind: 'nothingRemoved' });

    const dup = makeDraft({ task: 'T', blocks: [makeBlock({ text: 'same' }), makeBlock({ text: 'same' })] });
    expect(run(dup, 'exactDeduplication').outcome).toEqual({ kind: 'duplicatesRemoved', count: 1 });

    // "aaaa\n\nT" = 7 fits; adding "bbbb" would make 13.
    expect(run(two, 'budgetSelection', 7).outcome).toEqual({ kind: 'excludedForBudget', excluded: 1, duplicates: 0 });

    const protectedDraft = makeDraft({ task: 'A long protected task', blocks: [makeBlock({ text: 'x' })] });
    expect(run(protectedDraft, 'taskRelevance', 3).outcome).toEqual({ kind: 'protectedExceedsBudget', overBy: 18, excluded: 1 });
  });

  it('testUnchangedPromptsAreNeverDescribedAsOptimised', () => {
    const two = makeDraft({ task: 'T', blocks: [makeBlock({ text: 'aaaa' }), makeBlock({ text: 'bbbb' })] });
    for (const strategy of allSelectionStrategies) {
      const report = run(two, strategy);
      expect(report.selectedPrompt).toBe(report.originalPrompt);
      expect(outcomeRemovedContext(report.outcome), strategy).toBe(false);
      expect(outcomeTitle(report.outcome).toLowerCase().includes('optimised') && report.outcome.kind !== 'noContext').toBe(false);
    }
  });

  it('testMarkingAnExcludedBlockRequiredKeepsItOnRerun', () => {
    const draft = makeDraft({ task: 'T', blocks: [makeBlock({ title: 'keep', text: 'aaaa' }), makeBlock({ title: 'lost', text: 'bbbbbbbb' })] });
    expect(run(draft, 'budgetSelection', 7).decisions[1].kind).toBe('excludedByBudget');
    draft.blocks[1].required = true;
    const rerun = run(draft, 'budgetSelection', 7);
    expect(rerun.decisions[1].kind).toBe('required');
    expect(bytesContain(rerun.selectedPrompt, 'bbbbbbbb')).toBe(true);
    // Required text is kept even when it no longer fits, and the overflow is reported
    expect(rerun.overBudget).toBe(true);
  });

  // Port-specific: banner wording is identical to the Swift strings.
  it('outcome banners use the Swift wording', () => {
    expect(outcomeTitle({ kind: 'excludedForBudget', excluded: 2, duplicates: 1 })).toBe('Optional context excluded for the budget');
    expect(outcomeExplanation({ kind: 'excludedForBudget', excluded: 2, duplicates: 1 })).toBe(
      '2 optional blocks did not fit the budget and were left out whole, not shortened. 1 exact duplicate was also removed. Check them for information the task needs.',
    );
    expect(outcomeExplanation({ kind: 'duplicatesRemoved', count: 1 })).toBe(
      '1 optional block was a byte-for-byte copy of kept text. Nothing else was removed.',
    );
    expect(outcomeExplanation({ kind: 'protectedExceedsBudget', overBy: 18, excluded: 1 })).toBe(
      'The task, instructions and required blocks alone are 18 over the budget. They were kept intact and all optional context was left out.',
    );
    expect(SelectionEngine.assemble(makeDraft({ task: 'T', instructions: 'I', blocks: [makeBlock({ text: 'b' }), makeBlock({ text: '' })] }))).toBe(
      'I\n\nb\n\nT',
    );
  });
});
