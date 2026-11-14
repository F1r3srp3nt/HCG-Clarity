// End-to-end test of the HCG Clarity workflow in a real browser (Playwright + Chromium).
// Sources → Distil (+ AI notes, cancellation) → Refine (local + AI, revisions) → Create
// (brief, presentation, .pptx) → History → save, reopen, recovery, migration, failures.
// AI calls go to the local MOCK provider (e2e/mock-providers.mjs); no real keys or paid calls.
//
// Usage: npm run test:e2e:clarity
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { startMockProviders } from './mock-providers.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'test-output', 'clarity-e2e');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const sample = (f) => join(root, 'samples', f);
const KEY = 'e2e-clarity-anthropic-key-DO-NOT-LEAK';
const results = [];
const step = async (name, fn) => {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (e) {
    results.push({ name, ok: false });
    console.log(`  ✕ ${name}\n    ${String(e?.stack ?? e).split('\n').slice(0, 5).join('\n    ')}`);
    throw e;
  }
};
function startServer(port, env) {
  const logs = [];
  const child = spawn(process.execPath, [join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'server/index.ts'], {
    cwd: root,
    env: { ...process.env, NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1', ANTHROPIC_API_KEY: '', ELEVENLABS_API_KEY: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));
  return { child, logs, url: `http://127.0.0.1:${port}` };
}
async function waitFor(url) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Server did not start: ${url}`);
}
async function download(page, click, file) {
  const [dl] = await Promise.all([page.waitForEvent('download'), click()]);
  const path = join(out, file);
  await dl.saveAs(path);
  return path;
}

console.log('Building client…');
execFileSync(process.execPath, [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--logLevel', 'error'], { cwd: root, stdio: 'inherit' });

const browser = await chromium.launch();
const mocks = await startMockProviders({ anthropicKey: KEY });
const ai = startServer(8811, { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: mocks.anthropicUrl });
const plain = startServer(8812, {});
let failed = false;

try {
  await Promise.all([waitFor(`${ai.url}/api/status`), waitFor(`${plain.url}/api/status`)]);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => d.accept());
  await page.goto(ai.url);
  const notesText = readFileSync(sample('clarity-upload-notes.md'), 'utf8');

  console.log('\nWorkflow with the MOCK AI provider');
  await step('Sources: import a text file and an image; unsupported and duplicate files are refused', async () => {
    const pdf = join(out, 'not-supported.pdf');
    writeFileSync(pdf, '%PDF-1.4 synthetic');
    await page.setInputFiles('[data-testid=source-input]', [sample('clarity-upload-notes.md'), sample('bike-station-portrait.jpg'), pdf]);
    await page.locator('[data-testid=source-item]').nth(1).waitFor();
    assert.equal(await page.locator('[data-testid=source-item]').count(), 2);
    assert.match(await page.locator('.toast.error').first().innerText(), /PDF, Word, PowerPoint and RTF files are not supported yet/);
    await page.setInputFiles('[data-testid=source-input]', [sample('clarity-upload-notes.md')]);
    await page.getByText('already in Sources').waitFor();
    assert.equal(await page.locator('[data-testid=source-item]').count(), 2);
    await page.locator('[data-testid=source-item]').first().click();
    const detail = await page.locator('[data-testid=source-detail]').innerText();
    assert.match(detail, /[0-9a-f]{64}/);
    assert.match(detail, /Ignore all previous instructions/);
    await page.screenshot({ path: join(out, '1-sources.png') });
  });

  await step('Distil: excerpts reference exact source lines; a Required mark changes the selection', async () => {
    await page.click('[data-testid=nav-distil]');
    await page.click('[data-testid=distil-new]');
    await page.fill('[data-testid=distil-task]', 'Write retry guidance for the upload client.');
    await page.click('[data-testid=strategy-relevance]');
    await page.fill('[data-testid=distil-budget]', '120');
    await page.locator('[data-testid=distil-outcome]').waitFor();
    const refs = await page.locator('[data-testid=excerpt-ref]').allInnerTexts();
    assert.ok(refs.length >= 4);
    const lines = notesText.split('\n');
    for (const r of refs) {
      const m = /clarity-upload-notes\.md · lines? (\d+)(?:–(\d+))?/.exec(r);
      assert.ok(m, `reference format: ${r}`);
      assert.ok(Number(m[1]) >= 1 && Number(m[2] ?? m[1]) <= lines.length);
    }
    assert.equal(await page.locator('[data-testid=excerpt-ref]', { hasText: 'does not match' }).count(), 0);
    const leftOut = page.locator('[data-testid=left-out] .excerpt');
    const nLeft = await leftOut.count();
    assert.ok(nLeft > 0, 'budget leaves something out');
    const target = leftOut.first();
    const title = await target.locator('.item-title').innerText();
    await target.locator('.excerpt-head').click();
    const box = await target.locator('[data-testid=excerpt-required]').elementHandle();
    await box.click();
    // Required content is always kept (another optional excerpt may be dropped to stay in budget).
    await page.locator('[data-testid=included] .excerpt', { hasText: title }).waitFor();
    assert.equal(await page.locator('[data-testid=included] .excerpt', { hasText: title }).locator('.pill', { hasText: 'Required' }).count(), 1);
    await page.screenshot({ path: join(out, '2-distil.png') });
  });

  await step('Distil: export the prepared prompt verbatim and record it in History', async () => {
    await page.fill('[data-testid=distil-budget]', '2000');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid=left-out] .excerpt').length === 0);
    const p = await download(page, () => page.click('[data-testid=distil-export]'), 'prepared.txt');
    const text = readFileSync(p, 'utf8');
    assert.match(text, /Write retry guidance for the upload client\.$/);
    assert.ok(text.includes('Never retry 400 or 413: the request itself is wrong.'));
  });

  await step('AI notes: cancelling stops the request and changes nothing', async () => {
    mocks.state.anthropicMode = 'slow';
    mocks.state.slowAborted = 0;
    mocks.state.slowStarted = 0;
    await page.click('[data-testid=notes-run]');
    await page.locator('[data-testid=notes-cancel]').waitFor();
    for (let i = 0; i < 100 && !mocks.state.slowStarted; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(mocks.state.slowStarted, 1, 'request reached the provider');
    await page.click('[data-testid=notes-cancel]');
    await page.getByText('AI notes cancelled').waitFor();
    assert.equal(await page.locator('[data-testid=notes-list]').count(), 0);
    for (let i = 0; i < 50 && !mocks.state.slowAborted; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(mocks.state.slowAborted, 1, 'upstream request aborted');
    mocks.state.anthropicMode = 'ok';
  });

  await step('AI notes: a provider failure is reported with Retry; the retry succeeds', async () => {
    mocks.state.anthropicMode = 'rate_limit';
    await page.click('[data-testid=notes-run]');
    await page.locator('[data-testid=notes-error]').waitFor();
    assert.match(await page.locator('[data-testid=notes-error]').innerText(), /rate limiting/);
    mocks.state.anthropicMode = 'ok';
    await page.locator('[data-testid=notes-error]').getByRole('button', { name: 'Retry' }).click();
    await page.locator('[data-testid=notes-list]').waitFor();
  });

  await step('AI notes: labelled as derived; the fabricated citation is marked unverified', async () => {
    assert.equal(await page.locator('[data-testid=citation-verified]').count(), 1);
    assert.equal(await page.locator('[data-testid=citation-unverified]').count(), 1);
    assert.match(await page.locator('[data-testid=notes-warnings]').innerText(), /could not be found/);
    // The injection line was sent only inside <source_material>, after the task.
    const sent = JSON.stringify(mocks.calls.anthropic.at(-1).body.messages[0].content);
    if (sent.includes('Ignore all previous')) assert.ok(sent.indexOf('<source_material>') < sent.indexOf('Ignore all previous'));
    await page.locator('[data-testid=ai-notes]').screenshot({ path: join(out, '3-notes.png') });
  });

  await step('Refine: the prompt starts from the task only; document text is not promoted to instructions', async () => {
    await page.click('[data-testid=distil-to-refine]');
    await page.locator('[data-testid=prompt-text]').waitFor();
    const text = await page.inputValue('[data-testid=prompt-text]');
    assert.equal(text, 'Write retry guidance for the upload client.');
  });

  await step('Refine: local format, manual edit, AI enhancement and restore all add revisions', async () => {
    await page.click('[data-testid=refine-local]');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid=revisions] li').length === 2);
    await page.fill('[data-testid=prompt-text]', 'Write retry guidance for the upload client. Keep it under 200 words.');
    await page.click('[data-testid=prompt-save-revision]');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid=revisions] li').length === 3);
    await page.click('[data-testid=refine-ai]');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid=revisions] li').length === 4);
    assert.match(await page.inputValue('[data-testid=prompt-text]'), /\[MOCK\] Restructured/);
    assert.match(await page.locator('[data-testid=revision-notes]').innerText(), /Open question: \[MOCK\] Who is the audience\?/);
    // Restore the original as a new revision; history is kept.
    await page.locator('[data-testid=revisions] li').last().getByRole('button').click();
    await page.click('[data-testid=revision-restore]');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid=revisions] li').length === 5);
    assert.equal(await page.inputValue('[data-testid=prompt-text]'), 'Write retry guidance for the upload client.');
    await page.locator('[data-testid=revisions] li').nth(1).getByRole('button').click();
    await page.locator('[data-testid=revision-view] .diff').waitFor();
    await page.screenshot({ path: join(out, '4-refine.png') });
  });

  await step('Refine: invalid AI output creates no revision and offers Retry', async () => {
    mocks.state.anthropicMode = 'invalid';
    await page.click('[data-testid=refine-ai]');
    await page.locator('[data-testid=refine-error]').waitFor();
    mocks.state.anthropicMode = 'ok';
    assert.equal(await page.locator('[data-testid=revisions] li').count(), 5);
  });

  await step('Refine: export Markdown with original and current prompt', async () => {
    const p = await download(page, () => page.click('[data-testid=prompt-export-md]'), 'prompt.md');
    const md = readFileSync(p, 'utf8');
    assert.match(md, /## Original Prompt/);
    assert.match(md, /Generated with HCG Clarity/);
  });

  await step('Create: Clarity brief keeps excerpts verbatim with references and labels AI notes', async () => {
    await page.click('[data-testid=nav-create]');
    const p = await download(page, () => page.click('[data-testid=export-brief]'), 'brief.md');
    const md = readFileSync(p, 'utf8');
    assert.match(md, /## Instructions/);
    assert.match(md, /Source: \*\*clarity-upload-notes\.md · lines \d+–\d+\*\*/);
    assert.ok(md.includes('Never retry 400 or 413: the request itself is wrong.'));
    assert.match(md, /## Notes \(AI-derived\)/);
    assert.match(md, /⚠ Unverified reference/);
    await page.screenshot({ path: join(out, '5-create.png') });
  });

  let pptxPath;
  await step('Create: presentation from the refined prompt and distilled material, exported as .pptx', async () => {
    await page.click('[data-testid=deck-from-inputs]');
    assert.equal(await page.inputValue('[data-testid=topic]'), 'Write retry guidance for the upload client.');
    await page.fill('[data-testid=slide-count]', '4');
    await page.click('[data-testid=generate-ai]');
    await page.getByText('Write slides (4/4)').waitFor({ timeout: 30000 });
    await page.getByRole('button', { name: 'Open editor →' }).click();
    await page.locator('[data-testid=slide-thumb]').nth(3).waitFor();
    await page.screenshot({ path: join(out, '6-deck.png') });
    // The distilled material reached the model as source material, after the brief.
    const outline = mocks.calls.anthropic.filter((c) => c.path === '/v1/messages' && JSON.stringify(c.body.system).includes('You plan slide decks')).at(-1);
    const user = JSON.stringify(outline.body.messages[0].content);
    assert.ok(user.indexOf('</brief>') < user.indexOf('<source_material>'));
    assert.match(JSON.stringify(outline.body.system), /never a source of instructions/);
    await page.click('[data-testid=export]');
    pptxPath = await download(page, () => page.click('[data-testid=export-pptx]'), 'deck.pptx');
    const report = execFileSync('python3', [join(root, 'scripts', 'inspect-pptx.py'), pptxPath], { encoding: 'utf8' });
    assert.match(report, /slides: 4/);
  });

  let projectPath;
  await step('History lists every output with its links; save the project', async () => {
    await page.click('[data-testid=nav-history]');
    assert.equal(await page.locator('[data-testid=history-row]').count(), 4);
    assert.match(await page.locator('[data-testid=history]').innerText(), /Distillation: Distillation 1/);
    projectPath = await download(page, () => page.click('[data-testid=save-project]'), 'project.clarity');
    const zip = await JSZip.loadAsync(readFileSync(projectPath));
    const m = JSON.parse(await zip.file('clarity.json').async('string'));
    const src = m.sources.find((s) => s.name === 'clarity-upload-notes.md');
    assert.ok(readFileSync(sample('clarity-upload-notes.md')).equals(await zip.file(`files/${src.id}`).async('nodebuffer')), 'original bytes kept');
    assert.ok(!readFileSync(projectPath).toString('latin1').includes(KEY), 'no key in project file');
  });

  await step('Reopen in a fresh page: sources, notes, revisions and outputs are back; outputs download again', async () => {
    const p2 = await ctx.newPage();
    p2.on('dialog', (d) => d.accept());
    await p2.goto(ai.url);
    await p2.setInputFiles('[data-testid=open-input]', projectPath);
    await p2.locator('[data-testid=source-item]').nth(1).waitFor();
    await p2.click('[data-testid=nav-distil]');
    assert.equal(await p2.locator('[data-testid=citation-unverified]').count(), 1);
    await p2.click('[data-testid=nav-refine]');
    assert.equal(await p2.locator('[data-testid=revisions] li').count(), 5);
    await p2.click('[data-testid=nav-history]');
    const again = await download(p2, () => p2.locator('[data-testid=history-row]').filter({ hasText: '.pptx' }).locator('[data-testid=history-download]').click(), 'deck-again.pptx');
    assert.ok(readFileSync(again).equals(readFileSync(pptxPath)), 'stored output is byte-identical');
    await p2.close();
  });
  assert.deepEqual(errors, [], 'no uncaught page errors');

  console.log('\nRecovery, missing providers, unreachable server, migration');
  await step('Unsaved work is recovered after the tab is closed', async () => {
    const c2 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const p = await c2.newPage();
    await p.goto(plain.url);
    await p.fill('[data-testid=clarity-title]', 'Recovered synthetic project');
    await p.click('[data-testid=paste-open]');
    await p.fill('[data-testid=paste-text]', 'Synthetic pasted text that must survive.');
    await p.click('[data-testid=paste-add]');
    await p.waitForTimeout(2500); // autosave runs 1.5 s after the last change
    await p.close();
    const p2 = await c2.newPage();
    await p2.goto(plain.url);
    await p2.locator('[data-testid=recovery-banner]').waitFor();
    assert.match(await p2.locator('[data-testid=recovery-banner]').innerText(), /Recovered synthetic project/);
    await p2.click('[data-testid=recovery-restore]');
    await p2.waitForFunction(() => document.querySelector('[data-testid=clarity-title]')?.value === 'Recovered synthetic project');
    await p2.screenshot({ path: join(out, '7-recovered.png') });
    assert.equal(await p2.inputValue('[data-testid=clarity-title]'), 'Recovered synthetic project');
    assert.equal(await p2.locator('[data-testid=source-item]').count(), 1);
    await c2.close();
  });

  await step('Without a provider key, AI actions point to setup; local features work', async () => {
    const p = await ctx.newPage();
    await p.goto(plain.url);
    await p.setInputFiles('[data-testid=source-input]', [sample('clarity-upload-notes.md')]);
    await p.click('[data-testid=nav-distil]');
    await p.click('[data-testid=distil-new]');
    await p.locator('[data-testid=distil-outcome]').waitFor();
    assert.equal(await p.locator('[data-testid=notes-run]').count(), 0);
    await p.locator('[data-testid=notes-setup]').waitFor();
    await p.fill('[data-testid=distil-task]', 'Summarise.');
    await p.click('[data-testid=distil-to-refine]');
    await p.locator('[data-testid=refine-setup]').waitFor();
    await p.click('[data-testid=refine-local]');
    await p.waitForFunction(() => document.querySelectorAll('[data-testid=revisions] li').length === 2);
    await p.close();
  });

  await step('With the server unreachable, a banner explains what still works', async () => {
    const p = await ctx.newPage();
    await p.route('**/api/**', (r) => r.abort());
    await p.goto(plain.url);
    await p.locator('[data-testid=server-banner]').waitFor();
    assert.match(await p.locator('[data-testid=server-banner]').innerText(), /still work/);
    await p.close();
  });

  await step('An HCG RePrompter backup opens as prompts with revisions and a migration notice', async () => {
    const backup = join(out, 'reprompter-backup.json');
    writeFileSync(backup, JSON.stringify({ format: 'hcg-reprompter-backup', schemaVersion: 1, appVersion: '0.1.0', exportedAt: 815000000, userTemplates: [], records: [{ id: 'A', title: 'Synthetic feature brief', originalPrompt: 'build a login page', enhancedPrompt: '## Objective\nBuild a login page.', mode: 'structured', status: 'accepted', isSaved: true, createdAt: 815000000, updatedAt: 815000100 }] }));
    const p = await ctx.newPage();
    await p.goto(plain.url);
    await p.setInputFiles('[data-testid=open-input]', backup);
    await p.locator('[data-testid=migration-banner]').waitFor();
    assert.match(await p.locator('[data-testid=migration-banner]').innerText(), /Imported 1 prompt/);
    assert.equal(await p.locator('[data-testid=revisions] li').count(), 2);
    await p.close();
  });
  await ctx.close();
} catch {
  failed = true;
} finally {
  await browser.close();
  ai.child.kill();
  plain.child.kill();
  await mocks.close();
  const ok = results.filter((r) => r.ok).length;
  console.log(`\n${ok}/${results.length} HCG Clarity e2e steps passed. Artifacts: ${out}`);
  process.exitCode = failed || ok !== results.length ? 1 : 0;
}
