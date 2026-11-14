/** Create: produce deliverables from the project's refined instructions and distilled material. */
import { useMemo, useState } from 'react';
import type { ProviderStatus } from '../../shared/apiTypes';
import { slugify } from '../../shared/util';
import { currentRevision } from '../../clarity/model';
import { deckMaterial, runDistillation } from '../../clarity/distil';
import { buildClarityBrief } from '../../clarity/brief';
import { useOutputs } from '../files';
import { useClarity } from '../state';
import { DeckWorkspace } from './DeckWorkspace';

export function CreateView({ status, onOpenSetup }: { status: ProviderStatus | null; onOpenSetup: () => void }) {
  const { clarity, updateClarity, toast } = useClarity();
  const { produce } = useOutputs();
  const [deckOpen, setDeckOpen] = useState(false);
  const [promptId, setPromptId] = useState<string>(clarity.prompts[clarity.prompts.length - 1]?.id ?? '');
  const prompt = clarity.prompts.find((p) => p.id === promptId) ?? null;
  const [revisionId, setRevisionId] = useState<string>('');
  const revision = prompt ? (prompt.revisions.find((r) => r.id === revisionId) ?? currentRevision(prompt)) : null;
  const [distId, setDistId] = useState<string>(prompt?.distillationId ?? clarity.distillations[clarity.distillations.length - 1]?.id ?? '');
  const distillation = clarity.distillations.find((d) => d.id === distId) ?? null;
  const report = useMemo(() => {
    try {
      return distillation ? runDistillation(distillation) : null;
    } catch {
      return null;
    }
  }, [distillation]);

  const preview = useMemo(
    () => (revision || distillation ? buildClarityBrief({ project: clarity, prompt, revision, distillation, report, generatedAt: new Date() }) : ''),
    [clarity, prompt, revision, distillation, report],
  );

  if (deckOpen) return <DeckWorkspace status={status} onOpenSetup={onOpenSetup} onBack={() => setDeckOpen(false)} />;

  const links = {
    promptId: prompt?.id ?? null,
    revisionId: revision?.id ?? null,
    distillationId: distillation?.id ?? null,
    sourceIds: distillation ? [...new Set(distillation.excerpts.map((e) => e.sourceId))] : [],
  };

  async function exportBrief() {
    const md = buildClarityBrief({ project: clarity, prompt, revision, distillation, report, generatedAt: new Date() });
    await produce('brief-md', `${slugify(prompt?.title || clarity.title, 'clarity-brief')}-brief.md`, 'text/markdown;charset=utf-8', new TextEncoder().encode(md), links);
  }

  function fillDeckBrief() {
    const deck = clarity.deck;
    const hasBrief = deck.brief.brief.trim() || deck.brief.material.trim();
    if (hasBrief && !confirm('Replace the presentation brief and source material with the selected prompt and distillation?')) return;
    updateClarity((d) => {
      d.deck.brief.topic = prompt?.title || d.deck.brief.topic;
      d.deck.brief.brief = revision?.text ?? d.deck.brief.brief;
      d.deck.brief.material = distillation && report ? deckMaterial(distillation, report) : '';
      d.deck.brief.promptId = prompt?.id ?? null;
      d.deck.brief.revisionId = revision?.id ?? null;
      d.deck.brief.distillationId = distillation?.id ?? null;
      if (!d.deck.slides.length) d.deck.title = prompt?.title || d.title;
    });
    toast('success', 'Presentation brief filled. The distilled material is sent to the AI as source material, never as instructions.');
    setDeckOpen(true);
  }

  return (
    <section className="view" aria-labelledby="create-h">
      <header className="view-head">
        <div>
          <p className="eyebrow">Step 4</p>
          <h1 id="create-h">Create</h1>
          <p className="muted">Turn refined instructions and distilled material into deliverables. Every file you export is kept in History with links to what it was made from.</p>
        </div>
      </header>

      <div className="card grid-3">
        <label className="field">
          <span>Instructions (prompt)</span>
          <select value={promptId} onChange={(e) => { setPromptId(e.target.value); setRevisionId(''); const p = clarity.prompts.find((x) => x.id === e.target.value); if (p?.distillationId) setDistId(p.distillationId); }} data-testid="create-prompt">
            <option value="">None</option>
            {clarity.prompts.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Revision</span>
          <select value={revision?.id ?? ''} onChange={(e) => setRevisionId(e.target.value)} disabled={!prompt}>
            {prompt?.revisions.map((r, i) => (
              <option key={r.id} value={r.id}>
                {i + 1}. {r.kind}
                {r.id === prompt.currentRevisionId ? ' (current)' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Distilled material</span>
          <select value={distId} onChange={(e) => setDistId(e.target.value)} data-testid="create-distillation">
            <option value="">None</option>
            {clarity.distillations.map((d) => (
              <option key={d.id} value={d.id}>
                {d.title}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="output-grid">
        <article className="card output-card" data-testid="output-brief">
          <h2>Clarity brief</h2>
          <p className="muted small">A Markdown document: your instructions, the distilled excerpts verbatim with source references, AI notes marked as derived, and the source checksums.</p>
          <button className="btn primary" onClick={() => void exportBrief()} disabled={!preview} data-testid="export-brief">
            Export brief (.md)
          </button>
          {preview && (
            <details>
              <summary>Preview</summary>
              <pre className="verbatim preview">{preview}</pre>
            </details>
          )}
          {!preview && <p className="muted small">Choose a prompt or a distillation first.</p>}
        </article>

        <article className="card output-card" data-testid="output-deck">
          <h2>Presentation</h2>
          <p className="muted small">
            An editable PowerPoint deck (real text boxes, native shapes, your images, speaker notes), optionally with narration. Works without AI in template mode; AI generation uses Anthropic, narration uses ElevenLabs.
          </p>
          <p className="small">{clarity.deck.slides.length ? `${clarity.deck.slides.length} slide(s) in this project.` : 'No slides yet.'}</p>
          <div className="row gap-s wrap">
            <button className="btn primary" onClick={fillDeckBrief} disabled={!revision && !distillation} data-testid="deck-from-inputs">
              Fill brief from the selection
            </button>
            <button className="btn" onClick={() => setDeckOpen(true)} data-testid="open-deck">
              Open presentation
            </button>
          </div>
        </article>

        <article className="card output-card">
          <h2>Prompt files</h2>
          <p className="muted small">Text, Markdown and JSON exports of a prompt and its enhancement are in Refine. Prepared prompts from a distillation are exported in Distil.</p>
        </article>
      </div>
    </section>
  );
}
