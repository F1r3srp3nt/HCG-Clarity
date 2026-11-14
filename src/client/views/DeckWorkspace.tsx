/**
 * Create → Presentation. The Presentation Studio deck workflow (images, brief, editor, restyle,
 * narration, presentation mode, PowerPoint export), now one output of an HCG Clarity project.
 * Ported from The Last Sprint presentation-studio/src/client/App.tsx; project open/save moved to
 * the application shell, and every export is recorded in the project's output history.
 */
import { useState } from 'react';
import type { ProviderStatus } from '../../shared/apiTypes';
import { renderSlide } from '../../shared/render';
import { getTheme } from '../../shared/themes';
import { slugify } from '../../shared/util';
import { exportPptxBytes } from '../../export/pptx';
import { buildNarrationZip } from '../../export/narrationZip';
import type { Project } from '../../shared/model';
import { narrationStatus } from '../../shared/narration';
import { imageForPptx } from '../images';
import { bridgeMessage } from '../desktop';
import { useGeneration } from '../generation';
import { useNarration } from '../narration';
import { useClarity, useStudio } from '../state';
import { useOutputs } from '../files';
import { BriefStep } from '../components/BriefStep';
import { Editor } from '../components/Editor';
import { NarrationDialog } from '../components/NarrationDialog';
import { PresentMode } from '../components/PresentMode';
import { RestyleDialog, type RestyleUndo } from '../components/RestyleDialog';
import { SourcesStep } from '../components/SourcesStep';

type Step = 'sources' | 'brief' | 'editor';
const STEPS: { id: Step; label: string }[] = [
  { id: 'sources', label: 'Images' },
  { id: 'brief', label: 'Brief' },
  { id: 'editor', label: 'Edit' },
];

export function DeckWorkspace({ status, onOpenSetup, onBack }: { status: ProviderStatus | null; onOpenSetup: () => void; onBack: () => void }) {
  const { project, store, update, toast, selectedId } = useStudio();
  const { clarity } = useClarity();
  const { produce } = useOutputs();
  const [step, setStep] = useState<Step>(project.slides.length ? 'editor' : project.brief.brief || project.brief.topic ? 'brief' : 'sources');
  const [narrationOpen, setNarrationOpen] = useState(false);
  const [presenting, setPresenting] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [restyleOpen, setRestyleOpen] = useState(false);
  const [restyleUndo, setRestyleUndo] = useState<RestyleUndo | null>(null);
  const [busy, setBusy] = useState(false);
  const gen = useGeneration();
  const narration = useNarration();

  async function pptxBytes(p: Project) {
    return exportPptxBytes(p, async (id) => {
      const asset = p.assets.find((a) => a.id === id);
      const blob = store.get(id);
      return asset && blob ? imageForPptx(asset, blob) : null;
    });
  }

  function overflowSummary(): string[] {
    const theme = getTheme(project.themeId);
    return project.slides.flatMap((s, i) => renderSlide(s, theme, project.assets).warnings.filter((w) => w.level === 'warning').map((w) => `Slide ${i + 1}: ${w.message}`));
  }

  async function onExport(kind: 'pptx' | 'zip') {
    setExportOpen(false);
    const problems = overflowSummary();
    if (problems.length && !confirm(`Some text does not fit and may overflow in PowerPoint:\n\n${problems.slice(0, 8).join('\n')}\n\nExport anyway?`)) return;
    if (kind === 'zip') {
      const outdated = project.slides.filter((s) => narrationStatus(s) === 'outdated').length;
      if (outdated && !confirm(`${outdated} slide(s) have outdated narration (the notes changed). Export anyway? The mapping file marks them as outdated.`)) return;
    }
    setBusy(true);
    try {
      const bytes = await pptxBytes(project);
      const links = { promptId: project.brief.promptId ?? null, revisionId: project.brief.revisionId ?? null, distillationId: project.brief.distillationId ?? null, sourceIds: project.assets.map((a) => a.id) };
      const base = slugify(project.title || clarity.title);
      if (kind === 'pptx') {
        await produce('pptx', `${base}.pptx`, 'application/vnd.openxmlformats-officedocument.presentationml.presentation', bytes, links);
      } else {
        const zip = await buildNarrationZip(project, bytes, store);
        await produce('pptx-narration-zip', `${base}-with-narration.zip`, 'application/zip', zip, links);
      }
    } catch (e) {
      toast('error', `Export failed: ${bridgeMessage(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const hasNarration = project.slides.some((s) => s.narration);
  const startIndex = Math.max(0, project.slides.findIndex((s) => s.id === selectedId));
  const empty = project.slides.length === 0;

  return (
    <div className="deck-workspace">
      <div className="deck-bar">
        <button className="btn ghost small" onClick={onBack}>
          ← All outputs
        </button>
        <input className="title-input" value={project.title} onChange={(e) => update((d) => void (d.title = e.target.value))} aria-label="Presentation title" data-testid="project-title" />
        <nav className="steps" aria-label="Presentation steps">
          {STEPS.map((s, i) => (
            <button key={s.id} className={`step-tab ${step === s.id ? 'active' : ''}`} onClick={() => setStep(s.id)} aria-current={step === s.id ? 'step' : undefined} data-testid={`step-${s.id}`}>
              <span className="step-no">{i + 1}</span>
              {s.label}
            </button>
          ))}
        </nav>
        <div className="actions">
          <button className="btn small" onClick={() => setRestyleOpen(true)} disabled={empty} data-testid="restyle-open" title="Change the theme and layouts without AI">
            Restyle…
          </button>
          <button className="btn small" onClick={() => setNarrationOpen(true)} disabled={empty}>
            Narration
          </button>
          <button className="btn small" onClick={() => setPresenting(true)} disabled={empty} data-testid="present">
            ▶ Present
          </button>
          <div className="add-wrap">
            <button className="btn small primary" onClick={() => setExportOpen((o) => !o)} disabled={empty || busy} aria-expanded={exportOpen} data-testid="export">
              {busy ? 'Exporting…' : 'Export ▾'}
            </button>
            {exportOpen && (
              <div className="menu right" role="menu">
                <button role="menuitem" onClick={() => onExport('pptx')} data-testid="export-pptx">
                  PowerPoint (.pptx)
                  <span className="muted small">Editable text, images and speaker notes</span>
                </button>
                {hasNarration && (
                  <button role="menuitem" onClick={() => onExport('zip')} data-testid="export-zip">
                    PowerPoint + narration (.zip)
                    <span className="muted small">.pptx, numbered MP3 files and a slide-to-audio mapping</span>
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {restyleUndo && (
        <div className="banner info" data-testid="restyle-banner">
          Deck restyled without AI. Text, speaker notes and narration are unchanged.{' '}
          <button
            className="btn small"
            onClick={() => {
              update((d) => {
                d.themeId = restyleUndo.themeId;
                for (const s of d.slides) if (restyleUndo.layouts[s.id]) s.layout = restyleUndo.layouts[s.id];
              });
              setRestyleUndo(null);
              toast('info', 'Restyle undone.');
            }}
            data-testid="restyle-undo"
          >
            Undo restyle
          </button>{' '}
          <button className="btn small ghost" onClick={() => setRestyleUndo(null)}>
            Dismiss
          </button>
        </div>
      )}

      <div className="deck-content">
        {step === 'sources' && <SourcesStep onNext={() => setStep('brief')} />}
        {step === 'brief' && <BriefStep status={status} gen={gen} onOpenSetup={onOpenSetup} onDone={() => setStep('editor')} />}
        {step === 'editor' && <Editor status={status} gen={gen} narration={narration} onOpenNarration={() => setNarrationOpen(true)} onGoBrief={() => setStep('brief')} />}
      </div>

      {restyleOpen && (
        <RestyleDialog
          project={project}
          onClose={() => setRestyleOpen(false)}
          onApply={(themeId, changes, undo) => {
            update((d) => {
              d.themeId = themeId;
              for (const c of changes) {
                const s = d.slides.find((x) => x.id === c.slideId);
                if (s) s.layout = c.to;
              }
            });
            setRestyleUndo(undo);
            setRestyleOpen(false);
            toast('success', `Deck restyled${changes.length ? `: ${changes.length} layout${changes.length === 1 ? '' : 's'} changed` : ''}. No AI was used.`);
          }}
        />
      )}
      {narrationOpen && <NarrationDialog status={status} narration={narration} onClose={() => setNarrationOpen(false)} onOpenSetup={() => { setNarrationOpen(false); onOpenSetup(); }} />}
      {presenting && <PresentMode startIndex={startIndex} onExit={() => setPresenting(false)} />}
    </div>
  );
}
