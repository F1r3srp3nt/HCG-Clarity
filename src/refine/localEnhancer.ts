/**
 * Ported from HCG RePrompter — Sources/RePrompterCore/LocalEnhancer.swift (commit 0e91066)
 * © 2026 Hakmi Capital Group.
 * Behaviour change: the result `id`/`createdAt` can be passed in (Swift always used `UUID()`/`Date()`).
 */
import { EnhancementResponseValidator } from './enhancementContract';
import type { EnhancementRequest, EnhancementResult, ResultIdentity } from './enhancementModels';
import { LOCAL_FORMATTER, makeUUID } from './enhancementModels';
import type { InputLimits } from './inputValidation';
import { InputValidator, STANDARD_INPUT_LIMITS } from './inputValidation';
import { LocalFormatter } from './localFormatter';
import { PreservationChecker } from './preservationChecker';

/**
 * Produces an `EnhancementResult` with the deterministic local formatter. Results
 * are always labelled `localFormatter` so the interface never presents them as AI output.
 */
export const LocalEnhancer = {
  /** Throws `InputValidationError`. */
  enhance(
    request: EnhancementRequest,
    limits: InputLimits = STANDARD_INPUT_LIMITS,
    identity: ResultIdentity = {},
  ): EnhancementResult {
    const validated = InputValidator.validate(request, limits);
    const output = LocalFormatter.format(validated);
    const preservation = PreservationChecker.check(validated.originalPrompt, output.text);
    const warnings = [
      ...output.warnings,
      ...PreservationChecker.warnings(preservation),
      ...EnhancementResponseValidator.qualityWarnings(validated.originalPrompt, output.text),
    ];
    return {
      id: identity.id ?? makeUUID(),
      enhancedPrompt: output.text,
      report: output.report,
      processor: LOCAL_FORMATTER,
      mode: validated.mode,
      preservation,
      warnings,
      createdAt: identity.createdAt ?? new Date(),
    };
  },
};
