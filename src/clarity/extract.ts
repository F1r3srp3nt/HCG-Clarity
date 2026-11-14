/**
 * Text extraction from PDF (pdf.js) and Word .docx (mammoth) files, for the source library.
 * Runs in the browser and in Node (tests). Libraries are loaded on first use.
 *
 * Documents are untrusted: pdf.js 6 has no eval code path, runs here with XFA disabled and never
 * executes document scripts (no scripting sandbox is loaded); mammoth's raw-text mode reads only the document text and fetches nothing. Sizes and
 * page counts are limited. The original bytes are kept unchanged by the caller; what this returns
 * is *extracted* text, recorded as such on the source, and references point into it.
 */
import { MAX_TEXT_SOURCE_BYTES, SourceError } from './sources';

export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
export const MAX_PDF_PAGES = 1000;

export type DocumentKind = 'pdf' | 'docx';

export interface Extracted {
  text: string;
  /** 1-based line on which each page starts (PDF only; empty for Word). */
  pageStartLines: number[];
  method: string;
  warnings: string[];
}

export const DOCUMENT_MIMES: Record<DocumentKind, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/** Detects the document type from the content, not only the name. */
export function documentKind(name: string, bytes: Uint8Array): DocumentKind | null {
  const lower = name.toLowerCase();
  const isPdf = bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46; // %PDF
  const isZip = bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (lower.endsWith('.pdf')) {
    if (!isPdf) throw new SourceError(`"${name}" is not a valid PDF file.`);
    return 'pdf';
  }
  if (lower.endsWith('.docx')) {
    if (!isZip) throw new SourceError(`"${name}" is not a valid Word (.docx) file.`);
    return 'docx';
  }
  return null;
}

/** Removes control characters (except tab and newline), normalises line breaks and trailing spaces. */
export function cleanExtractedText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .split('\n')
    .map((l) => l.replace(/[ \t ]+$/u, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

let pdfWorkerSrc: string | null = null;
/** Browser only: the URL of pdf.js's worker script (bundled by Vite). Node uses its built-in fake worker. */
export function setPdfWorkerSrc(url: string): void {
  pdfWorkerSrc = url;
}

interface PdfTextItem {
  str: string;
  hasEOL: boolean;
  transform: number[];
  height: number;
}

/**
 * Joins pdf.js text items into lines (pdf.js marks line ends) and inserts a blank line where the
 * vertical gap between two lines is clearly larger than the line height — usually a paragraph or
 * heading break — so Distil can split the page into paragraphs. No text is added or reordered.
 */
export function pageText(items: readonly unknown[]): string {
  const lines: { text: string; y: number; h: number }[] = [];
  let cur: { text: string; y: number; h: number } | null = null;
  for (const raw of items) {
    if (!raw || typeof raw !== 'object' || !('str' in raw)) continue;
    const item = raw as PdfTextItem;
    if (!cur) cur = { text: '', y: item.transform?.[5] ?? 0, h: 0 };
    cur.text += item.str;
    if (item.str.trim()) cur.h = Math.max(cur.h, item.height || 0);
    if (item.hasEOL) {
      lines.push(cur);
      cur = null;
    }
  }
  if (cur) lines.push(cur);
  const out: string[] = [];
  lines.forEach((l, i) => {
    const prev = lines[i - 1];
    if (prev && prev.h > 0 && l.h > 0) {
      const gap = Math.abs(prev.y - l.y);
      if (gap > 1.6 * Math.max(prev.h, l.h)) out.push('');
    }
    out.push(l.text);
  });
  return out.join('\n');
}

async function extractPdf(bytes: Uint8Array, name: string): Promise<Extracted> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  if (pdfWorkerSrc) pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerSrc;
  // pdf.js may transfer (detach) the buffer it is given, so it gets a copy.
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    enableXfa: false,
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
  });
  let doc;
  try {
    doc = await task.promise;
  } catch (e) {
    const n = (e as { name?: string })?.name;
    if (n === 'PasswordException') throw new SourceError(`"${name}" is password-protected. Remove the password and add it again.`);
    throw new SourceError(`"${name}" could not be read as a PDF (${(e as Error)?.message ?? 'unknown error'}).`);
  }
  try {
    if (doc.numPages > MAX_PDF_PAGES) throw new SourceError(`"${name}" has ${doc.numPages} pages; the limit is ${MAX_PDF_PAGES}.`);
    const pages: string[] = [];
    const emptyPages: number[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const t = pageText(content.items);
      const clean = cleanExtractedText(t);
      if (!clean) emptyPages.push(p);
      pages.push(clean);
      page.cleanup();
    }
    // Pages are separated by a blank line, so a page boundary is also a paragraph boundary for Distil.
    const pageStartLines: number[] = [];
    let line = 1;
    const parts: string[] = [];
    for (const pg of pages) {
      pageStartLines.push(line);
      parts.push(pg);
      line += (pg ? pg.split('\n').length : 1) + 1;
    }
    const text = parts.join('\n\n');
    if (!text.trim()) {
      throw new SourceError(`"${name}" has no extractable text (it may be scanned images). Text recognition (OCR) is not supported.`);
    }
    const warnings: string[] = [];
    if (emptyPages.length) warnings.push(`No text on page${emptyPages.length === 1 ? '' : 's'} ${emptyPages.join(', ')} (images or scanned content are not extracted).`);
    warnings.push('Text extracted from a PDF: reading order, columns, tables and hyphenation may differ from the printed page.');
    return { text, pageStartLines, method: `pdf.js ${pdfjs.version}`, warnings };
  } finally {
    await task.destroy();
  }
}

async function extractDocx(bytes: Uint8Array, name: string): Promise<Extracted> {
  const mod = await import('mammoth');
  const mammoth = (mod as unknown as { default?: typeof mod }).default ?? mod;
  const copy = bytes.slice();
  let result: { value: string; messages: { type: string; message: string }[] };
  try {
    // Node reads `buffer`, the browser build reads `arrayBuffer`.
    result = await mammoth.extractRawText({ buffer: copy, arrayBuffer: copy.buffer } as unknown as { arrayBuffer: ArrayBuffer });
  } catch (e) {
    throw new SourceError(`"${name}" could not be read as a Word document (${(e as Error)?.message ?? 'unknown error'}).`);
  }
  const text = cleanExtractedText(result.value);
  if (!text) throw new SourceError(`"${name}" contains no text.`);
  const warnings = [...new Set(result.messages.filter((m) => m.type === 'warning').map((m) => m.message))].slice(0, 5);
  warnings.push('Text extracted from Word: images, text boxes, comments and tracked changes are not included; tables become plain lines.');
  return { text, pageStartLines: [], method: 'mammoth (raw text)', warnings };
}

export async function extractDocument(kind: DocumentKind, bytes: Uint8Array, name: string): Promise<Extracted> {
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) throw new SourceError(`"${name}" is larger than 50 MB.`);
  const out = kind === 'pdf' ? await extractPdf(bytes, name) : await extractDocx(bytes, name);
  if (new TextEncoder().encode(out.text).byteLength > MAX_TEXT_SOURCE_BYTES) {
    throw new SourceError(`The text extracted from "${name}" is larger than 5 MB. Split the document and add the parts.`);
  }
  return out;
}

/** "p. 3" / "pp. 3–4" for a line range, or "" when the source has no pages. */
export function pagesForLines(pageStartLines: readonly number[], lineStart: number, lineEnd: number): string {
  if (!pageStartLines.length) return '';
  const pageOf = (line: number) => {
    let p = 1;
    for (let i = 0; i < pageStartLines.length; i++) if (pageStartLines[i] <= line) p = i + 1;
    return p;
  };
  const a = pageOf(lineStart);
  const b = pageOf(lineEnd);
  return a === b ? `p. ${a}` : `pp. ${a}–${b}`;
}
