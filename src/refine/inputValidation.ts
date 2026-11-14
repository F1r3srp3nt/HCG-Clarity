/**
 * Ported from HCG RePrompter — Sources/RePrompterCore/InputValidation.swift (commit 0e91066)
 * © 2026 Hakmi Capital Group.
 * Behaviour change: the Swift error enum is `InputValidationError` (an Error subclass) carrying
 * an `InputValidationReason` union; numbers are formatted en-US style ("100,000").
 */
import type { EnhancementRequest } from './enhancementModels';
import { count, formatInteger, trimSpacesAndNewlines } from './swiftText';
import { TextSanitizer } from './textSanitizer';

/** Limits applied to user input before any processing. */
export interface InputLimits {
  /** Maximum characters in an original prompt. */
  maxPromptCharacters: number;
  /** Maximum characters in custom-mode instructions. */
  maxCustomInstructionCharacters: number;
}

export const STANDARD_INPUT_LIMITS: Readonly<InputLimits> = Object.freeze({
  maxPromptCharacters: 100_000,
  maxCustomInstructionCharacters: 4_000,
});

export function makeInputLimits(fields: Partial<InputLimits> = {}): InputLimits {
  return { ...STANDARD_INPUT_LIMITS, ...fields };
}

export type InputValidationReason =
  | { kind: 'emptyPrompt' }
  | { kind: 'promptTooLong'; characters: number; limit: number }
  | { kind: 'missingCustomInstructions' }
  | { kind: 'customInstructionsTooLong'; characters: number; limit: number };

export function describeInputValidation(reason: InputValidationReason): string {
  switch (reason.kind) {
    case 'emptyPrompt':
      return 'Enter a prompt to enhance.';
    case 'promptTooLong':
      return `The prompt is ${formatInteger(reason.characters)} characters; the limit is ${formatInteger(reason.limit)}.`;
    case 'missingCustomInstructions':
      return 'Custom mode needs style instructions. Describe how you want the prompt rewritten.';
    case 'customInstructionsTooLong':
      return `Custom instructions are ${formatInteger(reason.characters)} characters; the limit is ${formatInteger(reason.limit)}.`;
  }
}

export class InputValidationError extends Error {
  readonly reason: InputValidationReason;
  constructor(reason: InputValidationReason) {
    super(describeInputValidation(reason));
    this.name = 'InputValidationError';
    this.reason = reason;
  }
}

export const InputValidator = {
  /** Validates and normalizes a request. Returns a sanitized copy. Throws `InputValidationError`. */
  validate(request: EnhancementRequest, limits: InputLimits = STANDARD_INPUT_LIMITS): EnhancementRequest {
    const prompt = TextSanitizer.sanitize(request.originalPrompt);
    if (trimSpacesAndNewlines(prompt) === '') {
      throw new InputValidationError({ kind: 'emptyPrompt' });
    }
    const promptCount = count(prompt);
    if (promptCount > limits.maxPromptCharacters) {
      throw new InputValidationError({ kind: 'promptTooLong', characters: promptCount, limit: limits.maxPromptCharacters });
    }

    let custom: string | undefined;
    if (request.mode === 'custom') {
      const instructions = trimSpacesAndNewlines(TextSanitizer.sanitize(request.customInstructions ?? ''));
      if (instructions === '') throw new InputValidationError({ kind: 'missingCustomInstructions' });
      const instructionCount = count(instructions);
      if (instructionCount > limits.maxCustomInstructionCharacters) {
        throw new InputValidationError({
          kind: 'customInstructionsTooLong',
          characters: instructionCount,
          limit: limits.maxCustomInstructionCharacters,
        });
      }
      custom = instructions;
    }
    const result: EnhancementRequest = { originalPrompt: prompt, mode: request.mode };
    if (custom !== undefined) result.customInstructions = custom;
    return result;
  },
};
