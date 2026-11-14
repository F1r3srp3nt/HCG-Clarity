/**
 * Ported from HCG RePrompter — Sources/RePrompterCore/TextDiff.swift (commit 0e91066)
 * © 2026 Hakmi Capital Group.
 * Behaviour change: returns `{ segments, summary }` instead of a Swift tuple; token equality is
 * exact code-unit equality (Swift String equality also treats canonically equivalent text as equal).
 */
import { characters, isWhitespace, splitWhitespace, trimSpacesAndNewlines } from './swiftText';

export type DiffSegmentKind = 'equal' | 'inserted' | 'removed';

/** A run of text in a diff. */
export interface DiffSegment {
  kind: DiffSegmentKind;
  text: string;
}

export interface DiffSummary {
  unchangedWords: number;
  insertedWords: number;
  removedWords: number;
  /** True when the inputs were too large for a word-level diff and a coarser line-level comparison was used. */
  isApproximate: boolean;
}

export interface DiffResult {
  segments: DiffSegment[];
  summary: DiffSummary;
}

/** Upper bound on the LCS table size (cells) to keep memory bounded. */
const maxCells = 4_000_000;

/** Splits text into words, keeping the trailing whitespace attached so the segments reassemble exactly. */
function wordTokens(text: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inWhitespace = false;
  for (const character of characters(text)) {
    if (isWhitespace(character)) {
      inWhitespace = true;
      current += character;
    } else {
      if (inWhitespace && current !== '') {
        tokens.push(current);
        current = '';
      }
      inWhitespace = false;
      current += character;
    }
  }
  if (current !== '') tokens.push(current);
  return tokens;
}

function lcsDiff(a: string[], b: string[]): DiffSegment[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return m === 0 ? [] : [{ kind: 'inserted', text: b.join('') }];
  if (m === 0) return [{ kind: 'removed', text: a.join('') }];

  // Compare on trimmed tokens so whitespace-only changes are not noise.
  const ka = a.map(trimSpacesAndNewlines);
  const kb = b.map(trimSpacesAndNewlines);

  const width = m + 1;
  const table = new Int32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        ka[i] === kb[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }

  const segments: DiffSegment[] = [];
  const append = (kind: DiffSegmentKind, text: string): void => {
    const last = segments[segments.length - 1];
    if (last && last.kind === kind) last.text += text;
    else segments.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (ka[i] === kb[j]) {
      append('equal', b[j]);
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      append('removed', a[i]);
      i += 1;
    } else {
      append('inserted', b[j]);
      j += 1;
    }
  }
  while (i < n) append('removed', a[i++]);
  while (j < m) append('inserted', b[j++]);
  return segments;
}

function summarize(segments: DiffSegment[], approximate: boolean): DiffSummary {
  const summary: DiffSummary = { unchangedWords: 0, insertedWords: 0, removedWords: 0, isApproximate: approximate };
  for (const segment of segments) {
    const words = splitWhitespace(segment.text).length;
    if (segment.kind === 'equal') summary.unchangedWords += words;
    else if (segment.kind === 'inserted') summary.insertedWords += words;
    else summary.removedWords += words;
  }
  return summary;
}

/** Longest-common-subsequence diff over words (or lines for very large inputs). */
export const TextDiff = {
  maxCells,

  diff(oldText: string, newText: string): DiffResult {
    const oldWords = wordTokens(oldText);
    const newWords = wordTokens(newText);
    if (oldWords.length * newWords.length <= maxCells) {
      const segments = lcsDiff(oldWords, newWords);
      return { segments, summary: summarize(segments, false) };
    }
    const oldLines = oldText.split('\n').map((line) => line + '\n');
    const newLines = newText.split('\n').map((line) => line + '\n');
    if (oldLines.length * newLines.length <= maxCells) {
      const segments = lcsDiff(oldLines, newLines);
      return { segments, summary: summarize(segments, true) };
    }
    const segments: DiffSegment[] = [
      { kind: 'removed', text: oldText },
      { kind: 'inserted', text: newText },
    ];
    return { segments, summary: summarize(segments, true) };
  },

  wordTokens,
  lcsDiff,
  summarize,
};
