/**
 * Ported from HCG RePrompter — Sources/RePrompterCore/TextSegmentation.swift (commit 0e91066)
 * © 2026 Hakmi Capital Group.
 * Behaviour change: none intended; Swift `Character` handling goes through ./swiftText.
 */
import {
  characters,
  count,
  dropFirst,
  isLetter,
  isLowercase,
  isNumber,
  isUppercase,
  isWhitespace,
  splitWhere,
  trimCharacters,
  trimSpaces,
} from './swiftText';

export type PromptUnitKind = 'sentence' | 'listItem' | 'heading' | 'codeBlock';

/** A unit of prompt text: a sentence, a list item, a heading or a verbatim code block. */
export interface PromptUnit {
  kind: PromptUnitKind;
  /**
   * The unit text. For list items the list marker is removed. Code blocks
   * include their fences and are never modified.
   */
  text: string;
  /** Index of the paragraph (blank-line separated block) the unit came from. */
  paragraph: number;
}

const abbreviations: ReadonlySet<string> = new Set([
  'e.g.', 'i.e.', 'etc.', 'vs.', 'mr.', 'mrs.', 'ms.', 'dr.', 'prof.', 'inc.', 'ltd.',
  'approx.', 'no.', 'fig.', 'cf.', 'al.', 'st.', 'jr.', 'sr.', 'u.s.', 'a.m.', 'p.m.',
]);

const listMarkers = ['- [ ] ', '- [x] ', '- ', '* ', '• ', '+ ', '– '];

/** Returns the heading text for Markdown headings (`# Title`). */
function headingText(line: string): string | null {
  if (!line.startsWith('#')) return null;
  let hashes = 0;
  while (hashes < line.length && line[hashes] === '#') hashes += 1;
  if (hashes > 6) return null;
  const rest = line.slice(hashes);
  if (characters(rest)[0] !== ' ') return null;
  const text = trimSpaces(rest);
  return text === '' ? null : text;
}

/** Returns the item text if the line is a bullet or numbered list item. */
function listItemText(line: string): string | null {
  for (const marker of listMarkers) {
    if (line.startsWith(marker)) return trimSpaces(line.slice(marker.length));
  }
  // "1. ", "12) ", "a) "
  const chars = characters(line).slice(0, 6);
  let i = 0;
  while (i < chars.length && i < 3 && isNumber(chars[i])) i += 1;
  const isLetterMarker = i === 0 && chars.length > 0 && isLetter(chars[0]) && isLowercase(chars[0]);
  if (isLetterMarker) i = 1;
  if (!(i > 0 && i + 1 < chars.length)) return null;
  const terminator = chars[i];
  if (!((terminator === ')' || (terminator === '.' && !isLetterMarker)) && chars[i + 1] === ' ')) return null;
  return trimSpaces(dropFirst(line, i + 2));
}

/** Splits a single line into sentences. Keeps decimals, versions, URLs and common abbreviations intact. */
function splitSentences(line: string): string[] {
  const words = line.split(' ').filter((word) => word !== '');
  const sentences: string[] = [];
  let current: string[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    current.push(word);
    const wordChars = characters(word);
    const last = wordChars[wordChars.length - 1];
    if (last !== '.' && last !== '!' && last !== '?') continue;
    if (abbreviations.has(word.toLowerCase())) continue;
    // Single-letter initials such as "J."
    if (wordChars.length === 2 && isUppercase(wordChars[0]) && last === '.') continue;
    const nextIndex = i + 1;
    if (nextIndex < words.length && last === '.') {
      const nextFirst = characters(words[nextIndex])[0];
      if (nextFirst === undefined) continue;
      // Break when the next word plausibly starts a sentence. Casual
      // prompts often start sentences in lowercase, so a lowercase
      // start also counts unless the word looks like an abbreviation,
      // file name or version ("e.g.", "U.S.", "config.json.").
      const startsSentence = isUppercase(nextFirst) || isNumber(nextFirst) || ['"', "'", '“', '‘', '(', '['].includes(nextFirst);
      const body = wordChars.slice(0, -1);
      const looksAbbreviated = body.includes('.') || body.filter(isLetter).length < 2;
      if (!startsSentence && (looksAbbreviated || !isLetter(nextFirst))) continue;
    }
    sentences.push(current.join(' '));
    current = [];
  }
  if (current.length > 0) sentences.push(current.join(' '));
  return sentences;
}

/** Splits prompt text into units without losing any non-whitespace content. */
export const TextSegmenter = {
  abbreviations,

  segment(text: string): PromptUnit[] {
    const units: PromptUnit[] = [];
    let paragraph = 0;
    let inCode = false;
    let codeLines: string[] = [];
    let previousLineBlank = false;

    for (const rawLine of text.split('\n')) {
      const trimmed = trimSpaces(rawLine);

      if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
        if (inCode) {
          codeLines.push(rawLine);
          units.push({ kind: 'codeBlock', text: codeLines.join('\n'), paragraph });
          codeLines = [];
          inCode = false;
        } else {
          inCode = true;
          codeLines = [rawLine];
        }
        previousLineBlank = false;
        continue;
      }
      if (inCode) {
        codeLines.push(rawLine);
        continue;
      }

      if (trimmed === '') {
        if (!previousLineBlank && units.length > 0) paragraph += 1;
        previousLineBlank = true;
        continue;
      }
      previousLineBlank = false;

      const heading = headingText(trimmed);
      if (heading !== null) {
        units.push({ kind: 'heading', text: heading, paragraph });
        continue;
      }
      const item = listItemText(trimmed);
      if (item !== null) {
        if (item !== '') units.push({ kind: 'listItem', text: item, paragraph });
        continue;
      }
      for (const sentence of splitSentences(trimmed)) {
        units.push({ kind: 'sentence', text: sentence, paragraph });
      }
    }

    // An unterminated code fence is kept verbatim.
    if (inCode && codeLines.length > 0) {
      units.push({ kind: 'codeBlock', text: codeLines.join('\n'), paragraph });
    }
    return units;
  },

  headingText,
  listItemText,
  splitSentences,
};

const edgePunctuation = '.,;:!?"\'“”‘’()[]{}<>*`';

function isWordCharacter(character: string): boolean {
  return (
    isLetter(character) || isNumber(character) || character === "'" || character === '’' ||
    character === '-' || character === '+' || character === '#'
  );
}

/** Word-level tokenization used for analysis and preservation checks. */
export const Tokenizer = {
  edgePunctuation,

  /**
   * Splits on whitespace and strips surrounding punctuation, keeping inner
   * punctuation so identifiers, versions, paths and URLs survive intact.
   */
  tokens(text: string): string[] {
    return splitWhere(text, isWhitespace)
      .map((token) => trimCharacters(token, edgePunctuation))
      .filter((token) => token !== '');
  },

  trimPunctuation(token: string): string {
    return trimCharacters(token, edgePunctuation);
  },

  /** Lowercased alphabetic words, for keyword matching. */
  words(text: string): string[] {
    return splitWhere(text.toLowerCase(), (character) => !isWordCharacter(character))
      .map((word) => trimCharacters(word, "'’-"))
      .filter((word) => word !== '');
  },
};

/** Swift `String.count` for prompt text (grapheme clusters). */
export function characterCount(text: string): number {
  return count(text);
}
