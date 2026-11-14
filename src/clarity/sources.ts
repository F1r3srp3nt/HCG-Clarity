/**
 * Source library helpers that run in both the browser and Node.
 * Originals are stored byte-for-byte; text is decoded strictly as UTF-8 so a
 * wrong encoding is reported instead of silently producing replacement characters.
 */
import { newIdLocal, nowIso, type Source } from './model';
import { DOCUMENT_MIMES, extractDocument, type DocumentKind, type ExtractOptions } from './extract';

export const TEXT_EXTENSIONS = ['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.log', '.html', '.htm', '.xml', '.yaml', '.yml'] as const;
export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const;
import { MAX_TEXT_SOURCE_BYTES, SourceError } from './common';

export { MAX_TEXT_SOURCE_BYTES, SourceError };

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Strict UTF-8 decode. Removes a leading byte-order mark only. */
export function decodeUtf8(bytes: Uint8Array, name: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new SourceError(`"${name}" is not UTF-8 text. Save it as UTF-8 and add it again.`);
  }
}

export function isTextFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return TEXT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function textMime(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'text/markdown';
  if (lower.endsWith('.csv')) return 'text/csv';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'text/html';
  return 'text/plain';
}

/** Builds a text source from original bytes. */
export async function textSourceFromBytes(name: string, bytes: Uint8Array, origin: Source['origin'], addedAt = nowIso()): Promise<Source> {
  if (bytes.byteLength > MAX_TEXT_SOURCE_BYTES) throw new SourceError(`"${name}" is larger than 5 MB.`);
  const text = decodeUtf8(bytes, name);
  if (!text.trim()) throw new SourceError(`"${name}" is empty.`);
  return {
    id: newIdLocal('src'),
    name,
    kind: 'text',
    mime: origin === 'paste' ? 'text/plain' : textMime(name),
    bytes: bytes.byteLength,
    sha256: await sha256Hex(bytes),
    origin,
    addedAt,
    text,
    width: 0,
    height: 0,
    note: '',
    extraction: null,
  };
}

/**
 * A text source made from a PDF or Word document: the original bytes are what is stored (and
 * hashed); `text` is the extracted text, and `extraction` says how it was obtained.
 */
export async function documentSourceFromBytes(name: string, bytes: Uint8Array, kind: DocumentKind, origin: Source['origin'] = 'file', options: ExtractOptions = {}): Promise<Source> {
  const ex = await extractDocument(kind, bytes, name, options);
  return {
    id: newIdLocal('src'),
    name,
    kind: 'text',
    mime: DOCUMENT_MIMES[kind],
    bytes: bytes.byteLength,
    sha256: await sha256Hex(bytes),
    origin,
    addedAt: nowIso(),
    text: ex.text,
    width: 0,
    height: 0,
    note: '',
    extraction: { from: kind, method: ex.method, pageStartLines: ex.pageStartLines, warnings: ex.warnings, ocrPages: ex.ocrPages ?? [] },
  };
}

export async function textSourceFromPaste(title: string, text: string): Promise<{ source: Source; bytes: Uint8Array }> {
  const bytes = new TextEncoder().encode(text);
  const source = await textSourceFromBytes(title.trim() || 'Pasted text', bytes, 'paste');
  return { source, bytes };
}

/** Lines of a source as references use them: split on LF after converting CRLF/CR to LF. */
export function sourceLines(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split('\n');
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
