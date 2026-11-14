// Ported from The Last Sprint — distil/Sources/TokenLabCore/Relevance.swift (commit 03cc61d)
// Behaviour change: scores are returned as a Map keyed by block id; character classes use ECMAScript
// Unicode property escapes in place of Foundation CharacterSets (see `KeywordOverlapRanker.terms`).

import type { ContextBlock } from './models';
import { graphemes } from './text';

/** Identifies how relevance was computed. Stored in reports so rankings can be reproduced. */
export interface RankerDescriptor {
  id: string;
  displayName: string;
  version: string;
  /** Plain-language description of the method. */
  method: string;
  /** Known weaknesses, shown to the user next to rankings. */
  limitations: string[];
}

/** One task term found in a block, and how much it added to the block's score. */
export interface TermContribution {
  term: string;
  /** Added to the score once per block, however often the term occurs. */
  weight: number;
  /** How many times the term occurs in the block (shown for information; not scored). */
  occurrences: number;
}

export interface RelevanceScore {
  /** Sum of the weights of distinct task terms found in the block, rounded to 3 decimals. */
  score: number;
  matchedTerms: TermContribution[];
}

export function isZeroMatch(score: RelevanceScore): boolean {
  return score.matchedTerms.length === 0;
}

/** Replaceable ranking interface. Rankers only score; they never select, count tokens or edit text. */
export interface RelevanceRanker {
  readonly descriptor: RankerDescriptor;
  /** The distinct terms extracted from the task, in first-appearance order. */
  taskTerms(task: string): string[];
  /** Scores for every block, keyed by block id. Must be deterministic. */
  scores(task: string, blocks: ContextBlock[]): Map<string, RelevanceScore>;
}

const STOP_WORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'do', 'does', 'for', 'from', 'has', 'have',
  'how', 'if', 'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or', 'our', 'so', 'such', 'that', 'the', 'their',
  'them', 'then', 'there', 'these', 'they', 'this', 'to', 'was', 'we', 'were', 'what', 'when', 'where', 'which',
  'who', 'why', 'will', 'with', 'would', 'you', 'your', 'me', 'my', 'i', 'all', 'any', 'some', 'not', 'no',
  'please', 'should', 'could', 'about', 'also', 'than', 'too', 'very', 'just', 'only', 'use', 'using',
]);

// Foundation CharacterSet.alphanumerics = categories L*, M*, N*; uppercaseLetters = Lu + Lt; lowercaseLetters = Ll.
const ALNUM = /^[\p{L}\p{M}\p{N}]$/u;
const UPPER = /^[\p{Lu}\p{Lt}]$/u;
const LOWER = /^\p{Ll}$/u;

/**
 * Deterministic keyword-overlap ranking with inverse-document-frequency weights.
 *
 * - Terms: text is canonically normalised (NFC) for comparison only, lower-cased, and split into runs of
 *   letters and digits; runs are also split at lower→upper case changes (`parseDueDate` → `parse`,
 *   `due`, `date`). Terms shorter than 2 characters and a short list of common English words are ignored.
 * - Weight of a task term = 1 + ln((N + 1) / (df + 1)), where N is the number of non-empty blocks
 *   and df the number of those blocks containing the term. Rare terms count more than common ones.
 * - Score of a block = sum of the weights of the distinct task terms it contains.
 */
export class KeywordOverlapRanker implements RelevanceRanker {
  static readonly stopWords = STOP_WORDS;

  get descriptor(): RankerDescriptor {
    return {
      id: 'keyword-overlap-idf',
      displayName: 'Keyword overlap (local, deterministic)',
      version: 'keyword-overlap-1',
      method:
        "Each block scores the sum of weights of the distinct task terms it contains. A term's weight is 1 + ln((N+1)/(df+1)), so terms that appear in fewer blocks count more. Terms are lower-cased words and identifier parts; common English words and one-character terms are ignored.",
      limitations: [
        'Matches exact words only: no synonyms, paraphrases, stemming or translation (“refund” ≠ “money back”, “parse” ≠ “parsing”).',
        'A block can match many task words and still be irrelevant, or match none and be essential.',
        'Repetition does not raise a score, but keyword-heavy filler can still outrank useful text.',
        'Blocks with no matching terms score 0. They are not removed for that reason: they are considered after every matching block and kept if the budget allows.',
        'Equal scores are ordered by manual priority, then by position in the prompt.',
      ],
    };
  }

  taskTerms(task: string): string[] {
    const seen = new Set<string>();
    return KeywordOverlapRanker.terms(task).filter((t) => {
      if (seen.has(t)) return false;
      seen.add(t);
      return true;
    });
  }

  scores(task: string, blocks: ContextBlock[]): Map<string, RelevanceScore> {
    const queryTerms = this.taskTerms(task);
    const scored = blocks.filter((b) => b.text.length > 0);
    const counts = new Map<string, Map<string, number>>();
    for (const block of scored) {
      const c = new Map<string, number>();
      for (const term of KeywordOverlapRanker.terms(block.text)) c.set(term, (c.get(term) ?? 0) + 1);
      counts.set(block.id, c);
    }
    const n = scored.length;
    const weights = new Map<string, number>();
    for (const term of queryTerms) {
      const df = scored.filter((b) => counts.get(b.id)?.has(term)).length;
      weights.set(term, 1 + Math.log((n + 1) / (df + 1)));
    }
    const result = new Map<string, RelevanceScore>();
    for (const block of blocks) {
      const blockCounts = counts.get(block.id);
      const contributions: TermContribution[] = [];
      let total = 0;
      for (const term of queryTerms) {
        const occurrences = blockCounts?.get(term);
        const weight = weights.get(term);
        if (occurrences === undefined || weight === undefined) continue;
        total += weight;
        contributions.push({ term, weight: KeywordOverlapRanker.round3(weight), occurrences });
      }
      result.set(block.id, { score: KeywordOverlapRanker.round3(total), matchedTerms: contributions });
    }
    return result;
  }

  /** Round to 3 decimals, halves away from zero (Swift `rounded()`). */
  static round3(x: number): number {
    return (Math.sign(x) * Math.round(Math.abs(x) * 1000)) / 1000;
  }

  /** Lower-cased terms in reading order (with repeats). The source text is never modified. */
  static terms(text: string): string[] {
    const terms: string[] = [];
    let current = '';
    let previousWasLower = false;
    const flush = (): void => {
      if (current.length > 0) {
        const term = current.toLowerCase();
        if (graphemes(term).length >= 2 && !STOP_WORDS.has(term)) terms.push(term);
      }
      current = '';
    };
    for (const scalar of text.normalize('NFC')) {
      if (!ALNUM.test(scalar)) {
        flush();
        previousWasLower = false;
        continue;
      }
      if (UPPER.test(scalar) && previousWasLower) flush();
      current += scalar;
      previousWasLower = LOWER.test(scalar);
    }
    flush();
    return terms;
  }
}
