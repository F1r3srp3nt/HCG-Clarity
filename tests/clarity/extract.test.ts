/** PDF and Word import: extraction, page references, provenance and failures. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import { cleanExtractedText, documentKind, extractDocument, pagesForLines, pageText } from '../../src/clarity/extract';
import { documentSourceFromBytes, sha256Hex, SourceError } from '../../src/clarity/sources';
import { cutExcerpts, excerptMatchesSource, newDistillation, runDistillation } from '../../src/clarity/distil';
import { emptyClarityProject, excerptRef } from '../../src/clarity/model';
import { loadClarityProject, saveClarityProject } from '../../src/clarity/projectFile';
import { buildClarityBrief } from '../../src/clarity/brief';
import { bytesToBlob } from '../../src/shared/util';

const dir = join(import.meta.dirname, '..', 'fixtures', 'docs');
const read = (f: string) => new Uint8Array(readFileSync(join(dir, f)));

describe('PDF', () => {
  it('extracts text per page with paragraph breaks and page start lines', async () => {
    const r = await extractDocument('pdf', read('synthetic-report.pdf'), 'synthetic-report.pdf');
    expect(r.method).toMatch(/^pdf\.js \d/);
    expect(r.pageStartLines).toEqual([1, 8]);
    const lines = r.text.split('\n');
    expect(lines[7]).toBe('Error codes');
    expect(r.text).toContain('The upload API allows 10 requests per second per client.\n\nError codes');
    expect(r.text).toContain('Never retry 400 or 413: the request itself is wrong.');
  });

  it('becomes a source that stores the original and cites pages', async () => {
    const bytes = read('synthetic-report.pdf');
    const s = await documentSourceFromBytes('synthetic-report.pdf', bytes, 'pdf');
    expect(s).toMatchObject({ kind: 'text', mime: 'application/pdf', bytes: bytes.byteLength, extraction: { from: 'pdf', pageStartLines: [1, 8] } });
    expect(s.sha256).toBe(await sha256Hex(bytes));
    const excerpts = cutExcerpts([s], 'split');
    expect(excerpts.length).toBeGreaterThan(2);
    for (const e of excerpts) expect(excerptMatchesSource(e, s)).toBe(true);
    const errors = excerpts.find((e) => e.text.startsWith('Error codes'))!;
    expect(errors.pages).toBe('p. 2');
    expect(excerptRef(errors)).toMatch(/^synthetic-report\.pdf · p\. 2 · lines? 8/);
    expect(cutExcerpts([s], 'whole')[0].pages).toBe('pp. 1–2');
  });

  it('refuses a PDF without a text layer, a fake PDF and a damaged PDF with clear messages', async () => {
    await expect(extractDocument('pdf', read('image-only.pdf'), 'scan.pdf')).rejects.toThrow(/no extractable text.*OCR/);
    expect(() => documentKind('fake.pdf', new TextEncoder().encode('hello'))).toThrow(/not a valid PDF/);
    const damaged = read('synthetic-report.pdf').slice(0, 400);
    await expect(extractDocument('pdf', damaged, 'damaged.pdf')).rejects.toThrow(SourceError);
  });
});

describe('Word (.docx)', () => {
  it('extracts paragraphs as plain text without pages', async () => {
    const s = await documentSourceFromBytes('synthetic-report.docx', read('synthetic-report.docx'), 'docx');
    expect(s.mime).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(s.extraction).toMatchObject({ from: 'docx', method: 'mammoth (raw text)', pageStartLines: [] });
    expect(s.text.split('\n\n')).toContain('Never retry 400 or 413: the request itself is wrong.');
    const excerpts = cutExcerpts([s], 'split');
    expect(excerpts.every((e) => e.pages === '' && excerptMatchesSource(e, s))).toBe(true);
  });

  it('refuses a ZIP that is not a Word document', async () => {
    const zip = new JSZip();
    zip.file('hello.txt', 'not a document');
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    expect(documentKind('x.docx', bytes)).toBe('docx');
    await expect(extractDocument('docx', bytes, 'x.docx')).rejects.toThrow(/could not be read as a Word document/);
    expect(() => documentKind('x.docx', new TextEncoder().encode('plain'))).toThrow(/not a valid Word/);
  });
});

describe('helpers', () => {
  it('detects paragraph breaks from vertical gaps without changing text', () => {
    const item = (str: string, y: number, hasEOL = true, height = 10) => ({ str, hasEOL, transform: [1, 0, 0, 1, 0, y], height });
    const text = pageText([item('Title', 700), item('line one', 670), item('line two', 658), item('next para', 620), { type: 'marked' }]);
    expect(text).toBe('Title\n\nline one\nline two\n\nnext para');
  });
  it('maps line ranges to pages', () => {
    expect(pagesForLines([1, 8, 20], 3, 5)).toBe('p. 1');
    expect(pagesForLines([1, 8, 20], 7, 9)).toBe('pp. 1–2');
    expect(pagesForLines([1, 8, 20], 25, 25)).toBe('p. 3');
    expect(pagesForLines([], 1, 2)).toBe('');
  });
  it('removes control characters and trailing spaces only', () => {
    expect(cleanExtractedText('a\u0000b  \r\nc\u0007\n\n\n\nd')).toBe('ab\nc\n\nd');
  });
});

describe('projects with document sources', () => {
  it('save and reopen keeps the original PDF bytes and the extraction record; the brief cites pages', async () => {
    const bytes = read('synthetic-report.pdf');
    const p = emptyClarityProject();
    const s = await documentSourceFromBytes('synthetic-report.pdf', bytes, 'pdf');
    p.sources.push(s);
    const d = newDistillation(p, [s.id]);
    d.task = 'Write retry guidance';
    d.strategy = 'full';
    p.distillations.push(d);
    const store = new Map([[s.id, bytesToBlob(bytes, s.mime)]]);
    const loaded = await loadClarityProject(await saveClarityProject(p, store));
    expect(loaded.warnings).toEqual([]);
    expect(loaded.project.sources[0]).toEqual(s);
    expect(new Uint8Array(await loaded.store.get(s.id)!.arrayBuffer())).toEqual(bytes);
    const md = buildClarityBrief({ project: loaded.project, prompt: null, revision: null, distillation: d, report: runDistillation(d), generatedAt: new Date('2026-11-14T00:00:00Z') });
    expect(md).toMatch(/Source: \*\*synthetic-report\.pdf · p\. 2 · lines? \d/);
    expect(md).toContain('text extracted with pdf.js');
    expect(md).toContain('page numbers refer to the PDF');
  });
});
