/** HCG Clarity project files: save and reopen, integrity checks, and migration of older files. */
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { saveProject as saveDeck } from '../../src/project/projectFile';
import { emptyClarityProject, type ClarityProject } from '../../src/clarity/model';
import { loadClarityProject, saveClarityProject } from '../../src/clarity/projectFile';
import { textSourceFromBytes } from '../../src/clarity/sources';
import { newDistillation, runDistillation } from '../../src/clarity/distil';
import { addRevision, newPromptDoc } from '../../src/clarity/refine';
import { bytesToBlob } from '../../src/shared/util';
import type { BinaryStore } from '../../src/shared/model';
import { sampleProject } from '../helpers';

const enc = new TextEncoder();
const NOTES = '# Rate limits\nThe API allows 10 requests per second.\r\n\n# Error codes\nNever retry 400 or 413.\n';

async function richProject(): Promise<{ project: ClarityProject; store: BinaryStore }> {
  const project = emptyClarityProject();
  project.title = 'Synthetic project';
  const store: BinaryStore = new Map();
  const bytes = enc.encode(NOTES);
  const src = await textSourceFromBytes('notes.md', bytes, 'file');
  project.sources.push(src);
  store.set(src.id, bytesToBlob(bytes, src.mime));
  const d = newDistillation(project, [src.id]);
  d.task = 'Write retry guidance';
  d.excerpts[1].required = true;
  project.distillations.push(d);
  const doc = newPromptDoc('Retry guidance', 'Write retry guidance.');
  doc.distillationId = d.id;
  addRevision(doc, { kind: 'manual', text: 'Write retry guidance for the client.', summary: '', changes: [], warnings: [], mode: null, model: null });
  project.prompts.push(doc);
  const out = enc.encode('# Brief\n');
  project.outputs.push({ id: 'out_1', kind: 'brief-md', fileName: 'brief.md', mime: 'text/markdown', bytes: out.byteLength, createdAt: new Date().toISOString(), promptId: doc.id, revisionId: doc.currentRevisionId, distillationId: d.id, sourceIds: [src.id] });
  store.set('out_1', bytesToBlob(out, 'text/markdown'));
  const deck = sampleProject();
  project.deck = deck.project;
  for (const [k, v] of deck.store) store.set(k, v);
  return { project, store };
}

describe('save and reopen', () => {
  it('keeps sources byte-for-byte, distillations, prompt revisions, outputs, the deck and their links', async () => {
    const { project, store } = await richProject();
    const loaded = await loadClarityProject(await saveClarityProject(project, store), 'p.clarity');
    expect(loaded.warnings).toEqual([]);
    expect(loaded.migratedFrom).toBeNull();
    expect(loaded.project).toEqual(project);
    const srcId = project.sources[0].id;
    expect(new Uint8Array(await loaded.store.get(srcId)!.arrayBuffer())).toEqual(enc.encode(NOTES));
    expect(await loaded.store.get('out_1')!.text()).toBe('# Brief\n');
    for (const a of project.deck.assets) {
      expect(new Uint8Array(await loaded.store.get(a.id)!.arrayBuffer())).toEqual(new Uint8Array(await store.get(a.id)!.arrayBuffer()));
    }
    const p = loaded.project.prompts[0];
    expect(p.revisions.map((r) => r.kind)).toEqual(['original', 'manual']);
    expect(p.revisions[1].parentId).toBe(p.revisions[0].id);
    expect(p.distillationId).toBe(loaded.project.distillations[0].id);
    // Selection gives the same result after reopening.
    expect(runDistillation(loaded.project.distillations[0]).selectedPrompt).toBe(runDistillation(project.distillations[0]).selectedPrompt);
  });

  it('reports an original that no longer matches its checksum', async () => {
    const { project, store } = await richProject();
    const zip = await JSZip.loadAsync(await saveClarityProject(project, store));
    zip.file(`files/${project.sources[0].id}`, 'tampered');
    const loaded = await loadClarityProject(await zip.generateAsync({ type: 'uint8array' }));
    expect(loaded.warnings.join(' ')).toMatch(/does not match its recorded checksum/);
  });

  it('removes references to missing files instead of failing', async () => {
    const { project, store } = await richProject();
    const zip = await JSZip.loadAsync(await saveClarityProject(project, store));
    zip.remove(`files/${project.deck.assets[0].id}`);
    zip.remove('files/out_1');
    const loaded = await loadClarityProject(await zip.generateAsync({ type: 'uint8array' }));
    expect(loaded.warnings.length).toBe(2);
    expect(loaded.project.outputs).toEqual([]);
    expect(loaded.project.deck.assets.some((a) => a.id === project.deck.assets[0].id)).toBe(false);
    expect(loaded.project.deck.slides.every((s) => s.image?.assetId !== project.deck.assets[0].id)).toBe(true);
  });

  it('refuses to save a project whose source data is missing', async () => {
    const { project, store } = await richProject();
    store.delete(project.sources[0].id);
    await expect(saveClarityProject(project, store)).rejects.toThrow(/missing its data/);
  });

  it('rejects damaged, foreign and newer files with a clear message', async () => {
    await expect(loadClarityProject(new Uint8Array([1, 2, 3]))).rejects.toThrow(/not an HCG Clarity project/);
    await expect(loadClarityProject(enc.encode('{"hello":1}'))).rejects.toThrow(/not a Distil project or an HCG RePrompter backup/);
    const zip = new JSZip();
    zip.file('clarity.json', JSON.stringify({ ...emptyClarityProject(), version: 2 }));
    await expect(loadClarityProject(await zip.generateAsync({ type: 'uint8array' }))).rejects.toThrow(/newer version/);
    const bad = new JSZip();
    bad.file('clarity.json', JSON.stringify({ ...emptyClarityProject(), sources: 'nope' }));
    await expect(loadClarityProject(await bad.generateAsync({ type: 'uint8array' }))).rejects.toThrow(/not in a supported format/);
  });
});

describe('migration of existing user data', () => {
  it('converts a Presentation Studio project into the deck, keeping images and slides', async () => {
    const { project: deck, store } = sampleProject();
    const loaded = await loadClarityProject(await saveDeck(deck, store), 'pilot.pstudio');
    expect(loaded.migratedFrom).toBe('presentation-studio');
    expect(loaded.project.deck.slides).toEqual(deck.slides);
    expect(loaded.project.deck.brief.material).toBe('');
    expect(loaded.project.sources.map((s) => s.id).sort()).toEqual(deck.assets.map((a) => a.id).sort());
    expect(loaded.project.migrationNotes[0]).toMatch(/Presentation Studio/);
    // A converted project saves and reopens as a .clarity file.
    const again = await loadClarityProject(await saveClarityProject(loaded.project, loaded.store));
    expect(again.project.deck).toEqual(loaded.project.deck);
  });

  it('converts a Distil project (schema 3) into text sources and a distillation', async () => {
    const distil = {
      schemaVersion: 3,
      notes: '',
      draft: {
        task: 'Summarise the error handling',
        instructions: 'Be brief.',
        blocks: [
          { id: 'B1', title: 'Rate limits', text: 'Ten requests per second.', category: 'Reference', priority: 2, required: false, pastedSourceID: 'P1' },
          { id: 'B2', title: 'Loose block', text: 'A block typed by hand.', category: 'Reference', priority: 3, required: true },
        ],
      },
      settings: { strategy: 'budgetSelection', budget: 300, deduplicateBeforeBudget: false, counter: { approximate: { bytesPerToken: 4 } } },
      reviewTemplate: { expectedFacts: [], correctnessChecks: [] },
      library: [],
      experiments: [],
      pastedSources: [{ id: 'P1', title: 'Pasted notes', text: '# Rate limits\nTen requests per second.\n', importedAt: '2026-10-29T20:53:20Z' }],
    };
    const loaded = await loadClarityProject(enc.encode(JSON.stringify(distil)), 'api.json');
    expect(loaded.migratedFrom).toBe('distil');
    expect(loaded.project.sources.map((s) => [s.name, s.text])).toEqual([
      ['Pasted notes', '# Rate limits\nTen requests per second.\n'],
      ['Loose block', 'A block typed by hand.'],
    ]);
    const d = loaded.project.distillations[0];
    expect(d).toMatchObject({ task: 'Summarise the error handling', instructions: 'Be brief.', strategy: 'priority', budget: 300, dedupe: false });
    expect(loaded.project.migrationNotes.join(' ')).toMatch(/Not carried over/);
    for (const s of loaded.project.sources) expect(await loaded.store.get(s.id)!.text()).toBe(s.text);
  });

  it('rejects older Distil schemas with instructions instead of guessing', async () => {
    await expect(loadClarityProject(enc.encode(JSON.stringify({ schemaVersion: 1, draft: {}, library: [] })))).rejects.toThrow(/schema 1/);
  });

  it('imports an HCG RePrompter backup as prompts with revisions', async () => {
    const backup = {
      format: 'hcg-reprompter-backup',
      schemaVersion: 1,
      appVersion: '0.1.0',
      exportedAt: 815000000,
      userTemplates: [],
      records: [
        { id: 'A', title: 'Feature brief', originalPrompt: 'build a login page', enhancedPrompt: '## Objective\nBuild a login page.', mode: 'structured', status: 'accepted', isSaved: true, createdAt: 815000000, updatedAt: 815000100 },
        { id: 'B', title: 'Rejected', originalPrompt: 'keep this', enhancedPrompt: 'not this', mode: 'quickImprove', status: 'rejected', isSaved: true, createdAt: 815000000, updatedAt: 815000000 },
      ],
    };
    const loaded = await loadClarityProject(enc.encode(JSON.stringify(backup)), 'backup.json');
    expect(loaded.migratedFrom).toBe('reprompter');
    const [a, b] = loaded.project.prompts;
    expect(a.revisions.map((r) => [r.kind, r.text])).toEqual([
      ['original', 'build a login page'],
      ['ai', '## Objective\nBuild a login page.'],
    ]);
    expect(a.currentRevisionId).toBe(a.revisions[1].id);
    expect(a.revisions[0].createdAt).toBe('2026-10-29T20:53:20.000Z');
    expect(b.revisions.map((r) => r.text)).toEqual(['keep this']);
  });
});
