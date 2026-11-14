// Ported from HCG RePrompter — Tests/RePrompterTests/ProviderTests.swift (commit 0e91066)
// © 2026 Hakmi Capital Group.
// Only request-building, response-parsing, contract and error-taxonomy tests are ported; HTTP,
// retry, cancellation, configuration and credential tests have no counterpart here.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  EnhancementContract,
  EnhancementError,
  MODE_DETAILS,
  ProviderError,
  buildEnhancementRequest,
  enhanceLocally,
  enhancementErrorCanRetry,
  parseEnhancementResponse,
  parseProviderMessage,
  processorIsAI,
  providerErrorIsRetryable,
} from '../../src/refine';
import type { EnhancementErrorReason, EnhancementRequest, ProviderErrorReason } from '../../src/refine';
import { contractJSON } from './fixtures';

const validContractJSON = contractJSON();

/** `ProviderFixtures.messageBody` — an Anthropic Messages API response with a thinking block. */
function messageBody(text: string, stop = 'end_turn', model = 'claude-opus-5-5') {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model,
    content: [
      { type: 'thinking', thinking: '' },
      { type: 'text', text },
    ],
    stop_reason: stop,
    usage: { input_tokens: 10, output_tokens: 20 },
  };
}

function providerReason(fn: () => unknown): ProviderErrorReason {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderError);
    return (error as ProviderError).reason;
  }
  throw new Error('Expected a ProviderError');
}

function enhancementReason(fn: () => unknown): EnhancementErrorReason {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(EnhancementError);
    return (error as EnhancementError).reason;
  }
  throw new Error('Expected an EnhancementError');
}

// MARK: - Anthropic adapter (pure parts)

describe('Anthropic provider', () => {
  it('buildsDocumentedMessagesRequest (pure request content)', () => {
    const built = buildEnhancementRequest({ originalPrompt: 'write haiku about 5 cats', mode: 'quickImprove' }, { boundary: 'abc123' });
    expect(built.maxTokens).toBe(16_000);
    expect(DEFAULT_MAX_OUTPUT_TOKENS).toBe(16_000);
    expect(built.responseSchema.additionalProperties).toBe(false);
    expect(built.responseSchema).toEqual(EnhancementContract.responseSchema);
    expect(built.user).toBe(
      'Rewrite the prompt below using Quick Improve mode.\n\n<original_prompt_abc123>\nwrite haiku about 5 cats\n</original_prompt_abc123>',
    );
    expect(built.system).toContain(MODE_DETAILS.quickImprove.aiGuidance);
    expect(built.system).toContain('HCG Clarity');
    expect(built.boundary).toBe('abc123');
    expect(buildEnhancementRequest(built.request, { maxTokens: 2048 }).maxTokens).toBe(2048);
  });

  it('build sanitizes input and fences custom instructions', () => {
    const built = buildEnhancementRequest(
      { originalPrompt: 'Do X\u202E\r\n', mode: 'custom', customInstructions: '  Be terse  ' },
      { boundary: 'b0' },
    );
    expect(built.request).toEqual({ originalPrompt: 'Do X\n', mode: 'custom', customInstructions: 'Be terse' });
    expect(built.user).toContain('<custom_style_preferences_b0>\nBe terse\n</custom_style_preferences_b0>\n\n<original_prompt_b0>');
  });

  it('parsesTextBlocksAndSkipsThinking', () => {
    const response = parseProviderMessage(messageBody('{"a":1}', 'end_turn', 'claude-sonnet-5-5'));
    expect(response.text).toBe('{"a":1}');
    expect(response.model).toBe('claude-sonnet-5-5');
  });

  it('refusalAndTruncationAreErrors', () => {
    const refusal = '{"model":"m","content":[],"stop_reason":"refusal","stop_details":{"type":"refusal","category":"cyber"}}';
    expect(providerReason(() => parseProviderMessage(refusal))).toEqual({ kind: 'refused', category: 'cyber' });
    const truncated = messageBody('{"enhanced', 'max_tokens');
    expect(providerReason(() => parseProviderMessage(truncated))).toEqual({ kind: 'truncated' });
  });

  it.each(['not json', '{"content": 5}', '{"content": []}'])('malformedBodiesAreErrors(%j)', (body) => {
    expect(providerReason(() => parseProviderMessage(body)).kind).toBe('malformedResponse');
  });
});

// MARK: - Enhancement service (pure parts)

describe('Enhancement service', () => {
  const request: EnhancementRequest = { originalPrompt: 'write haiku about 5 cats', mode: 'quickImprove' };

  it('aiEnhancementProducesValidatedResult', () => {
    const built = buildEnhancementRequest(request);
    const result = parseEnhancementResponse(validContractJSON, built.request, {
      providerID: 'mock',
      providerName: 'Mock AI',
      model: 'mock-model-1',
    });
    expect(result.processor).toEqual({ kind: 'ai', providerID: 'mock', providerName: 'Mock AI', model: 'mock-model-1' });
    expect(result.enhancedPrompt.startsWith('Rewritten')).toBe(true);
    expect(result.report.structuralChanges).toEqual(['Clarified']);
    expect(result.mode).toBe('quickImprove');
  });

  it('parses a full Messages response and takes the model from it', () => {
    const result = parseEnhancementResponse(messageBody(validContractJSON), request);
    expect(result.processor).toEqual({
      kind: 'ai',
      providerID: 'anthropic',
      providerName: 'Anthropic Claude',
      model: 'claude-opus-5-5',
    });
  });

  it('refusal and truncation surface as provider EnhancementErrors', () => {
    const refusal = { model: 'm', content: [], stop_reason: 'refusal', stop_details: { category: null } };
    const refused = enhancementReason(() => parseEnhancementResponse(refusal, request));
    expect(refused).toEqual({ kind: 'provider', error: { kind: 'refused', category: null } });
    expect(enhancementErrorCanRetry(refused)).toBe(false);
    const truncated = enhancementReason(() => parseEnhancementResponse(messageBody('{"enh', 'max_tokens'), request));
    expect(truncated).toEqual({ kind: 'provider', error: { kind: 'truncated' } });
    expect(enhancementErrorCanRetry(truncated)).toBe(true);
  });

  it('localFormatterWorksWithoutProviderAndIsLabelled', () => {
    const result = enhanceLocally(request);
    expect(result.processor).toEqual({ kind: 'localFormatter' });
    expect(processorIsAI(result.processor)).toBe(false);
  });

  it('emptyInputNeverReachesProvider', () => {
    expect(enhancementReason(() => buildEnhancementRequest({ originalPrompt: '  ', mode: 'structured' }))).toEqual({
      kind: 'input',
      error: { kind: 'emptyPrompt' },
    });
    expect(enhancementReason(() => enhanceLocally({ originalPrompt: '  ', mode: 'structured' }))).toEqual({
      kind: 'input',
      error: { kind: 'emptyPrompt' },
    });
  });

  // The retry loop is not ported; this checks the taxonomy that drives it.
  it.each<ProviderErrorReason>([
    { kind: 'authenticationFailed' },
    { kind: 'badRequest', detail: 'x' },
    { kind: 'refused', category: null },
    { kind: 'truncated' },
    { kind: 'modelNotFound', model: 'm' },
  ])('permanentFailuresAreNotRetried(%j)', (reason) => {
    expect(providerErrorIsRetryable(reason)).toBe(false);
    expect(new ProviderError(reason).isRetryable).toBe(false);
  });

  it('transient failures are retryable', () => {
    for (const reason of [
      { kind: 'overloaded' },
      { kind: 'serverError', status: 500 },
      { kind: 'rateLimited', retryAfter: 4 },
      { kind: 'timeout' },
      { kind: 'network', detail: 'x' },
    ] as ProviderErrorReason[]) {
      expect(providerErrorIsRetryable(reason)).toBe(true);
    }
    expect(new ProviderError({ kind: 'rateLimited', retryAfter: 6.2 }).message).toBe(
      'The provider is rate limiting requests. Try again in 7 seconds.',
    );
  });

  it('malformedProviderOutputIsAContractError', () => {
    let caught: unknown;
    try {
      parseEnhancementResponse('Sure! Here is your improved prompt: ...', request);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EnhancementError);
    const error = caught as EnhancementError;
    expect(error.reason).toEqual({ kind: 'contract', error: { kind: 'notJSON' } });
    expect(error.canRetry).toBe(true);
    expect(error.message).toBe("The provider's response was not valid JSON. Nothing was changed; you can retry.");
  });

  it('missingProviderFailsInsteadOfFakingAI (error taxonomy only)', () => {
    const error = new EnhancementError({ kind: 'provider', error: { kind: 'notConfigured' } });
    expect(error.message).toBe(
      'No AI provider is configured. Add an API key in Settings, or choose Local Formatting (no AI).',
    );
    expect(error.canRetry).toBe(false);
  });
});
