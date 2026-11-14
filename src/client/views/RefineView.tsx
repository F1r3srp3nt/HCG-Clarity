/**
 * Refine: shape instructions with HCG RePrompter's local analysis, local formatter and AI
 * enhancement contract. Every change adds a revision; earlier revisions are kept and can be
 * compared or made current again.
 */
import { useMemo, useRef, useState } from 'react';
import type { ProviderStatus } from '../../shared/apiTypes';
import { slugify } from '../../shared/util';
import {
  BuiltInTemplates,
  buildEnhancementRequest,
  describeEnhancementError,
  ENHANCEMENT_MODES,
  EnhancementError,
  MODE_DETAILS,
  parseEnhancementResponse,
  PromptAnalyzer,
  TextDiff,
  type EnhancementMode,
  type ExportFormat,
} from '../../refine';
import { currentRevision, type PromptDoc, type Revision } from '../../clarity/model';
import { addRevision, exportPrompt, formatLocally, newPromptDoc, revisionFieldsFromResult } from '../../clarity/refine';
import { api, describeError } from '../api';
import { useOutputs } from '../files';
import { useClarity } from '../state';

const KIND_LABEL: Record<Revision['kind'], string> = {
  original: 'Original',
  manual: 'Manual edit',
  'local-format': 'Local format (no AI)',
  ai: 'AI enhancement',
  template: 'From template',
  restored: 'Restored',
};

export function RefineView({ status, onOpenSetup, onNext }: { status: ProviderStatus | null; onOpenSetup: () => void; onNext: () => void }) {
  const { clarity, updateClarity, toast } = useClarity();
  const [activeId, setActiveId] = useState<string | null>(clarity.prompts[clarity.prompts.length - 1]?.id ?? null);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const active = clarity.prompts.find((p) => p.id === activeId) ?? null;

  function add(doc: PromptDoc) {
    updateClarity((p) => void p.prompts.push(doc));
    setActiveId(doc.id);
  }

  return (
    <section className="view" aria-labelledby="refine-h">
      <header className="view-head">
        <div>
          <p className="eyebrow">Step 3</p>
          <h1 id="refine-h">Refine</h1>
          <p className="muted">Make instructions clearer without changing what they ask for. Every change becomes a new revision; nothing is overwritten. The analysis is local and heuristic (English-centred).</p>
        </div>
        <button className="btn primary" onClick={onNext} disabled={!clarity.prompts.length}>
          Continue to Create →
        </button>
      </header>
      <div className="split">
        <div className="list-pane">
          <div className="row gap-s">
            <button className="btn primary grow" onClick={() => add(newPromptDoc('Untitled prompt', ''))} data-testid="prompt-new">
              + New prompt
            </button>
            <button className="btn" onClick={() => setTemplatesOpen((o) => !o)} aria-expanded={templatesOpen}>
              Templates
            </button>
          </div>
          {templatesOpen && (
            <ul className="item-list compact" aria-label="Templates">
              {BuiltInTemplates.all.map((t) => (
                <li key={t.id}>
                  <button
                    className="item"
                    onClick={() => {
                      const doc = newPromptDoc(t.name, t.body, 'template', `Started from the template "${t.name}". Replace the {{placeholders}}.`);
                      add(doc);
                      setTemplatesOpen(false);
                      toast('info', `Prompt created from "${t.name}".`);
                    }}
                  >
                    <span className="grow">
                      <span className="item-title">{t.name}</span>
                      <span className="muted small">{t.summary}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <ul className="item-list" aria-label="Prompts">
            {clarity.prompts.map((p) => (
              <li key={p.id}>
                <button className={`item ${p.id === activeId ? 'selected' : ''}`} onClick={() => setActiveId(p.id)} aria-current={p.id === activeId ? 'true' : undefined} data-testid="prompt-item">
                  <span className="grow">
                    <span className="item-title">{p.title}</span>
                    <span className="muted small">
                      {p.revisions.length} revision{p.revisions.length === 1 ? '' : 's'}
                      {p.distillationId ? ' · from Distil' : ''}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {!clarity.prompts.length && <p className="muted small">No prompts yet. Start one here, from a template, or from a distillation.</p>}
        </div>
        <div className="detail-pane">{active ? <PromptEditor key={active.id} doc={active} status={status} onOpenSetup={onOpenSetup} /> : <p className="muted">Select or create a prompt.</p>}</div>
      </div>
    </section>
  );
}

function PromptEditor({ doc, status, onOpenSetup }: { doc: PromptDoc; status: ProviderStatus | null; onOpenSetup: () => void }) {
  const { clarity, updateClarity, toast } = useClarity();
  const { produce } = useOutputs();
  const current = currentRevision(doc);
  const [draft, setDraft] = useState(current.text);
  const [syncedRev, setSyncedRev] = useState(current.id);
  if (syncedRev !== current.id) {
    setSyncedRev(current.id);
    setDraft(current.text);
  }
  const [viewId, setViewId] = useState<string | null>(null);
  const [mode, setMode] = useState<EnhancementMode>('structured');
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ReturnType<typeof describeError> | null>(null);
  const abort = useRef<AbortController | null>(null);
  const edited = draft !== current.text;
  const analysis = useMemo(() => (draft.trim() ? PromptAnalyzer.analyze(draft, mode) : null), [draft, mode]);
  const viewing = doc.revisions.find((r) => r.id === viewId) ?? null;
  const distillation = clarity.distillations.find((d) => d.id === doc.distillationId);

  const set = (fn: (d: PromptDoc) => void) =>
    updateClarity((p) => {
      const d = p.prompts.find((x) => x.id === doc.id);
      if (d) fn(d);
    });

  function saveEdit(): boolean {
    if (!edited) return true;
    if (!draft.trim()) {
      toast('error', 'The prompt is empty.');
      return false;
    }
    set((d) => void addRevision(d, { kind: 'manual', text: draft, summary: 'Edited by hand.', changes: [], warnings: [], mode: null, model: null }));
    return true;
  }

  function localFormat() {
    if (!saveEdit()) return;
    try {
      // Format the text the user sees (which saveEdit just stored as the current revision).
      const fields = formatLocally({ ...doc, revisions: [...doc.revisions, { ...current, id: 'tmp', text: draft }], currentRevisionId: 'tmp' }, mode);
      set((d) => void addRevision(d, fields));
      toast('success', 'Formatted locally (no AI). A new revision was added.');
    } catch (e) {
      toast('error', e instanceof EnhancementError ? describeEnhancementError(e.reason) : (e as Error).message);
    }
  }

  async function enhanceAi() {
    if (!saveEdit()) return;
    setErr(null);
    let built;
    try {
      built = buildEnhancementRequest({ originalPrompt: draft, mode, customInstructions: mode === 'custom' ? custom : undefined });
    } catch (e) {
      toast('error', e instanceof EnhancementError ? describeEnhancementError(e.reason) : (e as Error).message);
      return;
    }
    if (!confirm(`Send this prompt (${draft.length} characters) to ${status?.generation.model ?? 'the AI provider'} (Anthropic) for ${MODE_DETAILS[mode].displayName} enhancement? The prompt is sent as data to rewrite, not as instructions.`)) return;
    setBusy(true);
    const ac = new AbortController();
    abort.current = ac;
    try {
      const res = await api.refineEnhance({ prompt: draft, mode, customInstructions: mode === 'custom' ? custom : undefined }, ac.signal);
      // Validate in the browser with the RePrompter contract before anything is stored.
      const result = parseEnhancementResponse(JSON.stringify(res.raw), built.request, { model: res.model });
      const fields = revisionFieldsFromResult(result, 'ai');
      set((d) => void addRevision(d, fields));
      toast('success', `Enhanced with ${MODE_DETAILS[mode].displayName}. Review the changes and warnings.`);
    } catch (e) {
      if (e instanceof EnhancementError) setErr({ message: describeEnhancementError(e.reason), retryable: e.canRetry });
      else {
        const info = describeError(e);
        if (info.code === 'cancelled') toast('info', 'Enhancement cancelled. Nothing was changed.');
        else setErr(info);
      }
    } finally {
      setBusy(false);
      abort.current = null;
    }
  }

  async function doExport(format: ExportFormat) {
    if (!saveEdit()) return;
    // Read the latest stored state after a possible save.
    const fresh = { ...doc, revisions: edited ? [...doc.revisions, { ...current, id: 'tmp', text: draft }] : doc.revisions, currentRevisionId: edited ? 'tmp' : doc.currentRevisionId };
    const text = exportPrompt(fresh, format);
    const ext = format === 'plainText' ? 'txt' : format === 'markdown' ? 'md' : 'json';
    const kind = format === 'plainText' ? 'prompt-txt' : format === 'markdown' ? 'prompt-md' : 'prompt-json';
    const mime = format === 'plainText' ? 'text/plain;charset=utf-8' : format === 'markdown' ? 'text/markdown;charset=utf-8' : 'application/json';
    await produce(kind, `${slugify(doc.title, 'prompt')}.${ext}`, mime, new TextEncoder().encode(text), {
      promptId: doc.id,
      revisionId: edited ? null : current.id,
      distillationId: doc.distillationId,
      sourceIds: distillation ? distillation.sourceIds : [],
    });
  }

  const aiReady = Boolean(status?.generation.configured);
  const parent = viewing?.parentId ? doc.revisions.find((r) => r.id === viewing.parentId) : null;
  const diff = useMemo(() => (viewing && parent ? TextDiff.diff(parent.text, viewing.text) : null), [viewing, parent]);

  return (
    <article data-testid="prompt-editor">
      <div className="row between gap-s wrap">
        <input className="title-input big" value={doc.title} onChange={(e) => set((d) => void (d.title = e.target.value))} aria-label="Prompt title" />
        <button
          className="btn ghost danger small"
          onClick={() => {
            if (!confirm(`Delete "${doc.title}" and all ${doc.revisions.length} revisions?`)) return;
            updateClarity((p) => void (p.prompts = p.prompts.filter((x) => x.id !== doc.id)));
          }}
        >
          Delete
        </button>
      </div>
      {distillation && <p className="muted small">Started from the distillation “{distillation.title}”.</p>}

      <div className="grid-main-side">
        <div>
          <label className="field">
            <span>
              Current revision · {KIND_LABEL[current.kind]} · {new Date(current.createdAt).toLocaleString()}
              {edited && <b className="warn-text"> · unsaved edits</b>}
            </span>
            <textarea className="prompt-text" rows={16} value={draft} onChange={(e) => setDraft(e.target.value)} data-testid="prompt-text" />
          </label>
          <div className="row gap-s wrap">
            <button className="btn" onClick={saveEdit} disabled={!edited} data-testid="prompt-save-revision">
              Save as revision
            </button>
            {edited && (
              <button className="btn ghost" onClick={() => setDraft(current.text)}>
                Discard edits
              </button>
            )}
            <span className="muted small">
              {draft.trim() ? draft.trim().split(/\s+/).length : 0} words · {draft.length} characters
            </span>
          </div>

          <div className="card">
            <h3 className="section-title">Improve</h3>
            <div className="row gap-s wrap">
              <label className="field compact inline">
                <span>Mode</span>
                <select value={mode} onChange={(e) => setMode(e.target.value as EnhancementMode)} data-testid="refine-mode">
                  {ENHANCEMENT_MODES.map((m) => (
                    <option key={m} value={m}>
                      {MODE_DETAILS[m].displayName}
                    </option>
                  ))}
                </select>
              </label>
              <span className="muted small grow">{MODE_DETAILS[mode].summary}</span>
            </div>
            {mode === 'custom' && (
              <label className="field">
                <span>Your style preferences (custom mode)</span>
                <textarea rows={2} value={custom} onChange={(e) => setCustom(e.target.value)} />
              </label>
            )}
            <div className="row gap-s wrap">
              <button className="btn" onClick={localFormat} disabled={!draft.trim() || busy} data-testid="refine-local">
                Format locally (no AI)
              </button>
              {busy ? (
                <button className="btn" onClick={() => abort.current?.abort()} data-testid="refine-cancel">
                  Stop
                </button>
              ) : aiReady ? (
                <button className="btn primary" onClick={() => void enhanceAi()} disabled={!draft.trim()} data-testid="refine-ai">
                  Enhance with AI
                </button>
              ) : (
                <button className="btn" onClick={onOpenSetup} data-testid="refine-setup">
                  Set up AI to enhance
                </button>
              )}
            </div>
            {busy && <p className="small" aria-live="polite">Enhancing…</p>}
            {err && (
              <div className="alert error" role="alert" data-testid="refine-error">
                <b>{err.message}</b> {err.hint}
                {err.retryable && (
                  <button className="btn small" onClick={() => void enhanceAi()}>
                    Retry
                  </button>
                )}
              </div>
            )}
            {(current.changes.length > 0 || current.warnings.length > 0 || current.summary) && (
              <div className="revision-notes" data-testid="revision-notes">
                {current.summary && <p className="small">{current.summary}</p>}
                {current.warnings.length > 0 && (
                  <div className="alert warn">
                    <ul>
                      {current.warnings.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {current.changes.length > 0 && (
                  <ul className="small">
                    {current.changes.map((c, i) => (
                      <li key={i}>{c}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          <div className="card">
            <h3 className="section-title">Export this prompt</h3>
            <div className="row gap-s wrap">
              <button className="btn" onClick={() => void doExport('plainText')} disabled={!draft.trim()} data-testid="prompt-export-txt">
                Text (.txt)
              </button>
              <button className="btn" onClick={() => void doExport('markdown')} disabled={!draft.trim()} data-testid="prompt-export-md">
                Markdown (.md)
              </button>
              <button className="btn" onClick={() => void doExport('json')} disabled={!draft.trim()} data-testid="prompt-export-json">
                JSON
              </button>
            </div>
          </div>
        </div>

        <aside aria-label="Analysis and revisions">
          <div className="card">
            <h3 className="section-title">Local analysis</h3>
            {analysis ? (
              <dl className="analysis" data-testid="analysis">
                <dt>Objective</dt>
                <dd>{analysis.objective ?? <span className="muted">Not found</span>}</dd>
                <dt>Requirements ({analysis.requirements.length})</dt>
                <dd>{analysis.requirements.length ? <ul>{analysis.requirements.map((r, i) => <li key={i}>{r}</li>)}</ul> : <span className="muted">None found</span>}</dd>
                <dt>Constraints ({analysis.constraints.length})</dt>
                <dd>{analysis.constraints.length ? <ul>{analysis.constraints.map((r, i) => <li key={i}>{r}</li>)}</ul> : <span className="muted">None found</span>}</dd>
                <dt>Missing information</dt>
                <dd>{analysis.missingInformation.length ? <ul>{analysis.missingInformation.map((r, i) => <li key={i}>{r}</li>)}</ul> : <span className="muted">Nothing obvious</span>}</dd>
                <dt>Vague wording</dt>
                <dd>{analysis.ambiguities.length ? <ul>{analysis.ambiguities.map((a, i) => <li key={i}><b>{a.term}</b>: {a.note}</li>)}</ul> : <span className="muted">None found</span>}</dd>
              </dl>
            ) : (
              <p className="muted small">Write a prompt to see its analysis.</p>
            )}
          </div>
          <div className="card">
            <h3 className="section-title">Revisions ({doc.revisions.length})</h3>
            <ol className="revisions" data-testid="revisions" reversed>
              {[...doc.revisions].reverse().map((r) => (
                <li key={r.id} className={r.id === current.id ? 'current' : ''}>
                  <button className="link" onClick={() => setViewId(viewId === r.id ? null : r.id)} aria-expanded={viewId === r.id}>
                    {KIND_LABEL[r.kind]}
                    {r.mode ? ` · ${MODE_DETAILS[r.mode as EnhancementMode]?.displayName ?? r.mode}` : ''}
                  </button>
                  <span className="muted small"> {new Date(r.createdAt).toLocaleString()}</span>
                  {r.id === current.id && <span className="pill small">current</span>}
                </li>
              ))}
            </ol>
            {viewing && (
              <div className="revision-view" data-testid="revision-view">
                {diff ? (
                  <>
                    <p className="muted small">
                      Changes from the previous revision: +{diff.summary.insertedWords} / −{diff.summary.removedWords} words{diff.summary.isApproximate ? ' (line-level comparison)' : ''}
                    </p>
                    <pre className="diff">
                      {diff.segments.map((s, i) => (
                        <span key={i} className={s.kind}>
                          {s.text}
                        </span>
                      ))}
                    </pre>
                  </>
                ) : (
                  <pre className="verbatim">{viewing.text}</pre>
                )}
                {viewing.id !== current.id && (
                  <button
                    className="btn small"
                    onClick={() => {
                      if (edited && !confirm('Discard your unsaved edits?')) return;
                      set((d) => void addRevision(d, { kind: 'restored', text: viewing.text, summary: `Restored from the ${KIND_LABEL[viewing.kind].toLowerCase()} revision of ${new Date(viewing.createdAt).toLocaleString()}.`, changes: [], warnings: [], mode: viewing.mode, model: viewing.model, parentId: viewing.id }));
                      setViewId(null);
                    }}
                    data-testid="revision-restore"
                  >
                    Restore as new revision
                  </button>
                )}
              </div>
            )}
          </div>
        </aside>
      </div>
    </article>
  );
}
