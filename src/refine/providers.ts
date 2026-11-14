/**
 * Ported from HCG RePrompter — Sources/RePrompterProviders/EnhancementService.swift,
 * AnthropicProvider.swift and ProviderTypes.swift (commit 0e91066) © 2026 Hakmi Capital Group.
 * Behaviour change: only the pure parts are ported — request building, Messages-response parsing,
 * contract validation and the error taxonomy. No HTTP transport, retry loop, Keychain, secret
 * redaction or cancellation: the host app calls the Anthropic SDK itself. Swift `ProviderError` /
 * `EnhancementError` enums are unions carried by Error subclasses of the same name.
 */
import type { JSONValue } from './enhancementContract';
import {
  ContractViolationError,
  describeContractViolation,
  EnhancementContract,
  EnhancementResponseValidator,
} from './enhancementContract';
import type { ContractViolation } from './enhancementContract';
import type { EnhancementRequest, EnhancementResult, ResultIdentity } from './enhancementModels';
import { makeUUID } from './enhancementModels';
import type { InputLimits, InputValidationReason } from './inputValidation';
import { describeInputValidation, InputValidationError, InputValidator, STANDARD_INPUT_LIMITS } from './inputValidation';
import { LocalEnhancer } from './localEnhancer';
import { trimSpacesAndNewlines } from './swiftText';

// MARK: Provider identity and defaults (from AnthropicConfiguration)

export const ANTHROPIC_PROVIDER_ID = 'anthropic';
export const ANTHROPIC_PROVIDER_NAME = 'Anthropic Claude';
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_000;
export const MAX_OUTPUT_TOKEN_RANGE = { min: 1_024, max: 32_000 } as const;

// MARK: Provider errors

/** Errors from AI providers (Swift `ProviderError`). Descriptions are user-facing. */
export type ProviderErrorReason =
  | { kind: 'notConfigured' }
  | { kind: 'missingAPIKey' }
  | { kind: 'invalidConfiguration'; detail: string }
  | { kind: 'insecureEndpoint' }
  | { kind: 'authenticationFailed' }
  | { kind: 'permissionDenied'; detail: string }
  | { kind: 'billing'; detail: string }
  | { kind: 'modelNotFound'; model: string }
  | { kind: 'badRequest'; detail: string }
  | { kind: 'requestTooLarge' }
  | { kind: 'rateLimited'; retryAfter: number | null }
  | { kind: 'overloaded' }
  | { kind: 'serverError'; status: number }
  | { kind: 'timeout' }
  | { kind: 'network'; detail: string }
  | { kind: 'refused'; category: string | null }
  | { kind: 'truncated' }
  | { kind: 'malformedResponse'; detail: string }
  | { kind: 'unexpectedStatus'; status: number }
  | { kind: 'credentialStore'; detail: string };

/** Whether repeating the identical request may succeed. */
export function providerErrorIsRetryable(reason: ProviderErrorReason): boolean {
  switch (reason.kind) {
    case 'rateLimited':
    case 'overloaded':
    case 'serverError':
    case 'timeout':
    case 'network':
      return true;
    default:
      return false;
  }
}

export function describeProviderError(reason: ProviderErrorReason): string {
  switch (reason.kind) {
    case 'notConfigured':
      return 'No AI provider is configured. Add an API key in Settings, or choose Local Formatting (no AI).';
    case 'missingAPIKey':
      return 'No API key is stored for this provider. Add one in Settings → AI Provider.';
    case 'invalidConfiguration':
      return `The provider configuration is invalid: ${reason.detail}`;
    case 'insecureEndpoint':
      return 'Provider requests must use HTTPS.';
    case 'authenticationFailed':
      return 'The provider rejected the API key. Check the key in Settings.';
    case 'permissionDenied':
      return `The API key does not have permission for this request. ${reason.detail}`;
    case 'billing':
      return `The provider reported a billing problem. ${reason.detail}`;
    case 'modelNotFound':
      return `The model “${reason.model}” was not found or is not available to this API key.`;
    case 'badRequest':
      return `The provider rejected the request: ${reason.detail}`;
    case 'requestTooLarge':
      return 'The prompt is too large for the provider to accept.';
    case 'rateLimited':
      return reason.retryAfter !== null
        ? `The provider is rate limiting requests. Try again in ${Math.ceil(reason.retryAfter)} seconds.`
        : 'The provider is rate limiting requests. Try again shortly.';
    case 'overloaded':
      return 'The provider is temporarily overloaded. Try again shortly.';
    case 'serverError':
      return `The provider had an internal error (HTTP ${reason.status}). Try again shortly.`;
    case 'timeout':
      return 'The request timed out. Try again, or increase the timeout in Settings.';
    case 'network':
      return `A network error occurred: ${reason.detail}`;
    case 'refused':
      return reason.category !== null
        ? `The provider declined this request (${reason.category}).`
        : 'The provider declined this request.';
    case 'truncated':
      return "The provider's response was cut off before it finished. Increase the output limit in Settings or shorten the prompt.";
    case 'malformedResponse':
      return `The provider returned an unexpected response: ${reason.detail}`;
    case 'unexpectedStatus':
      return `The provider returned an unexpected status (HTTP ${reason.status}).`;
    case 'credentialStore':
      return `The API key could not be read from the Keychain: ${reason.detail}`;
  }
}

export class ProviderError extends Error {
  readonly reason: ProviderErrorReason;
  constructor(reason: ProviderErrorReason) {
    super(describeProviderError(reason));
    this.name = 'ProviderError';
    this.reason = reason;
  }
  get isRetryable(): boolean {
    return providerErrorIsRetryable(this.reason);
  }
}

// MARK: Enhancement errors

/** Unified error for an enhancement attempt (Swift `EnhancementError`). */
export type EnhancementErrorReason =
  | { kind: 'input'; error: InputValidationReason }
  | { kind: 'provider'; error: ProviderErrorReason }
  | { kind: 'contract'; error: ContractViolation }
  | { kind: 'cancelled' };

export function describeEnhancementError(reason: EnhancementErrorReason): string {
  switch (reason.kind) {
    case 'input':
      return describeInputValidation(reason.error);
    case 'provider':
      return describeProviderError(reason.error);
    case 'contract':
      return describeContractViolation(reason.error) + ' Nothing was changed; you can retry.';
    case 'cancelled':
      return 'Enhancement cancelled.';
  }
}

/** Whether offering a "Retry" action makes sense. */
export function enhancementErrorCanRetry(reason: EnhancementErrorReason): boolean {
  switch (reason.kind) {
    case 'input':
      return false;
    case 'provider':
      return (
        providerErrorIsRetryable(reason.error) ||
        reason.error.kind === 'truncated' ||
        reason.error.kind === 'malformedResponse'
      );
    case 'contract':
    case 'cancelled':
      return true;
  }
}

export class EnhancementError extends Error {
  readonly reason: EnhancementErrorReason;
  constructor(reason: EnhancementErrorReason) {
    super(describeEnhancementError(reason));
    this.name = 'EnhancementError';
    this.reason = reason;
  }
  get canRetry(): boolean {
    return enhancementErrorCanRetry(this.reason);
  }
}

// MARK: Request building

/** A provider-neutral request (Swift `ProviderRequest`) plus the defaults the Swift Anthropic adapter used. */
export interface BuiltEnhancementRequest {
  /** The sanitized, validated request. Pass this (not the raw one) to `parseEnhancementResponse`. */
  request: EnhancementRequest;
  /** System prompt. */
  system: string;
  /** The single user message; the original prompt is fenced in `<original_prompt_{boundary}>` tags. */
  user: string;
  /** Random per-request delimiter used in the fence tags. */
  boundary: string;
  /** JSON schema the reply must match (send as structured-output format if the API supports it). */
  responseSchema: { [key: string]: JSONValue };
  /** Output token budget (Swift default 16 000). */
  maxTokens: number;
}

export interface BuildEnhancementRequestOptions {
  limits?: InputLimits;
  /** Fixed boundary (tests); regenerated if it occurs in the prompt or custom instructions. */
  boundary?: string;
  maxTokens?: number;
}

/**
 * Validates the input (throws `EnhancementError` with `kind: 'input'`) and builds the
 * system prompt and user message for an AI enhancement.
 */
export function buildEnhancementRequest(
  request: EnhancementRequest,
  options: BuildEnhancementRequestOptions = {},
): BuiltEnhancementRequest {
  let validated: EnhancementRequest;
  try {
    validated = InputValidator.validate(request, options.limits ?? STANDARD_INPUT_LIMITS);
  } catch (error) {
    if (error instanceof InputValidationError) throw new EnhancementError({ kind: 'input', error: error.reason });
    throw error;
  }
  const prompt =
    options.boundary !== undefined
      ? EnhancementContract.buildPrompt(validated, options.boundary)
      : EnhancementContract.buildPrompt(validated);
  return {
    request: validated,
    system: prompt.system,
    user: prompt.userMessage,
    boundary: prompt.boundary,
    responseSchema: EnhancementContract.responseSchema,
    maxTokens: options.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
  };
}

// MARK: Response parsing

/** The subset of an Anthropic Messages API response that is read (decoded SDK object or raw JSON body). */
export interface MessageLike {
  model?: string | null;
  content?: { type: string; text?: string | null }[] | null;
  stop_reason?: string | null;
  stop_details?: { category?: string | null } | null;
}

/** Swift `ProviderResponse`. */
export interface ProviderResponse {
  /** The model's text output (expected to be JSON per the contract). */
  text: string;
  /** The model that actually produced the response. */
  model: string;
}

const undecodable = (): ProviderError =>
  new ProviderError({ kind: 'malformedResponse', detail: 'The response body could not be decoded.' });

function optionalString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === 'string';
}

/** Mirrors Swift's strict `Decodable` check of `MessageResponse`. */
function decodeMessage(input: unknown): MessageLike {
  let value = input;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      throw undecodable();
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw undecodable();
  const message = value as Record<string, unknown>;
  if (!optionalString(message.model) || !optionalString(message.stop_reason)) throw undecodable();
  const content = message.content;
  if (content !== undefined && content !== null) {
    if (!Array.isArray(content)) throw undecodable();
    for (const block of content) {
      if (block === null || typeof block !== 'object' || Array.isArray(block)) throw undecodable();
      const b = block as Record<string, unknown>;
      if (typeof b.type !== 'string' || !optionalString(b.text)) throw undecodable();
    }
  }
  const details = message.stop_details;
  if (details !== undefined && details !== null) {
    if (typeof details !== 'object' || Array.isArray(details)) throw undecodable();
    if (!optionalString((details as Record<string, unknown>).category)) throw undecodable();
  }
  return message as MessageLike;
}

/**
 * Swift `AnthropicProvider.parseMessage`: turns a Messages API response into text.
 * Throws `ProviderError` for refusal (`stop_reason: "refusal"`), truncation
 * (`"max_tokens"`), an undecodable body or a reply with no text. Thinking blocks are skipped.
 */
export function parseProviderMessage(message: MessageLike | string | unknown): ProviderResponse {
  const decoded = decodeMessage(message);
  switch (decoded.stop_reason) {
    case 'refusal':
      throw new ProviderError({ kind: 'refused', category: decoded.stop_details?.category ?? null });
    case 'max_tokens':
      throw new ProviderError({ kind: 'truncated' });
    default:
      break;
  }
  const text = (decoded.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .filter((t): t is string => typeof t === 'string')
    .join('');
  if (trimSpacesAndNewlines(text) === '') {
    throw new ProviderError({ kind: 'malformedResponse', detail: 'The response contained no text.' });
  }
  return { text, model: decoded.model ?? 'unknown' };
}

export interface ParseEnhancementResponseOptions extends ResultIdentity {
  /** Model name for `processor`; defaults to the message's `model` or "unknown". */
  model?: string;
  providerID?: string;
  providerName?: string;
}

/**
 * Validates a model reply against the contract and builds the `EnhancementResult`.
 *
 * `reply` is either the reply text, or the Messages API response (SDK object or raw JSON body),
 * in which case refusal/truncation are detected first. `request` must be the validated request
 * returned by `buildEnhancementRequest`. Throws `EnhancementError` with `kind: 'provider'`
 * (refused, truncated, malformedResponse) or `kind: 'contract'` (notJSON, missingField,
 * wrongType, emptyEnhancedPrompt, responseTooLarge).
 */
export function parseEnhancementResponse(
  reply: string | MessageLike,
  request: EnhancementRequest,
  options: ParseEnhancementResponseOptions = {},
): EnhancementResult {
  let text: string;
  let model = options.model;
  if (typeof reply === 'string') {
    text = reply;
  } else {
    try {
      const response = parseProviderMessage(reply);
      text = response.text;
      model = model ?? response.model;
    } catch (error) {
      if (error instanceof ProviderError) throw new EnhancementError({ kind: 'provider', error: error.reason });
      throw error;
    }
  }

  let validated;
  try {
    validated = EnhancementResponseValidator.validate(text, request);
  } catch (error) {
    if (error instanceof ContractViolationError) throw new EnhancementError({ kind: 'contract', error: error.violation });
    throw error;
  }
  return {
    id: options.id ?? makeUUID(),
    enhancedPrompt: validated.enhancedPrompt,
    report: validated.report,
    processor: {
      kind: 'ai',
      providerID: options.providerID ?? ANTHROPIC_PROVIDER_ID,
      providerName: options.providerName ?? ANTHROPIC_PROVIDER_NAME,
      model: model ?? 'unknown',
    },
    mode: request.mode,
    preservation: validated.preservation,
    warnings: validated.warnings,
    createdAt: options.createdAt ?? new Date(),
  };
}

/**
 * `EnhancementService.enhance(_:processor: .localFormatter)`: local formatting with input
 * errors wrapped as `EnhancementError` (`kind: 'input'`).
 */
export function enhanceLocally(
  request: EnhancementRequest,
  limits: InputLimits = STANDARD_INPUT_LIMITS,
  identity: ResultIdentity = {},
): EnhancementResult {
  try {
    return LocalEnhancer.enhance(InputValidator.validate(request, limits), limits, identity);
  } catch (error) {
    if (error instanceof InputValidationError) throw new EnhancementError({ kind: 'input', error: error.reason });
    throw error;
  }
}
