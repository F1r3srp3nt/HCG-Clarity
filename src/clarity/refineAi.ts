/**
 * Refine with AI: the HCG RePrompter enhancement contract (src/refine, ported unchanged) run
 * through HCG Clarity's server. The server builds the request with the contract and returns the
 * model's raw structured output; the browser validates it with the same contract before a new
 * revision is created, so a malformed or contract-breaking reply never reaches the project.
 */
import { z } from 'zod';
import { buildEnhancementRequest, ENHANCEMENT_MODES, EnhancementContract, type EnhancementMode } from '../refine';

export const RefineRequestSchema = z.object({
  prompt: z.string().max(400_000),
  mode: z.enum(ENHANCEMENT_MODES as [EnhancementMode, ...EnhancementMode[]]),
  customInstructions: z.string().max(20_000).optional(),
});
export type RefineRequest = z.infer<typeof RefineRequestSchema>;

/** Structured-output schema; the same fields as EnhancementContract.responseSchema. */
export const RefineOutputSchema = z.object({
  enhanced_prompt: z.string(),
  objective: z.string(),
  intended_output: z.string(),
  explicit_requirements: z.array(z.string()),
  constraints: z.array(z.string()),
  structural_changes: z.array(z.string()),
  optional_suggestions: z.array(z.string()),
  missing_information: z.array(z.string()),
  assumptions: z.array(z.string()),
  ambiguities: z.array(z.string()),
});

// Keep the schema above in step with the ported contract.
const contractFields = [...EnhancementContract.stringFields, ...EnhancementContract.listFields].sort().join(',');
if (Object.keys(RefineOutputSchema.shape).sort().join(',') !== contractFields) {
  throw new Error('RefineOutputSchema does not match the RePrompter enhancement contract.');
}

/** Validates input (throws EnhancementError kind "input") and builds the contract's messages. */
export function buildRefineCall(req: RefineRequest): { system: string; user: string } {
  const built = buildEnhancementRequest({ originalPrompt: req.prompt, mode: req.mode, customInstructions: req.customInstructions });
  return { system: built.system, user: built.user };
}
