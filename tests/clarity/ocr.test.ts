/** OCR for scanned PDFs: the user decides, text is recognised on-device and marked as OCR. */
import { beforeAll, describe, expect, it } from 'vitest';
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractDocument, NeedsOcrError } from '../../src/clarity/extract';
import { configureOcr, OcrCancelled } from '../../src/clarity/ocr';
import { documentSourceFromBytes } from '../../src/clarity/sources';
import { cutExcerpts, excerptMatchesSource } from '../../src/clarity/distil';
import { excerptRef } from '../../src/clarity/model';

const docs = join(import.meta.dirname, '..', 'fixtures', 'docs');
const read = (f: string) => new Uint8Array(readFileSync(join(docs, f)));
const words = (s: string) => s.replace(/\s+/g, ' ');

beforeAll(() => {
  // The same language files the app serves under /ocr/ (see vite.config.ts), in a local folder.
  const dir = mkdtempSync(join(tmpdir(), 'hcg-ocr-'));
  for (const l of ['eng', 'nor']) copyFileSync(join('node_modules', '@tesseract.js-data', l, '4.0.0_best_int', `${l}.traineddata.gz`), join(dir, `${l}.traineddata.gz`));
  configureOcr({ langPath: dir });
});

describe('deciding about OCR', () => {
  it('stops with NeedsOcrError listing the pages without text', async () => {
    const scan = await extractDocument('pdf', read('scanned-report.pdf'), 'scan.pdf').catch((e) => e);
    expect(scan).toBeInstanceOf(NeedsOcrError);
    expect(scan).toMatchObject({ emptyPages: [1, 2], totalPages: 2, hasText: false });
    expect(scan.message).toMatch(/no text layer/);
    const mixed = await extractDocument('pdf', read('mixed-report.pdf'), 'mixed.pdf').catch((e) => e);
    expect(mixed).toMatchObject({ emptyPages: [2], totalPages: 2, hasText: true });
  });

  it('imports a mixed PDF without the scanned pages when asked to', async () => {
    const r = await extractDocument('pdf', read('mixed-report.pdf'), 'mixed.pdf', { ocr: false });
    expect(r.ocrPages).toEqual([]);
    expect(r.text).toContain('The upload API allows 10 requests per second per client.');
    expect(r.text).not.toContain('Never retry');
    expect(r.warnings.join(' ')).toMatch(/No text on page 2 .*imported without OCR/);
  });
});

describe('recognising text', () => {
  it('reads a fully scanned PDF and marks every page as OCR', async () => {
    const s = await documentSourceFromBytes('scanned-report.pdf', read('scanned-report.pdf'), 'pdf', 'file', { ocr: { languages: ['eng'] } });
    expect(s.extraction).toMatchObject({ from: 'pdf', ocrPages: [1, 2] });
    expect(s.extraction!.method).toMatch(/^pdf\.js .* \+ Tesseract OCR \(English\)$/);
    const text = words(s.text);
    expect(text).toContain('The upload API allows 10 requests per second per client.');
    expect(text).toContain('Never retry 400 or 413: the request itself is wrong.');
    expect(s.extraction!.warnings.join(' ')).toMatch(/Pages 1–2 were read with OCR \(English\); average confidence \d+%/);
    const excerpts = cutExcerpts([s], 'split');
    expect(excerpts.length).toBeGreaterThan(2);
    for (const e of excerpts) {
      expect(excerptMatchesSource(e, s)).toBe(true);
      expect(e.pages).toMatch(/\(OCR\)$/);
    }
    expect(excerptRef(excerpts.find((e) => e.text.includes('Never retry'))!)).toMatch(/^scanned-report\.pdf · p\. 2 \(OCR\) · lines? \d/);
  }, 120_000);

  it('reads only the pages without text in a mixed PDF, with progress', async () => {
    const progress: string[] = [];
    const s = await documentSourceFromBytes('mixed-report.pdf', read('mixed-report.pdf'), 'pdf', 'file', {
      ocr: { languages: ['eng', 'nor'], onProgress: (d, t) => progress.push(`${d}/${t}`) },
    });
    expect(progress).toEqual(['0/1', '1/1']);
    expect(s.extraction).toMatchObject({ ocrPages: [2], pageStartLines: [1, expect.any(Number)] });
    expect(s.extraction!.method).toContain('English + Norwegian');
    const excerpts = cutExcerpts([s], 'split');
    expect(excerpts.find((e) => e.text.includes('requests per second'))!.pages).toBe('p. 1');
    expect(excerpts.find((e) => e.text.includes('Never retry'))!.pages).toBe('p. 2 (OCR)');
  }, 120_000);

  it('stops when cancelled and adds nothing', async () => {
    const ac = new AbortController();
    const run = extractDocument('pdf', read('scanned-report.pdf'), 'scan.pdf', {
      ocr: { languages: ['eng'], signal: ac.signal, onProgress: (done) => done === 1 && ac.abort() },
    });
    await expect(run).rejects.toBeInstanceOf(OcrCancelled);
  }, 120_000);

  it('needs at least one language', async () => {
    await expect(extractDocument('pdf', read('scanned-report.pdf'), 'scan.pdf', { ocr: { languages: [] } })).rejects.toThrow(/at least one OCR language/);
  });
});
