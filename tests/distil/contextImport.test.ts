// Ported from The Last Sprint — distil/Tests/TokenLabCoreTests/ContextImportTests.swift (commit 03cc61d)
// Plus the line-provenance tests required by the TypeScript port. ProjectCodec round-trip tests are not ported.

import { describe, expect, it } from 'vitest';
import type { ProposedBlock } from '../../src/distil';
import { ApproximateCounter, ContextSplitter, SelectionEngine, graphemes } from '../../src/distil';
import { makePastedNotesDemo, pastedNotesText } from './fixtures/pastedNotes';

/**
 * Every proposed block must be an exact, in-order run of the original, and nothing but whitespace-only
 * lines and line breaks between blocks may be missing.
 */
function assertExactAndComplete(blocks: ProposedBlock[], original: string): void {
  let cursor = 0;
  for (const block of blocks) {
    const at = original.indexOf(block.text, cursor);
    expect(at, `Block is not an exact substring after the previous block: ${JSON.stringify(block.text)}`).toBeGreaterThanOrEqual(0);
    const gap = original.slice(cursor, at);
    expect(/^\s*$/u.test(gap), `Non-whitespace text skipped before block: ${JSON.stringify(gap)}`).toBe(true);
    cursor = at + block.text.length;
  }
  expect(/^\s*$/u.test(original.slice(cursor)), 'Text lost after the last block').toBe(true);
}

describe('ContextSplitterTests', () => {
  it('testHeadingsStartBlocksAndTextBeforeFirstHeadingIsKept', () => {
    const text = 'Intro line.\n\n# First\nAlpha.\n\nMore alpha.\n\n## Second\nBeta.\n';
    const blocks = ContextSplitter.split(text);
    expect(blocks.map((b) => b.text)).toEqual(['Intro line.', '# First\nAlpha.\n\nMore alpha.', '## Second\nBeta.']);
    expect(blocks.map((b) => b.title)).toEqual(['Intro line.', 'First', 'Second']);
    assertExactAndComplete(blocks, text);
  });

  it('testWithoutHeadingsParagraphsBecomeBlocksInOrder', () => {
    const text = '  First paragraph,\nline two.  \n\n\n\tSecond\twith tabs.\n\nThird.';
    const blocks = ContextSplitter.split(text);
    // Indentation, tabs and trailing spaces inside blocks are preserved
    expect(blocks.map((b) => b.text)).toEqual(['  First paragraph,\nline two.  ', '\tSecond\twith tabs.', 'Third.']);
    assertExactAndComplete(blocks, text);
  });

  it('testFencedCodeIsNeverSplitEvenAcrossBlankLines', () => {
    const code = '```swift\nlet a = 1\n\n\n# not a heading\nlet b = 2\n```';
    const text = `Before.\n\n${code}\n\nAfter.`;
    const blocks = ContextSplitter.split(text);
    expect(blocks.map((b) => b.text)).toEqual(['Before.', code, 'After.']);
    expect(blocks[1].category).toBe('Code');
    expect(blocks[1].title).toBe('Code (swift)');
    assertExactAndComplete(blocks, text);
  });

  it('testHeadingInsideFenceDoesNotSplitSections', () => {
    const text = '# Section\n~~~\n# inside code\n~~~\nTail.\n# Next\nX';
    expect(ContextSplitter.split(text).map((b) => b.text)).toEqual(['# Section\n~~~\n# inside code\n~~~\nTail.', '# Next\nX']);
  });

  it('testUnclosedFenceRunsToTheEnd', () => {
    const text = 'Para.\n\n```\ncode\n\nmore code';
    expect(ContextSplitter.split(text).map((b) => b.text)).toEqual(['Para.', '```\ncode\n\nmore code']);
  });

  it('testClosingFenceMustMatchCharacterAndLength', () => {
    const text = '````\na\n```\nstill code\n````\n\nAfter.';
    expect(ContextSplitter.split(text).map((b) => b.text)).toEqual(['````\na\n```\nstill code\n````', 'After.']);
  });

  it('testSetextHeadings', () => {
    const text = 'Title\n=====\nBody.\n\nSub\n---\nMore.';
    const blocks = ContextSplitter.split(text);
    expect(blocks.map((b) => b.text)).toEqual(['Title\n=====\nBody.', 'Sub\n---\nMore.']);
    expect(blocks.map((b) => b.title)).toEqual(['Title', 'Sub']);
  });

  it('testWindowsLineBreaksArePreservedInsideBlocks', () => {
    const text = 'One\r\nline two\r\n\r\nTwo\r\n';
    const blocks = ContextSplitter.split(text);
    expect(blocks.map((b) => b.text)).toEqual(['One\r\nline two', 'Two']);
    assertExactAndComplete(blocks, text);
  });

  it('testEmptyAndWhitespaceOnlyInput', () => {
    expect(ContextSplitter.split('')).toEqual([]);
    expect(ContextSplitter.split(' \n\t\n')).toEqual([]);
    expect(ContextSplitter.keepAsOneBlock('', 'x')).toEqual([]);
  });

  it('testKeepAsOneBlockIsTheExactOriginal', () => {
    const text = '\n  # A\n\nbody\t \n';
    const blocks = ContextSplitter.keepAsOneBlock(text, 'Pasted');
    expect(blocks.length).toBe(1);
    expect(Array.from(new TextEncoder().encode(blocks[0].text))).toEqual(Array.from(new TextEncoder().encode(text)));
    expect(ContextSplitter.keepAsOneBlock('```\ncode\n```', 'c')[0].category).toBe('Code');
  });

  it('testSplittingIsDeterministic', () => {
    const a = ContextSplitter.split(pastedNotesText).map((b) => [b.title, b.text, b.lineStart, b.lineEnd]);
    const b = ContextSplitter.split(pastedNotesText).map((b) => [b.title, b.text, b.lineStart, b.lineEnd]);
    expect(a).toEqual(b);
  });

  it('testLongTitlesAreShortenedButTextIsNot', () => {
    const line = 'word '.repeat(40);
    const block = ContextSplitter.split(line)[0];
    expect(graphemes(block.title).length).toBeLessThanOrEqual(60);
    expect(block.text).toBe(line);
  });

  // Port-specific: Swift counts Characters (grapheme clusters); the port does too.
  it('title shortening counts grapheme clusters, not UTF-16 units', () => {
    const line = '👍🏽'.repeat(61); // each is one grapheme, four UTF-16 units
    const block = ContextSplitter.split(line)[0];
    expect(graphemes(block.title).length).toBe(60);
    expect(block.title.endsWith('…')).toBe(true);
    expect(block.text).toBe(line);
  });
});

describe('Line provenance (TypeScript addition)', () => {
  /**
   * Ranges count lines of `text.split("\n")`, 1-based and inclusive. The joined lines equal the block
   * text exactly, except that Swift drops a final "\r" (half of a CRLF break) from a block's last line.
   */
  function expectProvenance(text: string, blocks: ProposedBlock[], options: { crlf?: boolean } = {}): void {
    const originalLines = text.split('\n');
    expect(blocks.length).toBeGreaterThan(0);
    let previousEnd = 0;
    for (const block of blocks) {
      expect(block.lineStart).toBeGreaterThanOrEqual(1);
      expect(block.lineEnd).toBeGreaterThanOrEqual(block.lineStart);
      expect(block.lineEnd).toBeLessThanOrEqual(originalLines.length);
      expect(block.lineStart).toBeGreaterThan(previousEnd);
      previousEnd = block.lineEnd;
      const joined = originalLines.slice(block.lineStart - 1, block.lineEnd).join('\n');
      if (options.crlf && joined.endsWith('\r')) {
        expect(joined.slice(0, -1)).toBe(block.text);
      } else {
        expect(joined).toBe(block.text);
      }
    }
  }

  it('headings, including text before the first heading', () => {
    const text = 'Intro line.\n\n# First\nAlpha.\n\nMore alpha.\n\n## Second\nBeta.\n';
    const blocks = ContextSplitter.split(text);
    expect(blocks.map((b) => [b.lineStart, b.lineEnd])).toEqual([[1, 1], [3, 6], [8, 9]]);
    expectProvenance(text, blocks);
  });

  it('setext headings', () => {
    const text = 'Title\n=====\nBody.\n\nSub\n---\nMore.';
    expectProvenance(text, ContextSplitter.split(text));
  });

  it('paragraphs with indentation and several blank lines', () => {
    const text = '  First paragraph,\nline two.  \n\n\n\tSecond\twith tabs.\n\nThird.';
    const blocks = ContextSplitter.split(text);
    expect(blocks.map((b) => [b.lineStart, b.lineEnd])).toEqual([[1, 2], [5, 5], [7, 7]]);
    expectProvenance(text, blocks);
  });

  it('fenced code with internal blank lines, closed and unclosed', () => {
    const text = 'Before.\n\n```swift\nlet a = 1\n\n\n# not a heading\nlet b = 2\n```\n\nAfter.';
    const blocks = ContextSplitter.split(text);
    expect(blocks.map((b) => [b.lineStart, b.lineEnd])).toEqual([[1, 1], [3, 9], [11, 11]]);
    expectProvenance(text, blocks);
    const unclosed = 'Para.\n\n```\ncode\n\nmore code';
    expectProvenance(unclosed, ContextSplitter.split(unclosed));
  });

  it('leading and trailing blank (whitespace-only) lines are outside every range', () => {
    const text = '\n \n\t\nFirst.\n\n# Head\nBody.\n\n \n\n';
    const blocks = ContextSplitter.split(text);
    expect(blocks.map((b) => [b.lineStart, b.lineEnd])).toEqual([[4, 4], [6, 7]]);
    expectProvenance(text, blocks);
  });

  it('CRLF: ranges are lines split at "\\n"; only a block-final "\\r" is left out', () => {
    const text = '\r\nOne\r\nline two\r\n\r\nTwo\r\n';
    const blocks = ContextSplitter.split(text);
    expect(blocks.map((b) => b.text)).toEqual(['One\r\nline two', 'Two']);
    expect(blocks.map((b) => [b.lineStart, b.lineEnd])).toEqual([[2, 3], [5, 5]]);
    expectProvenance(text, blocks, { crlf: true });
    const headed = '# A\r\nalpha\r\n\r\n# B\r\nbeta';
    const hb = ContextSplitter.split(headed);
    expect(hb.map((b) => b.text)).toEqual(['# A\r\nalpha', '# B\r\nbeta']);
    expectProvenance(headed, hb, { crlf: true });
  });

  it('keep-as-one-block covers every line', () => {
    const text = '\n  # A\n\nbody\t \n';
    const [block] = ContextSplitter.keepAsOneBlock(text, 'Pasted');
    expect([block.lineStart, block.lineEnd]).toEqual([1, 5]);
    expectProvenance(text, [block]);
  });

  it('the pasted-notes demonstration', () => {
    const blocks = ContextSplitter.split(pastedNotesText);
    expectProvenance(pastedNotesText, blocks);
    expect(blocks.map((b) => [b.lineStart, b.lineEnd])).toEqual([[1, 3], [5, 7], [9, 13], [15, 24], [26, 28], [30, 32], [34, 38]]);
  });
});

describe('PastedSourcePersistenceTests', () => {
  // testPastedOriginalsRoundTripAndBlocksKeepTheirSource, without the ProjectCodec round trip (not ported).
  it('testPastedOriginalsRoundTripAndBlocksKeepTheirSource (no file round trip)', () => {
    const demo = makePastedNotesDemo();
    expect(demo.pastedSource.text).toBe(pastedNotesText); // The original is kept exactly
    expect(demo.draft.blocks.every((b) => b.pastedSourceID === demo.pastedSource.id)).toBe(true);
    expect(demo.pastedSource.importedAt).toBe('2026-10-29T20:53:20.000Z');
  });
});

describe('PastedNotesDemonstrationTests', () => {
  /** Recorded behaviour of the synthetic demonstration (not benchmark evidence). */
  function kept(budget: number): Record<string, boolean> {
    const demo = makePastedNotesDemo();
    const report = SelectionEngine.run(demo.draft, { ...demo.settings, budget }, new ApproximateCounter());
    const result: Record<string, boolean> = {};
    for (const d of report.decisions) result[d.title] = (result[d.title] ?? false) || d.kept;
    return result;
  }

  it('testDemoSplitsIntoSections', () => {
    const blocks = makePastedNotesDemo().draft.blocks;
    expect(blocks.map((b) => b.title)).toEqual([
      'Upload service notes',
      'Rate limits',
      'Error codes',
      'Current client',
      'Meeting notes (week 12)',
      'Meeting notes (week 12)',
      'Changelog',
    ]);
    // The fenced code keeps its internal blank line and indentation
    expect(blocks[3].text.includes('let request = makeRequest(data)\n\n    let (body, response)')).toBe(true);
  });

  it('testUsefulReductionKeepsEveryFactBlock', () => {
    const k = kept(230);
    expect(k['Rate limits']).toBe(true);
    expect(k['Error codes']).toBe(true);
    expect(k['Current client']).toBe(true);
    expect(k['Changelog']).toBe(false);
    expect(k['Meeting notes (week 12)']).toBe(false);
  });

  it('testTighterBudgetLosesTheErrorCodeRules', () => {
    // The block stating that 400 and 413 must never be retried is excluded
    expect(kept(150)['Error codes']).toBe(false);
  });

  // From the Swift README: budget 230, task relevance, dedupe on → 323 → 221 estimated tokens.
  it('README numbers: 323 → 221 estimated tokens at budget 230; banner wording at 150', () => {
    const demo = makePastedNotesDemo();
    const report = SelectionEngine.run(demo.draft, demo.settings, new ApproximateCounter());
    expect(report.originalTokens).toBe(323);
    expect(report.selectedTokens).toBe(221);
    expect(report.decisions.map((d) => d.kind)).toEqual([
      'retained', 'retained', 'retained', 'retained', 'excludedByBudget', 'duplicateRemoved', 'excludedByBudget',
    ]);
    expect(report.outcome).toEqual({ kind: 'excludedForBudget', excluded: 2, duplicates: 1 });
    expect(report.budgetSummary).toBe('The whole assembled prompt is 221 of 230 estimated tokens.');
    const tight = SelectionEngine.run(demo.draft, { ...demo.settings, budget: 150 }, new ApproximateCounter());
    expect(tight.outcome.kind).toBe('excludedForBudget');
    expect(tight.selectedTokens).toBeLessThanOrEqual(150);
  });
});
