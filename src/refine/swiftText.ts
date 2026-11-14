/**
 * Support code for the port of HCG RePrompter (commit 0e91066) — © 2026 Hakmi Capital Group.
 * No Swift counterpart: these helpers reproduce the Swift `String`/`Character`/`CharacterSet`
 * semantics the ported algorithms rely on.
 * Behaviour change: grapheme clusters come from `Intl.Segmenter` (code points when it is
 * unavailable) and `isNumber` uses the Unicode general category N rather than Numeric_Type.
 */

type GraphemeSegmenter = { segment(input: string): Iterable<{ segment: string }> };

let cachedSegmenter: GraphemeSegmenter | null | undefined;

function graphemeSegmenter(): GraphemeSegmenter | null {
  if (cachedSegmenter === undefined) {
    const intl = Intl as unknown as {
      Segmenter?: new (locale?: string, options?: { granularity: 'grapheme' }) => GraphemeSegmenter;
    };
    cachedSegmenter = typeof intl.Segmenter === 'function' ? new intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
  }
  return cachedSegmenter;
}

/** True when every UTF-16 unit is its own Swift `Character` (ASCII and no CR LF pair). */
function isSimple(text: string): boolean {
  return /^[\x00-\x7F]*$/.test(text) && !text.includes('\r\n');
}

/** The Swift `Character`s (extended grapheme clusters) of a string. */
export function characters(text: string): string[] {
  if (isSimple(text)) return text.split('');
  const segmenter = graphemeSegmenter();
  if (!segmenter) return Array.from(text);
  const result: string[] = [];
  for (const part of segmenter.segment(text)) result.push(part.segment);
  return result;
}

/** Swift `String.count`. */
export function count(text: string): number {
  return isSimple(text) ? text.length : characters(text).length;
}

/** Swift `String.prefix(n)`. */
export function prefix(text: string, length: number): string {
  if (length <= 0) return '';
  if (isSimple(text)) return text.slice(0, length);
  // A string cannot have more characters than UTF-16 units.
  if (text.length <= length) return text;
  return characters(text).slice(0, length).join('');
}

/** Swift `String.dropFirst(n)`. */
export function dropFirst(text: string, length: number): string {
  if (length <= 0) return text;
  if (isSimple(text)) return text.slice(length);
  return characters(text).slice(length).join('');
}

const LETTER = /^\p{Alphabetic}/u;
const NUMBER = /^\p{N}/u;
const UPPERCASE = /^\p{Uppercase}/u;
const LOWERCASE = /^\p{Lowercase}/u;
/** Unicode White_Space, which is also Foundation's `.whitespacesAndNewlines`. */
const WHITESPACE = /^[\t\n\u000B\f\r \u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/u;

/** Swift `Character.isLetter` (decided by the first scalar). */
export function isLetter(character: string): boolean {
  return LETTER.test(character);
}

/** Swift `Character.isNumber` (approximated by general category N). */
export function isNumber(character: string): boolean {
  return NUMBER.test(character);
}

/** Swift `Character.isUppercase`. */
export function isUppercase(character: string): boolean {
  if (character === '') return false;
  if (UPPERCASE.test(character) && Array.from(character).length === 1) return true;
  return character.toUpperCase() === character && character.toLowerCase() !== character;
}

/** Swift `Character.isLowercase`. */
export function isLowercase(character: string): boolean {
  if (character === '') return false;
  if (LOWERCASE.test(character) && Array.from(character).length === 1) return true;
  return character.toLowerCase() === character && character.toUpperCase() !== character;
}

/** Swift `Character.isWhitespace`. */
export function isWhitespace(character: string): boolean {
  return WHITESPACE.test(character);
}

/** Swift `split(whereSeparator:)` with empty subsequences omitted. */
export function splitWhere(text: string, isSeparator: (character: string) => boolean): string[] {
  const parts: string[] = [];
  let current = '';
  for (const character of characters(text)) {
    if (isSeparator(character)) {
      if (current !== '') parts.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  if (current !== '') parts.push(current);
  return parts;
}

/** `split(whereSeparator: { $0.isWhitespace })`. */
export function splitWhitespace(text: string): string[] {
  return splitWhere(text, isWhitespace);
}

/** `trimmingCharacters(in: .whitespaces)`: tab and the Unicode space separators. */
export function trimSpaces(text: string): string {
  return text.replace(/^[\t\p{Zs}]+|[\t\p{Zs}]+$/gu, '');
}

/** `trimmingCharacters(in: .whitespacesAndNewlines)`. */
export function trimSpacesAndNewlines(text: string): string {
  return text.replace(
    /^[\t\n\u000B\f\r\u0085\u2028\u2029\p{Zs}]+|[\t\n\u000B\f\r\u0085\u2028\u2029\p{Zs}]+$/gu,
    '',
  );
}

/** `trimmingCharacters(in: CharacterSet(charactersIn: set))`, scalar by scalar. */
export function trimCharacters(text: string, set: string): string {
  const members = new Set(Array.from(set));
  const scalars = Array.from(text);
  let start = 0;
  let end = scalars.length;
  while (start < end && members.has(scalars[start])) start += 1;
  while (end > start && members.has(scalars[end - 1])) end -= 1;
  return scalars.slice(start, end).join('');
}

/** `replacingOccurrences(of:with:)` for literal strings. */
export function replaceAll(text: string, target: string, replacement: string): string {
  return target === '' ? text : text.split(target).join(replacement);
}

/** `Int.formatted()` in the en-US style the Swift tests run under ("100,000"). */
export function formatInteger(value: number): string {
  return String(Math.trunc(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** `Int(string) != nil`. */
export function isSwiftInt(text: string): boolean {
  if (!/^[+-]?[0-9]+$/.test(text)) return false;
  const value = BigInt(text);
  return value >= -(2n ** 63n) && value <= 2n ** 63n - 1n;
}
