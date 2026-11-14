// Ported from The Last Sprint — distil/Tests/TokenLabCoreTests/SessionAndEvaluationTests.swift (SecretScannerTests, commit 03cc61d)
// testFindingsNameLocationButNotValue scans a draft instead of a SampleProject document (not ported).

import { describe, expect, it } from 'vitest';
import { SecretScanner, SelectionEngine, makeBlock, makeDraft } from '../../src/distil';
import { bytes1, settings } from './helpers';

// Fake values assembled at runtime so no credential-shaped literal exists in the source.
const fakeKey = 'sk-' + 'x'.repeat(24);
const fakeAccessID = 'AKIA' + 'Q'.repeat(16);
const fakePEM = '-----BEGIN ' + 'PRIVATE KEY-----';

describe('SecretScannerTests', () => {
  it('testDetectsCredentialShapes', () => {
    expect(SecretScanner.kinds(`token: ${fakeKey}`).length).toBe(1);
    expect(SecretScanner.kinds(fakeAccessID).length).toBe(1);
    expect(SecretScanner.kinds(fakePEM).length).toBe(1);
    expect(SecretScanner.kinds('An ordinary sentence about skiing and sk-ills.')).toEqual([]);
  });

  it('testFindingsNameLocationButNotValue (draft scan)', () => {
    const clean = makeDraft({ instructions: 'Be kind.', blocks: [makeBlock({ title: 'Tone guide', text: 'Short sentences.' })] });
    expect(SecretScanner.scanDraft(clean)).toEqual([]);
    const draft = makeDraft({
      instructions: 'Be kind.',
      blocks: [makeBlock({ title: 'Tone guide', text: `Short sentences.\n${fakeKey}` })],
    });
    const findings = SecretScanner.scanDraft(draft);
    expect(findings.length).toBe(1);
    expect(findings[0].location.includes('Tone guide')).toBe(true);
    expect(findings[0].location.includes(fakeKey) || findings[0].kind.includes(fakeKey)).toBe(false);
    const report = SelectionEngine.run(draft, settings('baseline'), bytes1);
    expect(SecretScanner.scanReport(report)).toEqual([{ location: 'prompt text', kind: '“sk-” style API key' }]);
  });

  // Port-specific: ICU's \b treats letters such as "é" as word characters; JS \b does not. The port emulates ICU.
  it('word boundaries are Unicode-aware like ICU', () => {
    expect(SecretScanner.kinds(`é${fakeKey}`)).toEqual([]);
    expect(SecretScanner.kinds(`(${fakeKey})`).length).toBe(1);
    expect(SecretScanner.kinds(`${fakeAccessID}é`)).toEqual([]);
    expect(SecretScanner.kinds('Authorization:  Bearer ' + 'a'.repeat(24))).toEqual(['bearer authorization header']);
  });
});
