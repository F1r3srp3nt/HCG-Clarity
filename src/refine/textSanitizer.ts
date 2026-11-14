/**
 * Ported from HCG RePrompter — Sources/RePrompterCore/TextSanitizer.swift (commit 0e91066)
 * © 2026 Hakmi Capital Group.
 * Behaviour change: none (lone UTF-16 surrogates, which a Swift String cannot hold, pass through).
 */
import { prefix } from './swiftText';

function isAllowed(scalar: number): boolean {
  if (scalar === 0x09 || scalar === 0x0a) return true; // tab, newline
  if (scalar <= 0x1f || scalar === 0x7f) return false; // C0 controls, DEL
  if (scalar >= 0x80 && scalar <= 0x9f) return false; // C1 controls
  if ((scalar >= 0x202a && scalar <= 0x202e) || (scalar >= 0x2066 && scalar <= 0x2069)) return false; // bidi
  if (scalar === 0xfeff) return false; // BOM / zero-width no-break space
  return true;
}

/**
 * Normalizes untrusted text. Prompt text is always treated as data: this never
 * interprets or executes it, it only removes characters that have no place in a
 * prompt (NUL and other C0/C1 control characters, bidi overrides).
 */
export const TextSanitizer = {
  /** Normalizes line endings to `\n` and removes disallowed control characters. Tabs and newlines are preserved. */
  sanitize(text: string): string {
    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    let result = '';
    for (const scalar of normalized) {
      if (isAllowed(scalar.codePointAt(0) as number)) result += scalar;
    }
    return result;
  },

  /** Sanitizes a single-line field such as a title: collapses whitespace, trims, and caps length. */
  sanitizeLine(text: string, maxLength: number): string {
    const cleaned = TextSanitizer.sanitize(text)
      .split(/[\t\n\u000B\f\r\u0085\u2028\u2029\p{Zs}]/u)
      .filter((part) => part !== '')
      .join(' ');
    return prefix(cleaned, maxLength);
  },

  isAllowed,
};
