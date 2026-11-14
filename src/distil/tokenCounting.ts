// Ported from The Last Sprint — distil/Sources/TokenLabCore/TokenCounting.swift (commit 03cc61d)
// Behaviour change: only the labelled approximate counter is ported; `resolveCounter` replaces
// StaticCounterResolver (no BPE tokenizers).

import type { CounterChoice } from './models';
import { LabError, bytesPerTokenRange, validateCounterChoice } from './models';
import { utf8Length } from './text';

/**
 * - `approximation`: a heuristic. Never presented as a model's token count.
 * - `modelTokenizer`: a model-family tokenizer applied to plain text only (none is ported).
 */
export type CounterKind = 'approximation' | 'modelTokenizer';

/** Identifies exactly how a count was produced. Stored with every report. */
export interface TokenCounterDescriptor {
  /** Stable identifier, e.g. `approx-utf8-bytes-div-4`. */
  id: string;
  displayName: string;
  kind: CounterKind;
  /** Encoding name, e.g. `utf8-bytes/4`. */
  encoding: string;
  /** Implementation and data version. */
  version: string;
  /** What the count covers and what it excludes. */
  scope: string;
}

/** Short label for metrics. Model tokenizer counts are still not provider usage. */
export function metricLabel(descriptor: TokenCounterDescriptor): string {
  return descriptor.kind === 'approximation'
    ? `estimated (${descriptor.encoding})`
    : `${descriptor.encoding} text tokens`;
}

/** Replaceable token-counting interface. Implementations must be deterministic. */
export interface TokenCounter {
  readonly descriptor: TokenCounterDescriptor;
  count(text: string): number;
  /**
   * Count the text produced by joining `parts` with `separator`. Optional: when absent the parts are
   * joined and counted (Swift protocol-extension default).
   */
  countJoined?(parts: string[], separator: string): number;
}

export function countJoined(counter: TokenCounter, parts: string[], separator: string): number {
  return counter.countJoined ? counter.countJoined(parts, separator) : counter.count(parts.join(separator));
}

/** UTF-8 bytes divided by N, rounded up. Clearly a heuristic. */
export class ApproximateCounter implements TokenCounter {
  static readonly engineVersion = 'approx-1';
  readonly bytesPerToken: number;

  constructor(bytesPerToken = 4) {
    // Swift uses a precondition (crash); here an out-of-range value throws.
    if (
      !Number.isInteger(bytesPerToken) ||
      bytesPerToken < bytesPerTokenRange.min ||
      bytesPerToken > bytesPerTokenRange.max
    ) {
      throw new LabError('invalid', `Approximate counter must use 1–8 bytes per token (found ${bytesPerToken}).`);
    }
    this.bytesPerToken = bytesPerToken;
  }

  get descriptor(): TokenCounterDescriptor {
    return {
      id: `approx-utf8-bytes-div-${this.bytesPerToken}`,
      displayName: `Approximate: UTF-8 bytes ÷ ${this.bytesPerToken}`,
      kind: 'approximation',
      encoding: `utf8-bytes/${this.bytesPerToken}`,
      version: ApproximateCounter.engineVersion,
      scope:
        'Heuristic estimate of prompt text only. Not a model tokenizer; excludes message formatting and provider overhead.',
    };
  }

  count(text: string): number {
    return ApproximateCounter.ceilDiv(utf8Length(text), this.bytesPerToken);
  }

  countJoined(parts: string[], separator: string): number {
    if (parts.length === 0) return 0;
    const bytes = parts.reduce((sum, part) => sum + utf8Length(part), 0) + utf8Length(separator) * (parts.length - 1);
    return ApproximateCounter.ceilDiv(bytes, this.bytesPerToken);
  }

  static ceilDiv(a: number, b: number): number {
    return Math.floor((a + b - 1) / b);
  }
}

/** Resolves a `CounterChoice` to a concrete counter (validates the choice first). */
export function resolveCounter(choice: CounterChoice): TokenCounter {
  validateCounterChoice(choice);
  return new ApproximateCounter(choice.bytesPerToken);
}
