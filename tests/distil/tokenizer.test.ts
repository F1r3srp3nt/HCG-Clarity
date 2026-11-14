// Ported from The Last Sprint — distil/Tests/TokenLabCoreTests/TokenizerTests.swift (commit 03cc61d)
// Approximate-counter tests only; BPE, SHA-256 and provider tests are not ported.

import { describe, expect, it } from 'vitest';
import { ApproximateCounter, LabError, metricLabel, resolveCounter } from '../../src/distil';

describe('TokenizerTests (approximate counter)', () => {
  it('testApproximateCounterRoundsUpUTF8Bytes', () => {
    const c = new ApproximateCounter(4);
    expect(c.count('')).toBe(0);
    expect(c.count('abcd')).toBe(1);
    expect(c.count('abcde')).toBe(2);
    expect(c.count('ø')).toBe(1); // 2 bytes
    expect(new ApproximateCounter(1).count('ø')).toBe(2);
    expect(c.descriptor.kind).toBe('approximation');
    expect(c.descriptor.scope.includes('Not a model tokenizer')).toBe(true);
  });

  it('testApproximateFastPathMatchesJoinedCount', () => {
    const parts = ['Instructions', 'Block with ünïcödé', 'x', 'last\n'];
    for (let n = 1; n <= 8; n++) {
      const c = new ApproximateCounter(n);
      expect(c.countJoined(parts, '\n\n'), `bytesPerToken ${n}`).toBe(c.count(parts.join('\n\n')));
    }
    expect(new ApproximateCounter().countJoined([], '\n\n')).toBe(0);
  });

  // Port-specific: UTF-8 length, not UTF-16 length, drives the estimate.
  it('counts UTF-8 bytes of astral characters and labels the estimate', () => {
    const c = new ApproximateCounter(1);
    expect(c.count('😀')).toBe(4);
    expect(c.count('é')).toBe(3);
    expect(c.descriptor.id).toBe('approx-utf8-bytes-div-1');
    expect(metricLabel(new ApproximateCounter().descriptor)).toBe('estimated (utf8-bytes/4)');
  });

  // Replaces testResolverRequiresLoadedEncoding (BPE is not ported): out-of-range choices are rejected.
  it('resolver validates the approximate choice', () => {
    expect(resolveCounter({ kind: 'approximate', bytesPerToken: 3 }).descriptor.encoding).toBe('utf8-bytes/3');
    expect(() => resolveCounter({ kind: 'approximate', bytesPerToken: 0 })).toThrow(LabError);
    expect(() => new ApproximateCounter(9)).toThrow(LabError);
  });
});
