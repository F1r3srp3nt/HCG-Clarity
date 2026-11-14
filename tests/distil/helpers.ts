// Shared helpers for the Distil tests (ported from SelectionEngineTests.swift top-level helpers, commit 03cc61d).

import type { SelectionSettings, SelectionStrategy } from '../../src/distil';
import { ApproximateCounter, makeSettings } from '../../src/distil';

/** UTF-8 byte-level containment. JS strings compare by code unit, which is already byte-exact for valid text. */
export function bytesContain(haystack: string, needle: string): boolean {
  return haystack.includes(needle);
}

export function settings(strategy: SelectionStrategy, budget = 1000, dedupe = false, bytesPerToken = 1): SelectionSettings {
  return makeSettings({ strategy, budget, deduplicateBeforeBudget: dedupe, counter: { kind: 'approximate', bytesPerToken } });
}

export const bytes1 = new ApproximateCounter(1);

export function utf8(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}
