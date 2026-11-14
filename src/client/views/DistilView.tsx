/**
 * Distil: choose sources, cut them into referenced excerpts, select what the task needs with the
 * ported Distil engine (deterministic, offline), and optionally write AI notes whose citations are
 * checked against the excerpts.
 */
import { useMemo, useRef, useState } from 'react';
import type { ProviderStatus } from '../../shared/apiTypes';
import { slugify } from '../../shared/util';
import { allContextCategories, metricLabel, outcomeExplanation, outcomeTitle, SecretScanner, strategySummary, variantLabel, type SelectionReport } from '../../distil';
import { excerptRef, newIdLocal, nowIso, STRATEGY_IDS, type Distillation, type Excerpt, type PromptDoc, type Source } from '../../clarity/model';
import { compareDistillation, cutExcerpts, excerptMatchesSource, keptExcerpts, newDistillation, runDistillation, STRATEGY_LABEL, STRATEGY_TO_DISTIL } from '../../clarity/distil';
import { validateNotes } from '../../clarity/notes';
import { api, describeError } from '../api';
import { useOutputs } from '../files';
import { useClarity } from '../state';

export function DistilView({ status, onOpenSetup, onNext }: { status: ProviderStatus | null; onOpenSetup: () => void; onNext: () => void }) {
  const { clarity, updateClarity, toast } = useClarity();
  const [activeId, setActiveId] = useState<string | null>(clarity.distillations[clarity.distillations.length - 1]?.id ?? null);
  const active = clarity.distillations.find((d) => d.id === activeId) ?? null;
  const textSources = clarity.sources.filter((s) => s.kind === 'text');

  function create() {
    if (!textSources.length) return;
    const d = newDistillation(clarity, textSources.map((s) => s.id));
    updateClarity((p) => void p.distillations.push(d));
    setActiveId(d.id);
  }

  function remove(d: Distillation) {
    const used = clarity.prompts.filter((p) => p.distillationId === d.id).length;
    if (!confirm(`Delete "${d.title}"?${used ? ` ${used} prompt(s) were started from it; they keep their text but lose the link.` : ''}`)) return;
    updateClarity((p) => {
      p.distillations = p.distillations.filter((x) => x.id !== d.id);
      for (const pr of p.prompts) if (pr.distillationId === d.id) pr.distillationId = null;
    });
    setActiveId(null);
    toast('info', `Deleted "${d.title}".`);
  }

  return (
    <section className="view" aria-labelledby="distil-h">
      <header className="view-head">
        <div>
          <p className="eyebrow">Step 2</p>
          <h1 id="distil-h">Distil</h1>
          <p className="muted">
            Select the parts of your sources a task needs. Excerpts are exact lines of a source and keep a reference to it. Selection is local and deterministic: token counts are estimates, and keyword relevance is not understanding — review what was left out.
          </p>
        </div>
      </header>

      {textSources.length === 0 ? (
        <div className="empty card">
          <h2>No text sources yet</h2>
          <p className="muted">Add text, Markdown or other text files under Sources first.</p>
        </div>
      ) : (
        <div className="split">
          <div className="list-pane">
            <button className="btn primary block" onClick={create} data-testid="distil-new">
              + New distillation
            </button>
            <ul className="item-list" aria-label="Distillations">
              {clarity.distillations.map((d) => (
                <li key={d.id}>
                  <button className={`item ${d.id === activeId ? 'selected' : ''}`} onClick={() => setActiveId(d.id)} aria-current={d.id === activeId ? 'true' : undefined}>
                    <span className="grow">
                      <span className="item-title">{d.title}</span>
                      <span className="muted small">
                        {d.excerpts.length} excerpts · {STRATEGY_LABEL[d.strategy]}
                        {d.aiNotes ? ' · AI notes' : ''}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div className="detail-pane">
            {active ? (
              <DistillationEditor key={active.id} d={active} status={status} onOpenSetup={onOpenSetup} onRemove={() => remove(active)} onNext={onNext} />
            ) : (
              <p className="muted">Create a distillation to start. It begins with all text sources selected.</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function DistillationEditor({ d, status, onOpenSetup, onRemove, onNext }: { d: Distillation; status: ProviderStatus | null; onOpenSetup: () => void; onRemove: () => void; onNext: () => void }) {
  const { clarity, updateClarity, toast } = useClarity();
  const { produce } = useOutputs();
  const [openId, setOpenId] = useState<string | null>(null);
  const [showCompare, setShowCompare] = useState(false);
  const [notesBusy, setNotesBusy] = useState(false);
  const [notesError, setNotesError] = useState<ReturnType<typeof describeError> | null>(null);
  const abort = useRef<AbortController | null>(null);

  const set = (fn: (x: Distillation) => void) =>
    updateClarity((p) => {
      const x = p.distillations.find((y) => y.id === d.id);
      if (x) {
        fn(x);
        x.updatedAt = nowIso();
      }
    });

  const { report, error } = useMemo((): { report: SelectionReport | null; error: string | null } => {
    try {
      return { report: runDistillation(d), error: null };
    } catch (e) {
      return { report: null, error: (e as Error).message };
    }
  }, [d]);
  const comparison = useMemo(() => {
    if (!showCompare) return null;
    try {
      return compareDistillation(d);
    } catch {
      return null;
    }
  }, [d, showCompare]);

  const sourcesById = new Map(clarity.sources.map((s) => [s.id, s]));
  const chosen = new Set(d.sourceIds);
  const recutNeeded = useMemo(() => {
    const cutFrom = new Set(d.excerpts.map((e) => e.sourceId));
    const textChosen = d.sourceIds.filter((id) => sourcesById.get(id)?.kind === 'text');
    return textChosen.some((id) => !cutFrom.has(id)) || [...cutFrom].some((id) => !chosen.has(id)) || d.excerpts.length === 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.excerpts, d.sourceIds, clarity.sources]);

  function recut() {
    if (d.excerpts.some((e) => e.required || e.priority !== 2) && !confirm('Cutting the excerpts again resets Required marks and priorities. Continue?')) return;
    const sources = clarity.sources.filter((s) => d.sourceIds.includes(s.id));
    set((x) => {
      x.excerpts = cutExcerpts(sources, x.splitMode);
      x.aiNotes = null;
    });
    toast('info', 'Excerpts cut again from the selected sources. AI notes were cleared because their references pointed to the old excerpts.');
  }

  const decisions = report ? new Map(report.decisions.map((x) => [x.id, x])) : new Map();
  const kept = report ? keptExcerpts(d, report) : [];
  const left = d.excerpts.filter((e) => !kept.includes(e));
  const secrets = useMemo(() => SecretScanner.kinds([d.instructions, d.task, ...d.excerpts.map((e) => e.text)].join('\n')), [d]);
  const aiReady = Boolean(status?.generation.configured);

  async function writeNotes() {
    if (!report) return;
    const excerpts = kept.length ? kept : d.excerpts;
    if (!confirm(`Send ${excerpts.length} excerpt(s) and the task to ${status?.generation.model ?? 'the AI provider'} (Anthropic) to write notes? The excerpts are sent as source material, not as instructions.`)) return;
    setNotesBusy(true);
    setNotesError(null);
    const ac = new AbortController();
    abort.current = ac;
    try {
      const res = await api.distilNotes({ task: d.task, excerpts: excerpts.map((e) => ({ id: e.id, ref: excerptRef(e), text: e.text })) }, ac.signal);
      // Validate again here; the server's verdicts are not trusted.
      const checked = validateNotes({ notes: res.notes.map((n) => ({ heading: n.heading, text: n.text, citations: n.citations.map((c) => ({ excerptId: c.excerptId, quote: c.quote })) })), gaps: res.gaps }, excerpts);
      set((x) => {
        x.aiNotes = { createdAt: nowIso(), model: res.model, notes: checked.notes, gaps: checked.gaps, warnings: checked.warnings, excerptIds: excerpts.map((e) => e.id) };
      });
      toast('success', `${checked.notes.length} AI note(s) written.${checked.warnings.length ? ' Some references could not be verified; see the warnings.' : ''}`);
    } catch (e) {
      const info = describeError(e);
      if (info.code === 'cancelled') toast('info', 'AI notes cancelled. Nothing was changed.');
      else setNotesError(info);
    } finally {
      setNotesBusy(false);
      abort.current = null;
    }
  }

  /**
   * Starts a prompt from the user's own task and protected instructions only. The excerpts stay in
   * the distillation and travel separately as source material, so text from imported documents is
   * never promoted to instructions.
   */
  function startPrompt() {
    const text = [d.instructions.trim(), d.task.trim()].filter(Boolean).join('\n\n');
    if (!text) {
      toast('error', 'Write the task (and any instructions) first. The prompt is made from them; the excerpts stay linked as source material.');
      return;
    }
    const t = nowIso();
    const rev = { id: newIdLocal('rev'), createdAt: t, kind: 'original' as const, text, parentId: null, summary: `Task and instructions from "${d.title}". Its ${kept.length} selected excerpt(s) stay linked as source material.`, changes: [], warnings: [], mode: null, model: null };
    const doc: PromptDoc = { id: newIdLocal('prm'), title: d.task.trim().split('\n')[0].slice(0, 60) || d.title, createdAt: t, updatedAt: t, distillationId: d.id, revisions: [rev], currentRevisionId: rev.id };
    updateClarity((p) => void p.prompts.push(doc));
    toast('success', 'Prompt created from your task and instructions. Refine it in the next step.');
    onNext();
  }

  async function exportPrepared() {
    if (!report) return;
    await produce('prepared-txt', `${slugify(d.title, 'prepared-prompt')}.txt`, 'text/plain;charset=utf-8', new TextEncoder().encode(report.selectedPrompt), {
      promptId: null,
      revisionId: null,
      distillationId: d.id,
      sourceIds: [...new Set(kept.map((e) => e.sourceId))],
    });
  }

  return (
    <article data-testid="distillation">
      <div className="row between gap-s wrap">
        <input className="title-input big" value={d.title} onChange={(e) => set((x) => void (x.title = e.target.value))} aria-label="Distillation title" />
        <button className="btn ghost danger small" onClick={onRemove}>
          Delete
        </button>
      </div>

      <div className="card">
        <h3 className="section-title">Sources</h3>
        <ul className="check-list">
          {clarity.sources
            .filter((s) => s.kind === 'text')
            .map((s) => (
              <li key={s.id}>
                <label className="check">
                  <input type="checkbox" checked={chosen.has(s.id)} onChange={(e) => set((x) => void (x.sourceIds = e.target.checked ? [...x.sourceIds, s.id] : x.sourceIds.filter((i) => i !== s.id)))} />
                  {s.name}
                </label>
              </li>
            ))}
        </ul>
        <div className="row gap-s wrap">
          <div className="segmented" role="group" aria-label="How to cut sources">
            <button className={d.splitMode === 'split' ? 'on' : ''} onClick={() => set((x) => void (x.splitMode = 'split'))} aria-pressed={d.splitMode === 'split'}>
              Split at headings / paragraphs
            </button>
            <button className={d.splitMode === 'whole' ? 'on' : ''} onClick={() => set((x) => void (x.splitMode = 'whole'))} aria-pressed={d.splitMode === 'whole'}>
              One excerpt per source
            </button>
          </div>
          <button className={`btn small ${recutNeeded ? 'primary' : ''}`} onClick={recut} data-testid="distil-recut">
            {recutNeeded ? 'Cut excerpts from selection' : 'Cut excerpts again'}
          </button>
          {recutNeeded && <span className="warn-text small">The source selection changed since the excerpts were cut.</span>}
        </div>
      </div>

      <div className="card grid-2">
        <label className="field">
          <span>Task (what the prepared prompt is for; kept verbatim, placed last)</span>
          <textarea rows={3} value={d.task} onChange={(e) => set((x) => void (x.task = e.target.value))} data-testid="distil-task" />
        </label>
        <label className="field">
          <span>Protected instructions (kept verbatim, placed first)</span>
          <textarea rows={3} value={d.instructions} onChange={(e) => set((x) => void (x.instructions = e.target.value))} data-testid="distil-instructions" />
        </label>
        <div className="field">
          <span>Strategy</span>
          <div className="segmented" role="group" aria-label="Selection strategy">
            {STRATEGY_IDS.map((s) => (
              <button key={s} className={d.strategy === s ? 'on' : ''} onClick={() => set((x) => void (x.strategy = s))} aria-pressed={d.strategy === s} data-testid={`strategy-${s}`}>
                {STRATEGY_LABEL[s]}
              </button>
            ))}
          </div>
          <span className="muted small">{strategySummary(STRATEGY_TO_DISTIL[d.strategy])}</span>
        </div>
        <div className="row gap-s wrap">
          <label className="field">
            <span>Budget (estimated tokens, whole prompt)</span>
            <input type="number" min={1} max={1000000} value={d.budget} onChange={(e) => { const n = Math.round(Number(e.target.value)); if (n >= 1 && n <= 1_000_000) set((x) => void (x.budget = n)); }} data-testid="distil-budget" />
          </label>
          <label className="check">
            <input type="checkbox" checked={d.dedupe} onChange={(e) => set((x) => void (x.dedupe = e.target.checked))} /> Remove exact duplicates before the budget
          </label>
        </div>
      </div>

      {secrets.length > 0 && (
        <div className="alert warn" role="alert">
          This text appears to contain credentials ({secrets.join(', ')}). Check before exporting or sending it to an AI provider.
        </div>
      )}

      {error && <div className="alert error">{error}</div>}
      {report && (
        <div className="card" data-testid="distil-result">
          <div className="outcome">
            <b data-testid="distil-outcome">{outcomeTitle(report.outcome)}</b>
            <span className="muted">{outcomeExplanation(report.outcome)}</span>
          </div>
          <p className="small">
            <b data-testid="distil-tokens">
              {report.originalTokens} → {report.selectedTokens}
            </b>{' '}
            tokens, {metricLabel(report.counter)}. {report.budgetSummary} Kept {report.keptCount} of {d.excerpts.length} excerpts.
          </p>
          <div className="row gap-s wrap">
            <button className="btn primary" onClick={startPrompt} data-testid="distil-to-refine">
              Refine the task and instructions →
            </button>
            <button className="btn" onClick={() => void navigator.clipboard?.writeText(report.selectedPrompt).then(() => toast('success', 'Prepared prompt copied.'), () => toast('error', 'Copying is not allowed here.'))}>
              Copy prepared prompt
            </button>
            <button className="btn" onClick={() => void exportPrepared()} data-testid="distil-export">
              Export prepared prompt (.txt)
            </button>
            <button className="btn ghost" onClick={() => setShowCompare((v) => !v)} aria-expanded={showCompare}>
              {showCompare ? 'Hide comparison' : 'Compare all strategies'}
            </button>
          </div>
          {comparison && (
            <table className="table small" aria-label="Strategy comparison">
              <thead>
                <tr>
                  <th>Strategy</th>
                  <th>Tokens</th>
                  <th>Kept</th>
                  <th>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {comparison.map((c) => (
                  <tr key={c.variant}>
                    <td>{variantLabel(c.variant)}</td>
                    <td>{c.report.selectedTokens}</td>
                    <td>{c.report.keptCount}</td>
                    <td>{outcomeTitle(c.report.outcome)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <div className="grid-2 top">
        <ExcerptList title={`Included (${kept.length})`} items={kept} decisions={decisions} openId={openId} setOpenId={setOpenId} set={set} sourcesById={sourcesById} testId="included" />
        <ExcerptList title={`Left out (${left.length})`} items={left} decisions={decisions} openId={openId} setOpenId={setOpenId} set={set} sourcesById={sourcesById} testId="left-out" />
      </div>

      <div className="card" data-testid="ai-notes">
        <div className="row between wrap gap-s">
          <div>
            <h3 className="section-title">AI notes <span className="derived-tag">AI-derived</span></h3>
            <p className="muted small">Optional. Notes are written from the included excerpts and must cite them. Each citation is checked: a quote that is not found in the cited excerpt is marked unverified.</p>
          </div>
          <div className="row gap-s">
            {notesBusy ? (
              <button className="btn" onClick={() => abort.current?.abort()} data-testid="notes-cancel">
                Stop
              </button>
            ) : aiReady ? (
              <button className="btn primary" onClick={() => void writeNotes()} disabled={!d.excerpts.length} data-testid="notes-run">
                {d.aiNotes ? 'Write notes again' : 'Write notes with AI'}
              </button>
            ) : (
              <button className="btn" onClick={onOpenSetup} data-testid="notes-setup">
                Set up AI to write notes
              </button>
            )}
          </div>
        </div>
        {!aiReady && <p className="muted small">No AI provider is configured{status ? '' : ' (the server is not reachable)'}. Everything else in Distil works without one.</p>}
        {notesBusy && <p className="small" aria-live="polite">Writing notes…</p>}
        {notesError && (
          <div className="alert error" role="alert" data-testid="notes-error">
            <b>{notesError.message}</b> {notesError.hint}
            {notesError.retryable && (
              <button className="btn small" onClick={() => void writeNotes()}>
                Retry
              </button>
            )}
          </div>
        )}
        {d.aiNotes && <NotesList d={d} />}
      </div>
    </article>
  );
}

function ExcerptList({
  title,
  items,
  decisions,
  openId,
  setOpenId,
  set,
  sourcesById,
  testId,
}: {
  title: string;
  items: Excerpt[];
  decisions: Map<string, { reason: string; standaloneTokens: number }>;
  openId: string | null;
  setOpenId: (id: string | null) => void;
  set: (fn: (x: Distillation) => void) => void;
  sourcesById: Map<string, Source>;
  testId: string;
}) {
  const edit = (id: string, fn: (e: Excerpt) => void) =>
    set((x) => {
      const e = x.excerpts.find((y) => y.id === id);
      if (e) fn(e);
    });
  return (
    <div className="card">
      <h3 className="section-title">{title}</h3>
      <ul className="excerpts" data-testid={testId}>
        {items.map((e) => {
          const dec = decisions.get(e.id);
          const source = sourcesById.get(e.sourceId);
          const intact = excerptMatchesSource(e, source);
          return (
            <li key={e.id} className="excerpt">
              <button className="excerpt-head" onClick={() => setOpenId(openId === e.id ? null : e.id)} aria-expanded={openId === e.id}>
                <span className="grow">
                  <span className="item-title">{e.title}</span>
                  <span className="ref" data-testid="excerpt-ref">
                    {excerptRef(e)}
                    {!source && ' (source removed)'}
                    {source && !intact && ' (does not match the source)'}
                  </span>
                </span>
                {e.required && <span className="pill small">Required</span>}
                <span className="muted small">{dec?.standaloneTokens ?? 0} tok</span>
              </button>
              {dec && <div className="muted small reason">{dec.reason}</div>}
              {openId === e.id && (
                <div className="excerpt-body">
                  <pre className="verbatim" aria-label={`Exact text of ${excerptRef(e)}`}>
                    {e.text}
                  </pre>
                  <div className="row gap-s wrap">
                    <label className="check">
                      <input type="checkbox" checked={e.required} onChange={(ev) => edit(e.id, (x) => void (x.required = ev.target.checked))} data-testid="excerpt-required" /> Required
                    </label>
                    <label className="field compact inline">
                      <span>Priority</span>
                      <select value={e.priority} onChange={(ev) => edit(e.id, (x) => void (x.priority = Number(ev.target.value)))}>
                        <option value={3}>High</option>
                        <option value={2}>Medium</option>
                        <option value={1}>Low</option>
                      </select>
                    </label>
                    <label className="field compact inline">
                      <span>Category</span>
                      <select value={e.category} onChange={(ev) => edit(e.id, (x) => void (x.category = ev.target.value))}>
                        {allContextCategories.map((c) => (
                          <option key={c}>{c}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                </div>
              )}
            </li>
          );
        })}
        {items.length === 0 && <li className="muted small">None.</li>}
      </ul>
    </div>
  );
}

function NotesList({ d }: { d: Distillation }) {
  const run = d.aiNotes!;
  const byId = new Map(d.excerpts.map((e) => [e.id, e]));
  return (
    <div className="notes" data-testid="notes-list">
      <p className="muted small">
        Written {new Date(run.createdAt).toLocaleString()} by {run.model}. These notes are derived by AI; the excerpts above are the original text.
      </p>
      {run.warnings.length > 0 && (
        <div className="alert warn" data-testid="notes-warnings">
          <ul>
            {run.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      <ul className="note-list">
        {run.notes.map((n) => (
          <li key={n.id} className="note">
            <b>{n.heading}</b> <span className="derived-tag">AI-derived</span>
            <p>{n.text}</p>
            <ul className="citations">
              {n.citations.map((c, i) => {
                const e = byId.get(c.excerptId);
                return (
                  <li key={i} className={c.verified ? 'ok' : 'bad'} data-testid={c.verified ? 'citation-verified' : 'citation-unverified'}>
                    {c.verified ? '✓' : '⚠ unverified'} {e ? excerptRef(e) : `unknown excerpt "${c.excerptId}"`} — “{c.quote}”
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
      {run.gaps.length > 0 && (
        <>
          <h4>Gaps the AI reported</h4>
          <ul>
            {run.gaps.map((g, i) => (
              <li key={i}>{g}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
