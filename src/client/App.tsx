/**
 * HCG Clarity application shell: workflow navigation (Sources → Distil → Refine → Create, plus
 * History), project open/save/migration, autosave recovery and provider status.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProviderStatus } from '../shared/apiTypes';
import { slugify } from '../shared/util';
import { emptyClarityProject } from '../clarity/model';
import { CLARITY_EXTENSION, loadClarityProject, saveClarityProject } from '../clarity/projectFile';
import { api } from './api';
import { bridgeMessage, desktop } from './desktop';
import { deliver } from './files';
import { clearRecovery, readRecovery, writeRecovery, type RecoveryRecord } from './recovery';
import { useClarity } from './state';
import { SetupDialog } from './components/SetupDialog';
import { SourcesView } from './views/SourcesView';
import { DistilView } from './views/DistilView';
import { RefineView } from './views/RefineView';
import { CreateView } from './views/CreateView';
import { HistoryView } from './views/HistoryView';

export type View = 'sources' | 'distil' | 'refine' | 'create' | 'history';

export function App() {
  const { clarity, store, updateClarity, replaceClarity, markSaved, dirty, revision, toast, toasts, dismissToast } = useClarity();
  const [view, setView] = useState<View>('sources');
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [statusChecked, setStatusChecked] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<RecoveryRecord | null>(null);
  const [migration, setMigration] = useState<string[]>([]);
  const openInput = useRef<HTMLInputElement>(null);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api.status());
    } catch {
      setStatus(null);
    } finally {
      setStatusChecked(true);
    }
  }, []);
  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);
  useEffect(() => desktop?.backend.onChange((s) => s.state === 'ready' && void refreshStatus()), [refreshStatus]);

  // ---- Recovery ------------------------------------------------------------------
  useEffect(() => {
    void readRecovery().then((r) => r && setRecovery(r));
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(() => {
      void saveClarityProject(clarity, store)
        .then((bytes) => writeRecovery({ title: clarity.title, savedAt: new Date().toISOString(), bytes }))
        .catch(() => {
          /* Recovery is best effort; Save reports real errors. */
        });
    }, 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision, dirty]);

  async function restoreRecovery() {
    if (!recovery) return;
    try {
      const loaded = await loadClarityProject(recovery.bytes, recovery.title);
      replaceClarity(loaded.project, loaded.store, true);
      setRecovery(null);
      toast('success', `Recovered "${loaded.project.title}". Save it to keep it as a file.`, loaded.warnings.join(' '));
    } catch (e) {
      toast('error', `The recovered copy could not be opened: ${(e as Error).message}`);
    }
  }

  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [dirty]);

  // ---- Project files -------------------------------------------------------------------
  async function onSave() {
    setBusy('save');
    try {
      const bytes = await saveClarityProject(clarity, store);
      const r = await deliver('project', bytes, `${slugify(clarity.title, 'project')}${CLARITY_EXTENSION}`, 'application/zip');
      if (!r.done) return;
      markSaved();
      void clearRecovery();
      setRecovery(null);
      toast('success', `Project saved${r.where ? ` as ${r.where}` : ''}. It contains your sources, notes, prompt revisions, outputs and deck.`);
    } catch (e) {
      toast('error', `Could not save: ${bridgeMessage(e)}`);
    } finally {
      setBusy(null);
    }
  }

  async function onOpen(file: File, confirmed = false) {
    if (!confirmed && dirty && !confirm('Open another project? Unsaved changes in this one will be lost.')) return;
    setBusy('open');
    try {
      const loaded = await loadClarityProject(file, file.name);
      replaceClarity(loaded.project, loaded.store, loaded.migratedFrom !== null);
      setMigration(loaded.project.migrationNotes.length && loaded.migratedFrom ? loaded.project.migrationNotes : []);
      setView(loaded.migratedFrom === 'reprompter' ? 'refine' : loaded.migratedFrom === 'presentation-studio' ? 'create' : 'sources');
      toast('success', loaded.migratedFrom ? `Converted "${file.name}" into an HCG Clarity project.` : `Opened "${loaded.project.title}".`, loaded.warnings.join(' ') || undefined);
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function openWithDialog() {
    if (!desktop) return;
    if (dirty && !confirm('Open another project? Unsaved changes in this one will be lost.')) return;
    try {
      const r = await desktop.files.openProject();
      if (r.opened) await onOpen(new File([r.bytes as Uint8Array<ArrayBuffer>], r.fileName), true);
    } catch (e) {
      toast('error', `Could not open: ${bridgeMessage(e)}`);
    }
  }

  function newProject() {
    if (dirty && !confirm('Start a new project? Unsaved changes will be lost.')) return;
    replaceClarity(emptyClarityProject(), new Map());
    setMigration([]);
    void clearRecovery();
    setView('sources');
  }

  const genReady = status?.generation.configured;
  const elReady = status?.elevenlabs.configured;
  const nav: { id: View; label: string; hint: string; count: number }[] = [
    { id: 'sources', label: 'Sources', hint: 'Import material', count: clarity.sources.length },
    { id: 'distil', label: 'Distil', hint: 'Select and note', count: clarity.distillations.length },
    { id: 'refine', label: 'Refine', hint: 'Shape instructions', count: clarity.prompts.length },
    { id: 'create', label: 'Create', hint: 'Make outputs', count: clarity.deck.slides.length ? 1 : 0 },
    { id: 'history', label: 'History', hint: 'Outputs made', count: clarity.outputs.length },
  ];

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img className="logo" src="/hcg-mark.png" alt="HCG logo" width={34} height={34} data-testid="hcg-logo" />
          <div>
            <div className="brand-name">HCG Clarity</div>
            <div className="brand-sub">Hakmi Capital Group</div>
          </div>
        </div>
        <input
          className="title-input"
          value={clarity.title}
          onChange={(e) => updateClarity((d) => void (d.title = e.target.value))}
          aria-label="Project title"
          data-testid="clarity-title"
        />
        <span className="spacer" />
        <div className="actions">
          <button
            className="provider-pill"
            onClick={() => setSetupOpen(true)}
            title="Providers: grey = not configured, amber = configured but not verified, green = verified, red = check failed"
            data-testid="open-setup"
          >
            <span className={`dot ${genReady ? (status?.generation.verified === true ? 'ok' : status?.generation.verified === false ? 'bad' : 'idle') : 'off'}`} /> AI
            <span className={`dot ${elReady ? (status?.elevenlabs.verified === true ? 'ok' : status?.elevenlabs.verified === false ? 'bad' : 'idle') : 'off'}`} /> Voice
          </button>
          <button className="btn ghost small" onClick={newProject} data-testid="new-project">
            New
          </button>
          <button className="btn ghost small" onClick={() => (desktop ? void openWithDialog() : openInput.current?.click())} disabled={busy !== null} data-testid="open-project">
            Open…
          </button>
          <input
            ref={openInput}
            type="file"
            accept={`${CLARITY_EXTENSION},.pstudio,.json,application/zip,application/json`}
            hidden
            data-testid="open-input"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void onOpen(f);
            }}
          />
          <button className="btn small primary" onClick={onSave} disabled={busy !== null} data-testid="save-project">
            {busy === 'save' ? 'Saving…' : `Save${dirty ? ' •' : ''}`}
          </button>
        </div>
      </header>

      {statusChecked && status === null && (
        <div className="banner error" role="status" data-testid="server-banner">
          {desktop
            ? 'The built-in server is not responding. Sources, Distil, local Refine tools, editing, saving and exports still work; AI features and voice need it.'
            : 'The local server is not reachable. Sources, Distil, local Refine tools, editing, saving and exports still work in this tab; AI features and voice need the server (npm run dev).'}{' '}
          <button className="btn small" onClick={() => void refreshStatus()}>
            Check again
          </button>
        </div>
      )}
      {recovery && (
        <div className="banner info" role="status" data-testid="recovery-banner">
          Unsaved work from {new Date(recovery.savedAt).toLocaleString()} (“{recovery.title}”) can be recovered.{' '}
          <button className="btn small" onClick={() => void restoreRecovery()} data-testid="recovery-restore">
            Recover
          </button>{' '}
          <button
            className="btn small ghost"
            onClick={() => {
              void clearRecovery();
              setRecovery(null);
            }}
          >
            Discard
          </button>
        </div>
      )}
      {migration.length > 0 && (
        <div className="banner info" role="status" data-testid="migration-banner">
          {migration.map((m, i) => (
            <div key={i}>{m}</div>
          ))}
          <button className="btn small ghost" onClick={() => setMigration([])}>
            Dismiss
          </button>
        </div>
      )}

      <div className="shell">
        <nav className="sidebar" aria-label="Workflow">
          <ol>
            {nav.map((n, i) => (
              <li key={n.id}>
                <button className={`nav-item ${view === n.id ? 'active' : ''}`} onClick={() => setView(n.id)} aria-current={view === n.id ? 'page' : undefined} data-testid={`nav-${n.id}`}>
                  <span className="nav-no" aria-hidden>
                    {n.id === 'history' ? '◷' : i + 1}
                  </span>
                  <span className="nav-text">
                    <span className="nav-label">{n.label}</span>
                    <span className="nav-hint">{n.hint}</span>
                  </span>
                  {n.count > 0 && <span className="nav-count">{n.count}</span>}
                </button>
              </li>
            ))}
          </ol>
          <div className="sidebar-foot">
            <button className="nav-item" onClick={() => setSetupOpen(true)} data-testid="nav-settings">
              <span className="nav-no" aria-hidden>
                ⚙
              </span>
              <span className="nav-text">
                <span className="nav-label">Settings</span>
                <span className="nav-hint">Providers and keys</span>
              </span>
            </button>
          </div>
        </nav>
        <main className="content" id="main">
          {view === 'sources' && <SourcesView onNext={() => setView('distil')} />}
          {view === 'distil' && <DistilView status={status} onOpenSetup={() => setSetupOpen(true)} onNext={() => setView('refine')} />}
          {view === 'refine' && <RefineView status={status} onOpenSetup={() => setSetupOpen(true)} onNext={() => setView('create')} />}
          {view === 'create' && <CreateView status={status} onOpenSetup={() => setSetupOpen(true)} />}
          {view === 'history' && <HistoryView />}
        </main>
      </div>

      {setupOpen && (
        <SetupDialog
          status={status}
          onStatus={setStatus}
          onClose={() => {
            setSetupOpen(false);
            void refreshStatus();
          }}
        />
      )}

      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
            <div>
              <b>{t.message}</b>
              {t.hint && <div className="small">{t.hint}</div>}
            </div>
            <button className="btn icon tiny" onClick={() => dismissToast(t.id)} aria-label="Dismiss">
              ✕
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
