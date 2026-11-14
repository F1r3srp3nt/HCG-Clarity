/**
 * Application state: one HCG Clarity project (sources, distillations, prompts, outputs, deck)
 * and one binary store shared by all of them.
 *
 * `useStudio()` is the Presentation Studio state API, kept so the ported deck editor works
 * unchanged; it reads and writes `project.deck` of the Clarity project.
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import type { BinaryStore, Project, Slide } from '../shared/model';
import { emptyClarityProject, nowIso, type ClarityProject } from '../clarity/model';

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  message: string;
  hint?: string;
}

interface ClarityContextValue {
  clarity: ClarityProject;
  store: BinaryStore;
  storeVersion: number;
  dirty: boolean;
  /** Increments on every change; used by autosave. */
  revision: number;
  updateClarity: (fn: (draft: ClarityProject) => void) => void;
  putBinary: (id: string, blob: Blob) => void;
  dropBinary: (id: string) => void;
  replaceClarity: (project: ClarityProject, store: BinaryStore, dirty?: boolean) => void;
  markSaved: () => void;
  selectedId: string | null;
  select: (id: string | null) => void;
  toasts: Toast[];
  toast: (kind: Toast['kind'], message: string, hint?: string) => void;
  dismissToast: (id: number) => void;
}

const ClarityContext = createContext<ClarityContextValue | null>(null);

export function ClarityProvider({ children }: { children: ReactNode }) {
  const [clarity, setClarity] = useState<ClarityProject>(() => emptyClarityProject());
  const storeRef = useRef<BinaryStore>(new Map());
  const [storeVersion, setStoreVersion] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [revision, setRevision] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);

  const updateClarity = useCallback((fn: (draft: ClarityProject) => void) => {
    setClarity((prev) => {
      const draft = structuredClone(prev);
      fn(draft);
      draft.updatedAt = nowIso();
      return draft;
    });
    setDirty(true);
    setRevision((r) => r + 1);
  }, []);

  const putBinary = useCallback((id: string, blob: Blob) => {
    storeRef.current.set(id, blob);
    setStoreVersion((v) => v + 1);
  }, []);
  const dropBinary = useCallback((id: string) => {
    storeRef.current.delete(id);
    setStoreVersion((v) => v + 1);
  }, []);
  const replaceClarity = useCallback((p: ClarityProject, store: BinaryStore, isDirty = false) => {
    storeRef.current = store;
    setClarity(p);
    setStoreVersion((v) => v + 1);
    setSelectedId(p.deck.slides[0]?.id ?? null);
    setDirty(isDirty);
    setRevision((r) => r + 1);
  }, []);

  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const toast = useCallback(
    (kind: Toast['kind'], message: string, hint?: string) => {
      const id = ++toastId.current;
      setToasts((t) => [...t.slice(-3), { id, kind, message, hint }]);
      setTimeout(() => dismissToast(id), kind === 'error' ? 12000 : 5000);
    },
    [dismissToast],
  );

  const value = useMemo<ClarityContextValue>(
    () => ({
      clarity,
      store: storeRef.current,
      storeVersion,
      dirty,
      revision,
      updateClarity,
      putBinary,
      dropBinary,
      replaceClarity,
      markSaved: () => setDirty(false),
      selectedId,
      select: setSelectedId,
      toasts,
      toast,
      dismissToast,
    }),
    [clarity, storeVersion, dirty, revision, updateClarity, putBinary, dropBinary, replaceClarity, selectedId, toasts, toast, dismissToast],
  );
  return <ClarityContext.Provider value={value}>{children}</ClarityContext.Provider>;
}

export function useClarity(): ClarityContextValue {
  const ctx = useContext(ClarityContext);
  if (!ctx) throw new Error('useClarity outside ClarityProvider');
  return ctx;
}

// ---- Presentation Studio adapter ------------------------------------------------

interface StudioContextValue {
  project: Project;
  store: BinaryStore;
  storeVersion: number;
  dirty: boolean;
  update: (fn: (draft: Project) => void) => void;
  updateSlide: (id: string, fn: (s: Slide) => void) => void;
  putBinary: (id: string, blob: Blob) => void;
  dropBinary: (id: string) => void;
  selectedId: string | null;
  select: (id: string | null) => void;
  toast: (kind: Toast['kind'], message: string, hint?: string) => void;
}

export function useStudio(): StudioContextValue {
  const c = useClarity();
  const { updateClarity } = c;
  const update = useCallback((fn: (draft: Project) => void) => updateClarity((d) => fn(d.deck)), [updateClarity]);
  const updateSlide = useCallback(
    (id: string, fn: (s: Slide) => void) =>
      update((d) => {
        const s = d.slides.find((x) => x.id === id);
        if (s) fn(s);
      }),
    [update],
  );
  return {
    project: c.clarity.deck,
    store: c.store,
    storeVersion: c.storeVersion,
    dirty: c.dirty,
    update,
    updateSlide,
    putBinary: c.putBinary,
    dropBinary: c.dropBinary,
    selectedId: c.selectedId,
    select: c.select,
    toast: c.toast,
  };
}
