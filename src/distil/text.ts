// Support code for the Distil port (The Last Sprint — distil/Sources/TokenLabCore, commit 03cc61d).
// No Swift counterpart: these helpers reproduce Swift/Foundation string semantics in plain ECMAScript.

/** Number of bytes `text` occupies in UTF-8 (Swift `text.utf8.count`). A lone surrogate counts as U+FFFD (3 bytes). */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

const segmenter: Intl.Segmenter | undefined =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter('en', { granularity: 'grapheme' })
    : undefined;

/**
 * Extended grapheme clusters, i.e. what Swift calls `Character`s. Uses `Intl.Segmenter`; falls back to
 * code points (`Array.from`) on engines without it.
 */
export function graphemes(text: string): string[] {
  // Fast path: printable ASCII without CR LF pairs is one grapheme per code unit.
  if (/^[\x00-\x7f]*$/.test(text) && !text.includes('\r\n')) return text.split('');
  if (!segmenter) return Array.from(text);
  return Array.from(segmenter.segment(text), (s) => s.segment);
}

/** Foundation `trimmingCharacters(in: CharacterSet(charactersIn: chars))` for a set of BMP characters. */
export function trimCharacters(text: string, chars: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && chars.includes(text[start])) start++;
  while (end > start && chars.includes(text[end - 1])) end--;
  return text.slice(start, end);
}

/** Structural equality for plain JSON-like data (Swift synthesized `Equatable`). `undefined` properties equal absent ones. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);
  for (const key of keys) {
    if (!deepEqual(ra[key], rb[key])) return false;
  }
  return true;
}

/** A random RFC 4122 version 4 identifier (lower-case). Stands in for Swift `UUID()`. */
export function newID(): string {
  const bytes = new Uint8Array(16);
  const source = (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }).crypto;
  if (source && typeof source.getRandomValues === 'function') source.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Foundation `trimmingCharacters(in: .whitespaces)`: Unicode general category Zs plus tab. */
export function trimWhitespaces(text: string): string {
  return text.replace(/^[\p{Zs}\t]+|[\p{Zs}\t]+$/gu, '');
}

/**
 * Swift `String` ordering (`<`): compares Unicode scalar values of the canonically normalised (NFC)
 * strings, not UTF-16 code units as JavaScript `<` does.
 */
export function compareSwiftStrings(a: string, b: string): number {
  const x = Array.from(a.normalize('NFC'), (c) => c.codePointAt(0) as number);
  const y = Array.from(b.normalize('NFC'), (c) => c.codePointAt(0) as number);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
}
