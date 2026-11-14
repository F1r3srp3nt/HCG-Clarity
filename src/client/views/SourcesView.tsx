/** Sources: import and organise the material a project works from. Originals are never edited. */
import { useMemo, useRef, useState, type DragEvent } from 'react';
import { hasText, nowIso, type Source } from '../../clarity/model';
import { documentKind, MAX_DOCUMENT_BYTES, NeedsOcrError, type ExtractOptions } from '../../clarity/extract';
import { OCR_LANGUAGES, OcrCancelled, ocrAvailable, type OcrLanguage } from '../../clarity/ocr';
import { ocrImageSource } from '../../clarity/sources';
import { documentSourceFromBytes, formatBytes, IMAGE_MIMES, isTextFileName, MAX_TEXT_SOURCE_BYTES, sha256Hex, sourceLines, textSourceFromBytes, textSourceFromPaste } from '../../clarity/sources';
import { bytesToBlob } from '../../shared/util';
import { blobUrl, readImageFile } from '../images';
import { useClarity } from '../state';

const ACCEPT = ['.pdf', '.docx', '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.log', '.html', '.htm', '.xml', '.yaml', '.yml', ...IMAGE_MIMES].join(',');

export async function sourceFromFile(file: File, options: ExtractOptions = {}): Promise<{ source: Source; blob: Blob }> {
  const lower = file.name.toLowerCase();
  if ((IMAGE_MIMES as readonly string[]).includes(file.type === 'image/jpg' ? 'image/jpeg' : file.type)) {
    const { asset, blob } = await readImageFile(file);
    const source: Source = {
      id: asset.id,
      name: file.name,
      kind: 'image',
      mime: asset.mime,
      bytes: file.size,
      sha256: await sha256Hex(new Uint8Array(await blob.arrayBuffer())),
      origin: 'file',
      addedAt: nowIso(),
      text: '',
      width: asset.width,
      height: asset.height,
      note: '',
      extraction: null,
    };
    return { source, blob };
  }
  if (lower.endsWith('.pdf') || lower.endsWith('.docx')) {
    if (file.size > MAX_DOCUMENT_BYTES) throw new Error(`"${file.name}" is larger than 50 MB.`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const kind = documentKind(file.name, bytes)!;
    const source = await documentSourceFromBytes(file.name, bytes, kind, 'file', options);
    return { source, blob: bytesToBlob(bytes, source.mime) };
  }
  if (lower.endsWith('.doc')) {
    throw new Error(`"${file.name}" is an old Word format (.doc). Save it as .docx (or PDF) and add it again.`);
  }
  if (lower.endsWith('.pptx') || lower.endsWith('.ppt') || lower.endsWith('.rtf') || lower.endsWith('.odt') || lower.endsWith('.pages')) {
    throw new Error(`"${file.name}": this format is not supported. Supported documents: PDF and Word (.docx), plus text and images.`);
  }
  if (!isTextFileName(file.name) && !file.type.startsWith('text/')) {
    throw new Error(`"${file.name}" is not a supported type. Supported: PDF, Word (.docx), plain text, Markdown, CSV, JSON, HTML/XML (as text) and PNG, JPEG or WebP images.`);
  }
  if (file.size > MAX_TEXT_SOURCE_BYTES) throw new Error(`"${file.name}" is larger than 5 MB.`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const source = await textSourceFromBytes(file.name, bytes, 'file');
  return { source, blob: bytesToBlob(bytes, source.mime) };
}

export function SourcesView({ onNext }: { onNext: () => void }) {
  const { clarity, store, storeVersion, updateClarity, putBinary, dropBinary, toast } = useClarity();
  const [over, setOver] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(clarity.sources[0]?.id ?? null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteTitle, setPasteTitle] = useState('');
  const [pasteText, setPasteText] = useState('');
  const [filter, setFilter] = useState('');
  const [reading, setReading] = useState<string | null>(null);
  /** Scanned PDFs waiting for the user's OCR decision, first one shown. */
  const [ocrQueue, setOcrQueue] = useState<{ file: File; need: NeedsOcrError }[]>([]);
  const [ocrLangs, setOcrLangs] = useState<OcrLanguage[]>(['eng']);
  const [ocrProgress, setOcrProgress] = useState<{ done: number; total: number } | null>(null);
  const ocrAbort = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const selected = clarity.sources.find((s) => s.id === selectedId) ?? null;

  const usage = useMemo(() => {
    const m = new Map<string, string[]>();
    const add = (id: string, what: string) => m.set(id, [...(m.get(id) ?? []), what]);
    for (const d of clarity.distillations) for (const id of d.sourceIds) add(id, `Distil: ${d.title}`);
    for (const a of clarity.deck.assets) add(a.id, 'Presentation');
    for (const o of clarity.outputs) for (const id of o.sourceIds) add(id, `Output: ${o.fileName}`);
    return m;
  }, [clarity]);

  // Checksums of sources added in this session, so a burst of files is de-duplicated before state updates land.
  const known = useRef(new Set<string>());

  function addSource(source: Source, blob: Blob, fileName: string): boolean {
    const have = new Set([...clarity.sources.map((s) => s.sha256), ...known.current]);
    if (have.has(source.sha256)) {
      toast('info', `"${fileName}" is already in Sources (identical content), so it was not added again.`);
      return false;
    }
    known.current.add(source.sha256);
    putBinary(source.id, blob);
    updateClarity((d) => void d.sources.push(source));
    setSelectedId(source.id);
    return true;
  }

  async function addFiles(files: FileList | File[]) {
    let added = 0;
    const waiting: { file: File; need: NeedsOcrError }[] = [];
    for (const f of Array.from(files)) {
      try {
        setReading(f.name);
        const { source, blob } = await sourceFromFile(f);
        if (addSource(source, blob, f.name)) added++;
      } catch (e) {
        if (e instanceof NeedsOcrError) waiting.push({ file: f, need: e });
        else toast('error', (e as Error).message);
      }
    }
    setReading(null);
    if (waiting.length) setOcrQueue((q) => [...q, ...waiting]);
    if (added) toast('success', `Added ${added} source${added === 1 ? '' : 's'}. Originals are kept exactly as imported.`);
  }

  /** Imports the first queued scanned PDF, with OCR or (when it has some text) without. */
  async function resolveOcr(useOcr: boolean) {
    const item = ocrQueue[0];
    if (!item) return;
    const ac = new AbortController();
    ocrAbort.current = ac;
    try {
      setReading(item.file.name);
      if (useOcr) setOcrProgress({ done: 0, total: item.need.emptyPages.length });
      const { source, blob } = await sourceFromFile(
        item.file,
        useOcr ? { ocr: { languages: ocrLangs, signal: ac.signal, onProgress: (done, total) => setOcrProgress({ done, total }) } } : { ocr: false },
      );
      if (addSource(source, blob, item.file.name)) {
        toast('success', useOcr ? `Added "${item.file.name}" with OCR text. Check it against the original: recognition errors are possible.` : `Added "${item.file.name}" without the pages that have no text.`);
      }
      setOcrQueue((q) => q.slice(1));
    } catch (e) {
      if (e instanceof OcrCancelled) toast('info', e.message);
      else {
        toast('error', (e as Error).message);
        setOcrQueue((q) => q.slice(1));
      }
    } finally {
      setReading(null);
      setOcrProgress(null);
      ocrAbort.current = null;
    }
  }

  async function addPaste() {
    try {
      const { source, bytes } = await textSourceFromPaste(pasteTitle, pasteText);
      putBinary(source.id, bytesToBlob(bytes, source.mime));
      updateClarity((d) => void d.sources.push(source));
      setSelectedId(source.id);
      setPasteOpen(false);
      setPasteText('');
      setPasteTitle('');
      toast('success', `Added "${source.name}".`);
    } catch (e) {
      toast('error', (e as Error).message);
    }
  }

  function remove(s: Source) {
    const uses = usage.get(s.id) ?? [];
    const msg = uses.length
      ? `"${s.name}" is used by: ${[...new Set(uses)].join(', ')}.\n\nRemove it? Excerpts already cut from it keep their text and reference, marked "source removed". ${s.kind === 'image' ? 'It is also removed from the presentation.' : ''}`
      : `Remove "${s.name}" from the project?`;
    if (!confirm(msg)) return;
    updateClarity((d) => {
      d.sources = d.sources.filter((x) => x.id !== s.id);
      d.deck.assets = d.deck.assets.filter((a) => a.id !== s.id);
      for (const sl of d.deck.slides) if (sl.image?.assetId === s.id) sl.image = null;
    });
    if (!clarity.outputs.some((o) => o.id === s.id)) dropBinary(s.id);
    if (selectedId === s.id) setSelectedId(null);
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setOver(false);
    if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files);
  }

  const shown = clarity.sources.filter((s) => !filter.trim() || s.name.toLowerCase().includes(filter.trim().toLowerCase()) || s.text.toLowerCase().includes(filter.trim().toLowerCase()));
  void storeVersion;

  return (
    <section className="view" aria-labelledby="sources-h">
      <header className="view-head">
        <div>
          <p className="eyebrow">Step 1</p>
          <h1 id="sources-h">Sources</h1>
          <p className="muted">Import the material you work from. Originals are stored byte-for-byte with a SHA-256 checksum and are never edited. Imported text is treated as untrusted content: instructions inside it are never followed.</p>
        </div>
        <button className="btn primary" onClick={onNext} disabled={!clarity.sources.some(hasText)} title="Distil works on text sources">
          Continue to Distil →
        </button>
      </header>

      <div className="row gap-s wrap">
        <div
          className={`dropzone compact grow ${over ? 'over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
          onClick={() => input.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
          aria-label="Add source files"
          data-testid="source-drop"
        >
          <strong>Drop files here or click to choose</strong>
          <span className="muted small">PDF (scans via on-device OCR) and Word (.docx) up to 50 MB · text (.txt, .md, .csv, .json, .html…) up to 5 MB · PNG, JPEG, WebP images up to 25 MB</span>
          {reading && (
            <span className="small" role="status" aria-live="polite" data-testid="source-reading">
              Reading “{reading}”…
            </span>
          )}
          <input
            ref={input}
            type="file"
            accept={ACCEPT}
            multiple
            hidden
            data-testid="source-input"
            onChange={(e) => {
              if (e.target.files) void addFiles(e.target.files);
              e.target.value = '';
            }}
          />
        </div>
        <button className="btn" onClick={() => setPasteOpen((o) => !o)} aria-expanded={pasteOpen} data-testid="paste-open">
          Paste text…
        </button>
      </div>

      {ocrQueue[0] && (
        <div className="card ocr-card" role="region" aria-label="Text recognition" data-testid="ocr-prompt">
          <h2 className="section-title">Text recognition (OCR)</h2>
          <p>
            <b>{ocrQueue[0].need.message}</b>
          </p>
          <p className="muted small">
            OCR runs on this device; nothing is uploaded. It takes a few seconds per page ({ocrQueue[0].need.emptyPages.length} page
            {ocrQueue[0].need.emptyPages.length === 1 ? '' : 's'} to read). Recognised text can contain errors, so it is marked “OCR” in references. The original PDF is kept unchanged.
            {ocrQueue.length > 1 && ` ${ocrQueue.length - 1} more file(s) are waiting.`}
          </p>
          <fieldset className="row gap-s wrap" disabled={ocrProgress !== null}>
            <legend className="small">Language of the document</legend>
            {(Object.keys(OCR_LANGUAGES) as OcrLanguage[]).map((l) => (
              <label key={l} className="check">
                <input
                  type="checkbox"
                  checked={ocrLangs.includes(l)}
                  onChange={(e) => setOcrLangs((cur) => (e.target.checked ? [...cur, l] : cur.filter((x) => x !== l)))}
                  data-testid={`ocr-lang-${l}`}
                />
                {OCR_LANGUAGES[l]}
              </label>
            ))}
          </fieldset>
          {ocrProgress ? (
            <div className="row gap-s" aria-live="polite">
              <span className="small" data-testid="ocr-progress">
                Reading page {Math.min(ocrProgress.done + 1, ocrProgress.total)} of {ocrProgress.total}…
              </span>
              <div className="bar grow" aria-hidden>
                <div style={{ width: `${(ocrProgress.done / Math.max(1, ocrProgress.total)) * 100}%` }} />
              </div>
              <button className="btn small" onClick={() => ocrAbort.current?.abort()} data-testid="ocr-stop">
                Stop
              </button>
            </div>
          ) : (
            <div className="row gap-s wrap">
              <button className="btn primary" onClick={() => void resolveOcr(true)} disabled={!ocrLangs.length || !ocrAvailable() || reading !== null} data-testid="ocr-run">
                Recognise text
              </button>
              {ocrQueue[0].need.hasText && (
                <button className="btn" onClick={() => void resolveOcr(false)} disabled={reading !== null} data-testid="ocr-skip-pages">
                  Import without those pages
                </button>
              )}
              <button className="btn ghost" onClick={() => setOcrQueue((q) => q.slice(1))} disabled={reading !== null} data-testid="ocr-cancel">
                Don’t import
              </button>
            </div>
          )}
        </div>
      )}

      {pasteOpen && (
        <div className="card" data-testid="paste-form">
          <label className="field">
            <span>Title</span>
            <input value={pasteTitle} onChange={(e) => setPasteTitle(e.target.value)} placeholder="e.g. Meeting notes, 12 Nov" data-testid="paste-title" />
          </label>
          <label className="field">
            <span>Text (kept exactly as pasted)</span>
            <textarea rows={8} value={pasteText} onChange={(e) => setPasteText(e.target.value)} data-testid="paste-text" />
          </label>
          <div className="row gap-s">
            <button className="btn primary" onClick={() => void addPaste()} disabled={!pasteText.trim()} data-testid="paste-add">
              Add source
            </button>
            <button className="btn ghost" onClick={() => setPasteOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {clarity.sources.length === 0 ? (
        <div className="empty card">
          <h2>No sources yet</h2>
          <p className="muted">Add documents, notes or images. Then Distil selects the parts your task needs and keeps a reference to where each part came from.</p>
        </div>
      ) : (
        <div className="split">
          <div className="list-pane">
            <input className="search" type="search" placeholder="Search sources" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Search sources" />
            <ul className="item-list" aria-label="Sources" data-testid="source-list">
              {shown.map((s) => (
                <li key={s.id}>
                  <button className={`item ${selectedId === s.id ? 'selected' : ''}`} onClick={() => setSelectedId(s.id)} aria-current={selectedId === s.id ? 'true' : undefined} data-testid="source-item">
                    <span className={`kind-tag ${s.kind}`}>{s.kind === 'image' ? 'IMG' : s.extraction ? s.extraction.from.toUpperCase() : 'TXT'}</span>
                    <span className="grow">
                      <span className="item-title">{s.name}</span>
                      <span className="muted small">
                        {formatBytes(s.bytes)}
                        {s.kind === 'text' ? ` · ${sourceLines(s.text).length} lines` : ` · ${s.width}×${s.height}${hasText(s) ? ' · OCR text' : ''}`}
                        {(usage.get(s.id)?.length ?? 0) > 0 && ` · used ${usage.get(s.id)!.length}×`}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
              {shown.length === 0 && <li className="muted small">No source matches “{filter}”.</li>}
            </ul>
          </div>
          <div className="detail-pane">
            {selected ? (
              <SourceDetail source={selected} blob={store.get(selected.id)} uses={usage.get(selected.id) ?? []} onRemove={() => remove(selected)} onNote={(note) => updateClarity((d) => void (d.sources.find((x) => x.id === selected.id)!.note = note))} />
            ) : (
              <p className="muted">Select a source to view it.</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function SourceDetail({ source, blob, uses, onRemove, onNote }: { source: Source; blob: Blob | undefined; uses: string[]; onRemove: () => void; onNote: (note: string) => void }) {
  const lines = hasText(source) ? sourceLines(source.text) : [];
  const ocrPages = new Set(source.extraction?.ocrPages ?? []);
  const pageAt = new Map((source.extraction?.pageStartLines ?? []).map((line, i) => [line, `Page ${i + 1}${ocrPages.has(i + 1) ? ' · OCR' : ''}`]));
  return (
    <article aria-label={`Source ${source.name}`} data-testid="source-detail">
      <div className="row between wrap gap-s">
        <h2 className="break">{source.name}</h2>
        <button className="btn ghost danger small" onClick={onRemove} data-testid="source-remove">
          Remove
        </button>
      </div>
      <dl className="meta-grid">
        <dt>Type</dt>
        <dd>{source.mime}</dd>
        <dt>Size</dt>
        <dd>{formatBytes(source.bytes)}</dd>
        <dt>Added</dt>
        <dd>
          {new Date(source.addedAt).toLocaleString()} ({source.origin === 'paste' ? 'pasted' : source.origin === 'migrated' ? 'converted from an older file' : 'file'})
        </dd>
        <dt>SHA-256</dt>
        <dd className="mono small break" title={source.sha256}>
          {source.sha256}
        </dd>
        <dt>Used by</dt>
        <dd>{uses.length ? [...new Set(uses)].join(' · ') : 'Not used yet'}</dd>
      </dl>
      <label className="field">
        <span>Your note about this source</span>
        <input value={source.note} onChange={(e) => onNote(e.target.value)} placeholder="Optional" />
      </label>
      {source.kind === 'image' && (
        <>
          <h3 className="section-title">Original image</h3>
          <div className="image-preview">{blob ? <img src={blobUrl(blob)} alt={source.note || source.name} /> : <p className="muted">Image data is missing.</p>}</div>
          <ImageOcrPanel source={source} blob={blob} />
        </>
      )}
      {source.extraction && (
        <div className="alert info" data-testid="source-extraction">
          <b>{source.extraction.from === 'image' ? 'Recognised text (OCR).' : 'Extracted text.'}</b>{' '}
          {source.extraction.from === 'image'
            ? 'The image is stored unchanged (the checksum above is of the image). Below is the text recognised in it'
            : `The original ${source.extraction.from === 'pdf' ? 'PDF' : 'Word document'} is stored unchanged (the checksum above is of the original). Below is the text extracted`}{' '}
          with {source.extraction.method}; line numbers and references point into it{source.extraction.from === 'pdf' ? ', and page numbers into the PDF' : ''}.
          {source.extraction.warnings.length > 0 && (
            <ul className="small">
              {source.extraction.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {lines.length > 0 && (
        <>
          <h3 className="section-title">
            {source.extraction ? `${source.extraction.from === 'image' ? 'Recognised' : 'Extracted'} text (read-only, with the line numbers used by references)` : 'Original (read-only, with line numbers used by references)'}
          </h3>
          <ol className="source-text" aria-label="Source text">
            {lines.map((l, i) => (
              <li key={i} id={`L${i + 1}`} className={pageAt.has(i + 1) ? 'page-start' : undefined} data-page={pageAt.get(i + 1)}>
                <span className="ln" aria-hidden>
                  {i + 1}
                </span>
                <span className="lt">{l || '\u00a0'}</span>
              </li>
            ))}
          </ol>
        </>
      )}
    </article>
  );
}

/** OCR for an image source: recognises its text so Distil can use it. The image itself is unchanged. */
function ImageOcrPanel({ source, blob }: { source: Source; blob: Blob | undefined }) {
  const { clarity, updateClarity, toast } = useClarity();
  const [langs, setLangs] = useState<OcrLanguage[]>(['eng']);
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  // Re-reading would change the text that existing excerpts point into, so it is blocked while they exist.
  const usedBy = clarity.distillations.filter((d) => d.excerpts.some((e) => e.sourceId === source.id));
  const has = hasText(source);

  async function run() {
    if (!blob) return;
    const ac = new AbortController();
    abort.current = ac;
    setBusy(true);
    try {
      const fields = await ocrImageSource(source, blob, { languages: langs, signal: ac.signal });
      updateClarity((d) => {
        const s = d.sources.find((x) => x.id === source.id);
        if (s) Object.assign(s, fields);
      });
      toast('success', `Text recognised in "${source.name}". Check it against the image: recognition errors are possible.`);
    } catch (e) {
      toast(e instanceof OcrCancelled ? 'info' : 'error', (e as Error).message);
    } finally {
      setBusy(false);
      abort.current = null;
    }
  }

  return (
    <div className="card ocr-card" data-testid="image-ocr">
      <h3 className="section-title">Text in this image</h3>
      <p className="muted small">
        {has
          ? 'The text below was recognised with OCR. It can be used in Distil; its references are marked “OCR”.'
          : 'Recognise the text in this image (a screenshot, a photo of a whiteboard or a document) to use it in Distil. OCR runs on this device; nothing is uploaded.'}
      </p>
      {usedBy.length > 0 ? (
        <p className="small">Used by {usedBy.map((d) => `“${d.title}”`).join(', ')}. To read it again, remove those excerpts first (cut the excerpts again without this source), so no reference points to text that changed.</p>
      ) : (
        <>
          <fieldset className="row gap-s wrap" disabled={busy}>
            <legend className="small">Language of the text</legend>
            {(Object.keys(OCR_LANGUAGES) as OcrLanguage[]).map((l) => (
              <label key={l} className="check">
                <input type="checkbox" checked={langs.includes(l)} onChange={(e) => setLangs((cur) => (e.target.checked ? [...cur, l] : cur.filter((x) => x !== l)))} data-testid={`image-ocr-lang-${l}`} />
                {OCR_LANGUAGES[l]}
              </label>
            ))}
          </fieldset>
          <div className="row gap-s">
            {busy ? (
              <>
                <span className="small" role="status" aria-live="polite" data-testid="image-ocr-busy">
                  Reading the image…
                </span>
                <button className="btn small" onClick={() => abort.current?.abort()} data-testid="image-ocr-stop">
                  Stop
                </button>
              </>
            ) : (
              <button className="btn primary" onClick={() => void run()} disabled={!blob || !langs.length || !ocrAvailable()} data-testid="image-ocr-run">
                {has ? 'Recognise again' : 'Recognise text'}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

