/**
 * Ported from HCG RePrompter — Sources/RePrompterCore/PreservationChecker.swift (commit 0e91066)
 * © 2026 Hakmi Capital Group.
 * Behaviour change: `PreservationReport` also carries its derived `missing`, `preservedCount` and
 * `isComplete` values (computed once by `makePreservationReport`); Swift computes them on access.
 */
import type { ValidationWarning } from './enhancementModels';
import {
  characters,
  count,
  isLetter,
  isLowercase,
  isNumber,
  isUppercase,
  prefix,
  splitWhitespace,
  trimSpaces,
} from './swiftText';
import { TextSanitizer } from './textSanitizer';
import { TextSegmenter, Tokenizer } from './textSegmentation';

export type PreservationAnchorKind =
  | 'number'
  | 'quotedText'
  | 'url'
  | 'identifier'
  | 'acronym'
  | 'codeBlock'
  | 'negation';

export const PRESERVATION_ANCHOR_KINDS: readonly PreservationAnchorKind[] = [
  'number', 'quotedText', 'url', 'identifier', 'acronym', 'codeBlock', 'negation',
];

/**
 * A concrete detail from the original prompt that an enhanced prompt must keep:
 * numbers, quoted text, URLs, code identifiers, acronyms, verbatim code and negated instructions.
 */
export interface PreservationAnchor {
  kind: PreservationAnchorKind;
  value: string;
  /** For negations: the content words that must appear near a negation. */
  keywords: string[];
}

export interface AnchorStatus {
  anchor: PreservationAnchor;
  preserved: boolean;
}

/** The result of comparing an enhanced prompt against the original. */
export interface PreservationReport {
  statuses: AnchorStatus[];
  /** Anchors that were not found (derived from `statuses`). */
  readonly missing: PreservationAnchor[];
  readonly preservedCount: number;
  readonly isComplete: boolean;
}

export function makePreservationReport(statuses: AnchorStatus[]): PreservationReport {
  return {
    statuses,
    missing: statuses.filter((status) => !status.preserved).map((status) => status.anchor),
    preservedCount: statuses.filter((status) => status.preserved).length,
    isComplete: statuses.every((status) => status.preserved),
  };
}

export const EMPTY_PRESERVATION_REPORT: PreservationReport = makePreservationReport([]);

const stopWords: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with', 'by', 'at', 'from',
  'is', 'are', 'be', 'it', 'this', 'that', 'these', 'those', 'as', 'any', 'all', 'my', 'your', 'our',
  'do', 'does', "don't", 'dont', 'not', 'never', 'no', 'avoid', 'without', 'must', "mustn't", 'should',
  "shouldn't", "can't", 'cannot', "won't", 'use', 'using', 'please', 'you', 'we', 'i', 'me', 'us',
  'them', 'they', 'their', 'its', 'into', 'than', 'then', 'so', 'if', 'else', 'also', 'just', 'only',
  'will', 'would', 'could', 'can', 'have', 'has', 'had', 'was', 'were', 'been', 'being', 'make', 'sure',
]);

const negationWords = [
  "don't", 'dont', 'do not', 'never', 'avoid', 'must not', "mustn't", 'should not', "shouldn't",
  'without', 'no ', 'not ', 'exclude', 'cannot', "can't", "won't", 'refrain', 'prohibit', 'forbid',
  'free of', 'omit',
];

function classifyToken(token: string): PreservationAnchorKind | null {
  const lower = token.toLowerCase();
  if (lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('www.')) return 'url';
  const chars = characters(token);
  if (chars.some(isNumber)) {
    // Ordinals such as "1st" and list-like numbers are still details worth keeping.
    return chars.some(isLetter) && !isNumber(chars[0]) ? 'identifier' : 'number';
  }
  const letters = chars.filter(isLetter);
  if (letters.length < 2) return null;
  // Acronyms: API, JSON, HCG (all caps, 2–8 letters).
  if (letters.length <= 8 && chars.every((c) => isUppercase(c) || isNumber(c) || c === '-' || c === '&')) {
    return 'acronym';
  }
  // Code-like identifiers: snake_case, dotted.names, file.ext, paths, camelCase, PascalCase with inner caps.
  if (token.includes('_') || token.includes('/') || token.includes('::') || token.includes('()')) return 'identifier';
  if (token.includes('.') && !token.endsWith('.')) {
    const parts = token.split('.').filter((part) => part !== '');
    if (parts.length >= 2) return 'identifier';
  }
  const innerCapitals = chars.slice(1).filter(isUppercase).length;
  const lowercase = chars.filter(isLowercase).length;
  if (innerCapitals >= 1 && lowercase >= 1) return 'identifier'; // camelCase, SwiftUI, macOS, PostgreSQL
  return null;
}

function quotedSegments(text: string): string[] {
  const results: string[] = [];
  const pairs: [string, string][] = [['"', '"'], ['“', '”'], ['`', '`']];
  const chars = characters(text);
  for (const [open, close] of pairs) {
    let current: string | null = null;
    for (const character of chars) {
      if (current !== null) {
        if (character === close) {
          const trimmed = trimSpaces(current);
          if (trimmed !== '' && count(trimmed) <= 200) results.push(trimmed);
          current = null;
        } else {
          current += character;
        }
      } else if (character === open) {
        current = '';
      }
    }
  }
  return results;
}

function contentWords(text: string): string[] {
  const seen = new Set<string>();
  return Tokenizer.words(text).filter((word) => {
    if (count(word) < 3 || stopWords.has(word) || seen.has(word)) return false;
    seen.add(word);
    return true;
  });
}

function negationAnchor(sentence: string): PreservationAnchor | null {
  const lower = ' ' + sentence.toLowerCase() + ' ';
  if (!negationWords.some((word) => lower.includes(' ' + word))) return null;
  const keywords = contentWords(sentence);
  if (keywords.length === 0) return null;
  return { kind: 'negation', value: sentence, keywords: keywords.slice(0, 6) };
}

/**
 * A negated instruction is preserved when some sentence of the enhanced
 * prompt contains a negation together with most of its content words.
 */
function negationPreserved(keywords: string[], sentences: string[]): boolean {
  if (keywords.length === 0) return true;
  const required = Math.max(1, Math.ceil(keywords.length * 0.6));
  for (const sentence of sentences) {
    if (!negationWords.some((word) => sentence.includes(' ' + word))) continue;
    const words = new Set(Tokenizer.words(sentence));
    const hits = keywords.filter((keyword) => words.has(keyword) || sentence.includes(keyword)).length;
    if (hits >= required) return true;
  }
  return false;
}

function stripFences(code: string): string {
  const lines = code.split('\n');
  const first = lines.length > 0 ? trimSpaces(lines[0]) : undefined;
  if (first !== undefined && (first.startsWith('```') || first.startsWith('~~~'))) lines.shift();
  const last = lines.length > 0 ? trimSpaces(lines[lines.length - 1]) : undefined;
  if (last !== undefined && (last.startsWith('```') || last.startsWith('~~~'))) lines.pop();
  return lines.join('\n');
}

function collapseWhitespace(text: string): string {
  return splitWhitespace(text).join(' ');
}

function truncate(text: string, limit: number): string {
  return count(text) <= limit ? text : prefix(text, limit - 1) + '…';
}

function anchors(original: string): PreservationAnchor[] {
  const result: PreservationAnchor[] = [];
  const seen = new Set<string>();
  const add = (anchor: PreservationAnchor): void => {
    const key = anchor.kind + '|' + anchor.value.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(anchor);
    }
  };

  for (const unit of TextSegmenter.segment(TextSanitizer.sanitize(original))) {
    if (unit.kind === 'codeBlock') {
      add({ kind: 'codeBlock', value: unit.text, keywords: [] });
      continue;
    }
    for (const quoted of quotedSegments(unit.text)) add({ kind: 'quotedText', value: quoted, keywords: [] });
    for (const token of Tokenizer.tokens(unit.text)) {
      const kind = classifyToken(token);
      if (kind) add({ kind, value: token, keywords: [] });
    }
    const negation = negationAnchor(unit.text);
    if (negation) add(negation);
  }
  return result;
}

function checkAnchors(anchorList: PreservationAnchor[], enhanced: string): PreservationReport {
  const sanitized = TextSanitizer.sanitize(enhanced);
  const lowerEnhanced = sanitized.toLowerCase();
  const tokenSet = new Set(Tokenizer.tokens(sanitized).map((token) => token.toLowerCase()));
  const sentences = TextSegmenter.segment(sanitized).map((unit) => ' ' + unit.text.toLowerCase() + ' ');
  const compactEnhanced = collapseWhitespace(sanitized);

  const statuses = anchorList.map((anchor): AnchorStatus => {
    let preserved: boolean;
    switch (anchor.kind) {
      case 'number':
      case 'identifier':
      case 'acronym': {
        const value = anchor.value.toLowerCase();
        preserved = tokenSet.has(value) || (lowerEnhanced.includes(value) && count(anchor.value) >= 4);
        break;
      }
      case 'url':
      case 'quotedText':
        preserved = lowerEnhanced.includes(anchor.value.toLowerCase());
        break;
      case 'codeBlock':
        preserved = compactEnhanced.includes(collapseWhitespace(stripFences(anchor.value)));
        break;
      case 'negation':
        preserved = negationPreserved(anchor.keywords, sentences);
        break;
    }
    return { anchor, preserved };
  });
  return makePreservationReport(statuses);
}

/**
 * Deterministic check that concrete details survive an enhancement. This is a
 * safety net, not a semantic judge: it flags details that appear to be missing
 * so the user can review them.
 */
export const PreservationChecker = {
  stopWords,
  negationWords,

  anchors,

  /** Swift `check(original:enhanced:)`. */
  check(original: string, enhanced: string): PreservationReport {
    return checkAnchors(anchors(original), enhanced);
  },

  /** Swift `check(anchors:enhanced:)`. */
  checkAnchors,

  /** Converts missing anchors into user-facing warnings. */
  warnings(report: PreservationReport): ValidationWarning[] {
    return report.missing.slice(0, 20).map((anchor): ValidationWarning => {
      switch (anchor.kind) {
        case 'negation':
          return {
            kind: 'possiblyDroppedConstraint',
            message: `A restriction from the original may be missing or weakened: “${truncate(anchor.value, 140)}”`,
          };
        case 'codeBlock':
          return { kind: 'possiblyDroppedContent', message: 'A code block from the original is not reproduced verbatim.' };
        default:
          return {
            kind: 'possiblyDroppedContent',
            message: `“${truncate(anchor.value, 80)}” from the original does not appear in the enhanced prompt.`,
          };
      }
    });
  },

  classifyToken,
  quotedSegments,
  negationAnchor,
  contentWords,
  negationPreserved,
  stripFences,
  collapseWhitespace,
  truncate,
};
