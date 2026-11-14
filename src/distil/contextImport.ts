// Ported from The Last Sprint — distil/Sources/TokenLabCore/ContextImport.swift (commit 03cc61d)
// Behaviour change: proposed blocks also carry 1-based inclusive lineStart/lineEnd provenance;
// PastedSource keeps an ISO date string instead of a Foundation Date.

import type { ContextCategory } from './models';
import { graphemes, newID, trimCharacters, trimWhitespaces } from './text';

/** Original pasted material, kept so it can always be recovered exactly. */
export interface PastedSource {
  id: string;
  title: string;
  /** The text exactly as pasted. */
  text: string;
  /** ISO 8601, truncated to whole seconds (Swift `ProjectCodec.wholeSeconds`). */
  importedAt: string;
}

export function makePastedSource(title: string, text: string, importedAt: Date = new Date(), id: string = newID()): PastedSource {
  const whole = new Date(Math.floor(importedAt.getTime() / 1000) * 1000);
  return { id, title, text, importedAt: whole.toISOString() };
}

/**
 * A block proposed from pasted text, before the user confirms it.
 *
 * Provenance (addition to the Swift model): `lineStart`/`lineEnd` are 1-based and inclusive, counted in
 * `text.split("\n")` of the pasted original. No newline normalisation is applied (Swift splits at U+000A
 * only, so a Windows "\r\n" leaves a "\r" at the end of each line). Hence
 * `lines.slice(lineStart - 1, lineEnd).join("\n")` equals `text` exactly, except that when the last line of
 * the range ends in "\r" (a CRLF paste) the block text omits that one final "\r", as in Swift.
 */
export interface ProposedBlock {
  id: string;
  title: string;
  /** Exact text from the paste (see `ContextSplitter` for what boundaries are removed). */
  text: string;
  category: ContextCategory;
  required: boolean;
  lineStart: number;
  lineEnd: number;
}

type LineKind = 'blank' | 'text' | 'heading' | 'underline' | 'fence' | 'code';

interface Range {
  lower: number;
  upper: number;
}

interface FenceMarker {
  char: string;
  length: number;
  infoIsEmpty: boolean;
}

/** Number of leading graphemes equal to `char` (Swift `prefix { $0 == char }.count`). */
function prefixCount(chars: string[], char: string, from = 0): number {
  let i = from;
  while (i < chars.length && chars[i] === char) i++;
  return i - from;
}

/**
 * Deterministic splitting of pasted text into context blocks.
 *
 * Rules:
 * - Text is split into lines at `\n` only; every block is an exact, contiguous run of whole lines from
 *   the paste. Nothing is rewritten, summarised or truncated. Only the line breaks and whitespace-only
 *   lines *between* blocks are left out (and a `\r` ending a block's last line, which is part of a
 *   Windows line break). The complete original is kept separately as a `PastedSource`.
 * - Fenced code (``` or ~~~, closed by a fence of the same character at least as long) is never split,
 *   even across blank lines. An unclosed fence runs to the end of the paste.
 * - If the paste has Markdown headings outside code (`# …` to `###### …`, or a line underlined with
 *   `===`/`---`), each heading starts a block that runs to the next heading; text before the first
 *   heading is its own block.
 * - Without headings, blocks are paragraphs separated by blank lines; a fenced code block is its own block.
 *
 * Character-level checks (leading spaces, `#` runs, fence runs, title length) count grapheme clusters
 * like Swift `Character`s, via `Intl.Segmenter`.
 */
export const ContextSplitter = {
  keepAsOneBlock(text: string, title: string): ProposedBlock[] {
    if (text.length === 0) return [];
    return [
      {
        id: newID(),
        title,
        text,
        category: ContextSplitter.isOnlyCode(text) ? 'Code' : 'Reference',
        required: false,
        lineStart: 1,
        lineEnd: ContextSplitter.splitLines(text).length,
      },
    ];
  },

  split(text: string): ProposedBlock[] {
    const lines = ContextSplitter.splitLines(text);
    const kinds = ContextSplitter.classify(lines);
    const headingStarts: number[] = [];
    kinds.forEach((kind, i) => {
      if (kind === 'heading') headingStarts.push(i);
    });
    let ranges: Range[];
    if (headingStarts.length === 0) {
      ranges = paragraphRanges(kinds);
    } else {
      const bounds = [...headingStarts];
      const first = firstContentLine(kinds);
      if (first !== undefined && first < headingStarts[0]) bounds.unshift(first);
      ranges = [];
      bounds.forEach((start, index) => {
        const end = index + 1 < bounds.length ? bounds[index + 1] - 1 : lines.length - 1;
        const r = trimmed({ lower: start, upper: end }, kinds);
        if (r) ranges.push(r);
      });
    }
    let paragraphNumber = 0;
    return ranges.map((range) => {
      const rangeLines = lines.slice(range.lower, range.upper + 1);
      const rangeKinds = kinds.slice(range.lower, range.upper + 1);
      const blockLines = [...rangeLines];
      const last = blockLines[blockLines.length - 1];
      if (last.endsWith('\r')) blockLines[blockLines.length - 1] = last.slice(0, -1);
      const codeOnly = rangeKinds.every((k) => k === 'fence' || k === 'code');
      paragraphNumber += 1;
      return {
        id: newID(),
        title: titleFor(rangeLines, rangeKinds, paragraphNumber),
        text: blockLines.join('\n'),
        category: codeOnly ? 'Code' : 'Reference',
        required: false,
        lineStart: range.lower + 1,
        lineEnd: range.upper + 1,
      };
    });
  },

  /**
   * Split at U+000A only (Swift splits Unicode scalars so that "\r\n" is not treated as one character).
   * Joining the lines with "\n" reproduces the original exactly.
   */
  splitLines(text: string): string[] {
    return text.split('\n');
  },

  classify(lines: string[]): LineKind[] {
    const kinds: LineKind[] = lines.map(() => 'text');
    let openFence: { char: string; length: number } | undefined;
    lines.forEach((line, i) => {
      if (openFence) {
        const closing = fenceMarker(line);
        if (closing && closing.char === openFence.char && closing.length >= openFence.length && closing.infoIsEmpty) {
          kinds[i] = 'fence';
          openFence = undefined;
        } else {
          kinds[i] = 'code';
        }
        return;
      }
      const opening = fenceMarker(line);
      if (opening) {
        kinds[i] = 'fence';
        openFence = { char: opening.char, length: opening.length };
        return;
      }
      if (isBlank(line)) {
        kinds[i] = 'blank';
        return;
      }
      if (isATXHeading(line)) {
        kinds[i] = 'heading';
        return;
      }
      kinds[i] = 'text';
    });
    // Setext headings: a text line directly followed by a line of only = or - (at least 3).
    for (let i = 0; i < lines.length - 1; i++) {
      if (kinds[i] === 'text' && kinds[i + 1] === 'text' && isSetextUnderline(lines[i + 1])) {
        if (i === 0 || kinds[i - 1] === 'blank' || kinds[i - 1] === 'heading' || kinds[i - 1] === 'fence') {
          kinds[i] = 'heading';
          kinds[i + 1] = 'underline';
        }
      }
    }
    return kinds;
  },

  isOnlyCode(text: string): boolean {
    const kinds = ContextSplitter.classify(ContextSplitter.splitLines(text)).filter((k) => k !== 'blank');
    return kinds.length > 0 && kinds.every((k) => k === 'fence' || k === 'code');
  },
};

function paragraphRanges(kinds: LineKind[]): Range[] {
  const ranges: Range[] = [];
  let start: number | undefined;
  const close = (end: number): void => {
    if (start !== undefined) {
      const r = trimmed({ lower: start, upper: end }, kinds);
      if (r) ranges.push(r);
    }
    start = undefined;
  };
  let i = 0;
  while (i < kinds.length) {
    const kind = kinds[i];
    if (kind === 'fence') {
      // A fenced block is its own block: close any paragraph, then take the fence through its end.
      if (start !== undefined) close(i - 1);
      let end = i + 1;
      while (end < kinds.length && kinds[end] === 'code') end += 1;
      if (end >= kinds.length) end = kinds.length - 1; // unclosed: runs to the end
      ranges.push({ lower: i, upper: end });
      i = end + 1;
      continue;
    } else if (kind === 'blank') {
      if (start !== undefined) close(i - 1);
    } else if (start === undefined) {
      start = i;
    }
    i += 1;
  }
  if (start !== undefined) close(kinds.length - 1);
  return ranges;
}

function trimmed(range: Range, kinds: LineKind[]): Range | undefined {
  let lower = range.lower;
  let upper = range.upper;
  while (lower <= upper && kinds[lower] === 'blank') lower += 1;
  while (upper >= lower && kinds[upper] === 'blank') upper -= 1;
  return lower <= upper ? { lower, upper } : undefined;
}

function firstContentLine(kinds: LineKind[]): number | undefined {
  const index = kinds.findIndex((k) => k !== 'blank');
  return index === -1 ? undefined : index;
}

function isBlank(line: string): boolean {
  return graphemes(line).every((c) => c === ' ' || c === '\t' || c === '\r');
}

function isATXHeading(line: string): boolean {
  const chars = graphemes(line);
  const spaces = prefixCount(chars, ' ');
  if (spaces > 3) return false;
  const hashes = prefixCount(chars, '#', spaces);
  if (hashes < 1 || hashes > 6) return false;
  const after = chars[spaces + hashes];
  return after === undefined || after === ' ' || after === '\t' || after === '\r';
}

function isSetextUnderline(line: string): boolean {
  const chars = graphemes(line);
  const spaces = prefixCount(chars, ' ');
  if (spaces > 3) return false;
  const body = graphemes(trimCharacters(chars.slice(spaces).join(''), ' \t\r'));
  if (body.length < 3) return false;
  const first = body[0];
  if (first !== '=' && first !== '-') return false;
  return body.every((c) => c === first);
}

function fenceMarker(line: string): FenceMarker | undefined {
  const chars = graphemes(line);
  const spaces = prefixCount(chars, ' ');
  if (spaces > 3) return undefined;
  const char = chars[spaces];
  if (char !== '`' && char !== '~') return undefined;
  const length = prefixCount(chars, char, spaces);
  if (length < 3) return undefined;
  const info = trimCharacters(chars.slice(spaces + length).join(''), ' \t\r');
  if (char === '`' && info.includes('`')) return undefined;
  return { char, length, infoIsEmpty: info.length === 0 };
}

// MARK: Titles (metadata only; block text is never changed)

function titleFor(lines: string[], kinds: LineKind[], number: number): string {
  const index = kinds.indexOf('heading');
  if (index !== -1) {
    const raw = graphemes(trimCharacters(lines[index], ' \t\r'));
    const text = trimWhitespaces(raw.slice(prefixCount(raw, '#')).join(''));
    const cleaned = trimCharacters(text, '# ');
    if (cleaned.length > 0) return shorten(cleaned);
  }
  if (kinds[0] === 'fence' && lines.length > 0) {
    const info = trimCharacters(lines[0], ' \t\r`~');
    return info.length === 0 ? `Code ${number}` : `Code (${shorten(info)})`;
  }
  const first = lines.find((l) => !isBlank(l));
  if (first !== undefined) return shorten(trimCharacters(first, ' \t\r'));
  return `Part ${number}`;
}

/** Shorten to at most `limit` grapheme clusters, ending with "…" when shortened. */
function shorten(s: string, limit = 60): string {
  const chars = graphemes(s);
  return chars.length <= limit ? s : chars.slice(0, limit - 1).join('') + '…';
}
