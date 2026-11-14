/** Saving files (browser download or the desktop app's save dialog) and recording outputs. */
import { useCallback } from 'react';
import { bytesToBlob } from '../shared/util';
import { newIdLocal, nowIso, type Output, type OutputKind } from '../clarity/model';
import { bridgeMessage, desktop, type DesktopFileKind } from './desktop';
import { downloadBytes } from './images';
import { useClarity } from './state';

export async function deliver(kind: DesktopFileKind, bytes: Uint8Array | Blob, name: string, type: string): Promise<{ done: boolean; where?: string }> {
  if (!desktop) {
    downloadBytes(bytes, name, type);
    return { done: true };
  }
  const data = bytes instanceof Blob ? new Uint8Array(await bytes.arrayBuffer()) : bytes;
  const r = await desktop.files.save(kind, name, data);
  return r.saved ? { done: true, where: r.fileName } : { done: false };
}

const DESKTOP_KIND: Record<OutputKind, DesktopFileKind> = {
  'brief-md': 'markdown',
  'prompt-md': 'markdown',
  'prompt-txt': 'text',
  'prepared-txt': 'text',
  'prompt-json': 'json',
  pptx: 'pptx',
  'pptx-narration-zip': 'zip',
};

export const OUTPUT_LABELS: Record<OutputKind, string> = {
  'brief-md': 'Clarity brief (Markdown)',
  'prompt-md': 'Prompt (Markdown)',
  'prompt-txt': 'Prompt (plain text)',
  'prompt-json': 'Prompt (JSON)',
  'prepared-txt': 'Prepared prompt (plain text)',
  pptx: 'Presentation (PowerPoint)',
  'pptx-narration-zip': 'Presentation + narration (ZIP)',
};

export type OutputLinks = Pick<Output, 'promptId' | 'revisionId' | 'distillationId' | 'sourceIds'>;

/**
 * Saves a file for the user and keeps a copy in the project's output history, so it can be
 * downloaded again after the project is reopened.
 */
export function useOutputs() {
  const { putBinary, updateClarity, toast, store } = useClarity();

  const produce = useCallback(
    async (kind: OutputKind, fileName: string, mime: string, bytes: Uint8Array, links: OutputLinks): Promise<boolean> => {
      try {
        const r = await deliver(DESKTOP_KIND[kind], bytes, fileName, mime);
        if (!r.done) return false;
        const id = newIdLocal('out');
        putBinary(id, bytesToBlob(bytes, mime));
        updateClarity((d) => {
          d.outputs.unshift({ id, kind, fileName, mime, bytes: bytes.byteLength, createdAt: nowIso(), ...links });
        });
        toast('success', `${OUTPUT_LABELS[kind]} saved${r.where ? ` as ${r.where}` : ''}. A copy is kept in History.`);
        return true;
      } catch (e) {
        toast('error', `Could not save the file: ${bridgeMessage(e)}`);
        return false;
      }
    },
    [putBinary, updateClarity, toast],
  );

  const redownload = useCallback(
    async (o: Output) => {
      const blob = store.get(o.id);
      if (!blob) {
        toast('error', 'This output is no longer stored in the project.');
        return;
      }
      try {
        await deliver(DESKTOP_KIND[o.kind], blob, o.fileName, o.mime);
      } catch (e) {
        toast('error', `Could not save the file: ${bridgeMessage(e)}`);
      }
    },
    [store, toast],
  );

  return { produce, redownload };
}
