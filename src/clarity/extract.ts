/**
 * Text extraction from PDF (pdf.js) and Word .docx (mammoth) files, for the source library.
 * Runs in the browser and in Node (tests). Libraries are loaded on first use.
 *
 * Documents are untrusted: pdf.js 6 has no eval code path, runs here with XFA disabled and never
 * executes document scripts (no scripting sandbox is loaded); mammoth's raw-text mode reads only the document text and fetches nothing. Sizes and
 * page counts are limited. The original bytes are kept unchanged by the caller; what this returns
 * is *extracted* text, recorded as such on the source, and references point into it.
 */
import { MAX_TEXT_SOURCE_BYTES, SourceError } from './common';
import { OCR_LANGUAGES, recognisePages, type OcrImage, type OcrRun } from './ocr';

export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
export const MAX_PDF_PAGES = 1000;

export type DocumentKind = 'pdf' | 'docx';

export interface Extracted {
  text: string;
  /** 1-based line on which each page starts (PDF only; empty for Word). */
  pageStartLines: number[];
  method: string;
  warnings: string[];
  /** PDF pages whose text came from OCR. */
  ocrPages?: number[];
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

/** Raised when PDF pages have no text layer and the caller has not decided about OCR yet. */
export class NeedsOcrError extends SourceError {
  constructor(
    public readonly fileName: string,
    /** 1-based page numbers without text. */
    public readonly emptyPages: number[],
    public readonly totalPages: number,
  ) {
    super(
      emptyPages.length === totalPages
        ? `"${fileName}" has no text layer (it looks like a scan). Its text can be recognised with OCR.`
        : `${emptyPages.length} of ${totalPages} pages of "${fileName}" have no text layer. They can be recognised with OCR.`,
    );
  }
  get hasText(): boolean {
    return this.emptyPages.length < this.totalPages;
  }
}

export interface ExtractOptions {
  /**
   * What to do with PDF pages that have no text layer: undefined = stop with NeedsOcrError so the
   * user can decide; false = import without them; an OcrRun = recognise them on this device.
   */
  ocr?: OcrRun | false;
}

/** Longest edge of a page image for OCR, in pixels (about 200–300 dpi for common page sizes). */
const OCR_MAX_EDGE = 3000;

interface CanvasAndContext {
  canvas: { width: number; height: number; toBuffer?: (mime: string) => Uint8Array } & object;
  context: object;
}

/** Renders one page to an image for OCR: a PNG buffer in Node, the canvas itself in the browser. */
async function renderForOcr(doc: PDFDocumentProxyLike, pageNumber: number): Promise<OcrImage> {
  const page = await doc.getPage(pageNumber);
  try {
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(OCR_MAX_EDGE / Math.max(base.width, base.height), 300 / 72);
    const viewport = page.getViewport({ scale });
    const factory = doc.canvasFactory as { create(w: number, h: number): CanvasAndContext };
    const cc = factory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await page.render({ canvas: cc.canvas as HTMLCanvasElement, canvasContext: cc.context as CanvasRenderingContext2D, viewport, background: '#ffffff' }).promise;
    return typeof cc.canvas.toBuffer === 'function' ? new Uint8Array(cc.canvas.toBuffer('image/png')) : (cc.canvas as unknown as HTMLCanvasElement);
  } finally {
    page.cleanup();
  }
}

type PDFDocumentProxyLike = Awaited<ReturnType<typeof import('pdfjs-dist/legacy/build/pdf.mjs').getDocument>['promise']>;

function rangeText(pages: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++;
    out.push(i === j ? `${pages[i]}` : `${pages[i]}–${pages[j]}`);
    i = j;
  }
  return out.join(', ');
}

async function extractPdf(bytes: Uint8Array, name: string, options: ExtractOptions): Promise<Extracted> {
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
      const clean = cleanExtractedText(pageText(content.items));
      if (!clean) emptyPages.push(p);
      pages.push(clean);
      page.cleanup();
    }

    const warnings: string[] = [];
    let ocrPages: number[] = [];
    let ocrNote = '';
    if (emptyPages.length && options.ocr === undefined) throw new NeedsOcrError(name, emptyPages, doc.numPages);
    if (emptyPages.length && options.ocr) {
      const run = options.ocr;
      const results = await recognisePages(
        emptyPages.map((p) => () => renderForOcr(doc, p)),
        run,
      );
      const low: number[] = [];
      results.forEach((r, i) => {
        const text = cleanExtractedText(r.text);
        pages[emptyPages[i] - 1] = text;
        if (text) ocrPages.push(emptyPages[i]);
        if (text && r.confidence < 70) low.push(emptyPages[i]);
      });
      const recognised = results.filter((r) => cleanExtractedText(r.text));
      const mean = recognised.length ? Math.round(recognised.reduce((a, r) => a + r.confidence, 0) / recognised.length) : 0;
      const langs = run.languages.map((l) => OCR_LANGUAGES[l]).join(' + ');
      ocrNote = ` + Tesseract OCR (${langs})`;
      if (ocrPages.length) {
        warnings.push(
          `Page${ocrPages.length === 1 ? '' : 's'} ${rangeText(ocrPages)} ${ocrPages.length === 1 ? 'was' : 'were'} read with OCR (${langs}); average confidence ${mean}%. Recognition errors are possible: check names, numbers and quotes against the original.`,
        );
      }
      if (low.length) warnings.push(`Low OCR confidence on page${low.length === 1 ? '' : 's'} ${rangeText(low)}: the text there may be unreliable.`);
      const still = emptyPages.filter((p) => !ocrPages.includes(p));
      if (still.length) warnings.push(`No text was recognised on page${still.length === 1 ? '' : 's'} ${rangeText(still)}.`);
    } else if (emptyPages.length) {
      warnings.push(`No text on page${emptyPages.length === 1 ? '' : 's'} ${rangeText(emptyPages)} (scanned or image-only; imported without OCR).`);
    }

    // Pages are separated by a blank line, so a page boundary is also a paragraph boundary for Distil.
    const pageStartLines: number[] = [];
    let line = 1;
    for (const pg of pages) {
      pageStartLines.push(line);
      line += (pg ? pg.split('\n').length : 1) + 1;
    }
    const text = pages.join('\n\n');
    if (!text.trim()) {
      throw new SourceError(
        options.ocr
          ? `No text could be recognised in "${name}", even with OCR. The scan may be too faint, rotated or in another language.`
          : `"${name}" has no extractable text (it may be scanned images).`,
      );
    }
    warnings.push('Text extracted from a PDF: reading order, columns, tables and hyphenation may differ from the printed page.');
    return { text, pageStartLines, method: `pdf.js ${pdfjs.version}${ocrNote}`, warnings, ocrPages };
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

export async function extractDocument(kind: DocumentKind, bytes: Uint8Array, name: string, options: ExtractOptions = {}): Promise<Extracted> {
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) throw new SourceError(`"${name}" is larger than 50 MB.`);
  const out = kind === 'pdf' ? await extractPdf(bytes, name, options) : await extractDocx(bytes, name);
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

/** Page label for an excerpt, marked "(OCR)" when any of its pages was read with OCR. */
export function pagesWithOcr(ex: { from?: string; pageStartLines: readonly number[]; ocrPages?: readonly number[] }, lineStart: number, lineEnd: number): string {
  if (ex.from === 'image') return 'OCR';
  const label = pagesForLines(ex.pageStartLines, lineStart, lineEnd);
  if (!label || !ex.ocrPages?.length) return label;
  const pageOf = (line: number) => ex.pageStartLines.filter((s) => s <= line).length;
  for (let p = pageOf(lineStart); p <= pageOf(lineEnd); p++) if (ex.ocrPages.includes(p)) return `${label} (OCR)`;
  return label;
}

/** Longest edge of an image passed to OCR, in pixels. Larger photos are scaled down first. */
const OCR_MAX_IMAGE_EDGE = 4000;

/** Browser: decodes PNG, JPEG or WebP to a canvas (also normalises formats Tesseract may not read). Node: the bytes. */
async function imageForOcr(image: Blob | Uint8Array): Promise<OcrImage> {
  if (typeof createImageBitmap === 'function' && typeof document !== 'undefined') {
    const blob = image instanceof Blob ? image : new Blob([image as Uint8Array<ArrayBuffer>]);
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, OCR_MAX_IMAGE_EDGE / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    return canvas;
  }
  return image instanceof Blob ? new Uint8Array(await image.arrayBuffer()) : image;
}

/** Recognises the text in an image source with on-device OCR. */
export async function extractImageText(image: Blob | Uint8Array, name: string, run: OcrRun): Promise<Extracted> {
  const [result] = await recognisePages([() => imageForOcr(image)], run);
  const text = cleanExtractedText(result.text);
  if (!text) throw new SourceError(`No text was recognised in "${name}". The image may contain no text, or it may be too small, blurred or rotated.`);
  if (new TextEncoder().encode(text).byteLength > MAX_TEXT_SOURCE_BYTES) throw new SourceError(`The text recognised in "${name}" is larger than 5 MB.`);
  const langs = run.languages.map((l) => OCR_LANGUAGES[l]).join(' + ');
  const warnings = [`Read with OCR (${langs}); confidence ${result.confidence}%. Recognition errors are possible: check names, numbers and quotes against the image.`];
  if (result.confidence < 70) warnings.push('Low OCR confidence: the text may be unreliable.');
  warnings.push('Layout is not preserved: text in columns, tables or diagrams may come out in a different order.');
  return { text, pageStartLines: [], method: `Tesseract OCR (${langs})`, warnings, ocrPages: [] };
}

