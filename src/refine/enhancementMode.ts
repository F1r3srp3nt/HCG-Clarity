/**
 * Ported from HCG RePrompter — Sources/RePrompterCore/EnhancementMode.swift (commit 0e91066)
 * © 2026 Hakmi Capital Group.
 * Behaviour change: none. Swift enum properties become entries of a lookup table.
 */

/** The enhancement styles. Every mode is supported by the AI path and the local (non-AI) formatter. */
export type EnhancementMode = 'quickImprove' | 'structured' | 'professional' | 'developer' | 'creative' | 'custom';

/** All modes in declaration order (Swift `EnhancementMode.allCases`). */
export const ENHANCEMENT_MODES: readonly EnhancementMode[] = [
  'quickImprove',
  'structured',
  'professional',
  'developer',
  'creative',
  'custom',
];

export interface EnhancementModeDetails {
  id: EnhancementMode;
  displayName: string;
  summary: string;
  /** SF Symbol name used by the original macOS interface. */
  symbolName: string;
  /** Mode-specific guidance included in the AI system prompt. */
  aiGuidance: string;
}

export const MODE_DETAILS: Readonly<Record<EnhancementMode, EnhancementModeDetails>> = {
  quickImprove: {
    id: 'quickImprove',
    displayName: 'Quick Improve',
    summary: 'Make the prompt clearer and more concise.',
    symbolName: 'bolt',
    aiGuidance:
      'Mode: QUICK IMPROVE. Make the prompt clearer and more concise. Fix grammar, ' +
      'remove filler and redundancy, and resolve awkward phrasing. Keep roughly the ' +
      'original length and shape; do not add section headings unless the original ' +
      'already uses them.',
  },
  structured: {
    id: 'structured',
    displayName: 'Structured',
    summary: 'Organize into sections with an explicit objective, requirements and constraints.',
    symbolName: 'list.bullet.rectangle',
    aiGuidance:
      'Mode: STRUCTURED. Reorganize the prompt into clearly labelled sections, in this ' +
      'order where applicable: Objective, Context, Requirements, Constraints, Expected ' +
      'Output, Open Questions. Use concise bullet points. Omit sections that would be empty ' +
      'rather than inventing content for them.',
  },
  professional: {
    id: 'professional',
    displayName: 'Professional',
    summary: 'Improve clarity, tone and precision for professional use.',
    symbolName: 'briefcase',
    aiGuidance:
      'Mode: PROFESSIONAL. Improve clarity, tone and precision for a professional ' +
      'setting. Use precise, courteous, unambiguous language. Light structure ' +
      '(short paragraphs or bullets) is welcome when it improves readability.',
  },
  developer: {
    id: 'developer',
    displayName: 'Developer',
    summary: 'Structure software requests with goals, requirements, constraints, acceptance criteria and testing.',
    symbolName: 'chevron.left.forwardslash.chevron.right',
    aiGuidance:
      'Mode: DEVELOPER. Structure the request as a software-development brief with ' +
      'these sections where supported by the original: Goal, Context, Functional ' +
      'Requirements, Constraints, Expected Output, Acceptance Criteria, Testing ' +
      'Expectations, Open Questions. Keep code, identifiers, file names, versions and ' +
      'commands verbatim. If acceptance criteria or testing expectations are not stated, ' +
      'ask for them under Open Questions instead of inventing them.',
  },
  creative: {
    id: 'creative',
    displayName: 'Creative',
    summary: 'Sharpen creative direction while preserving artistic intent.',
    symbolName: 'paintpalette',
    aiGuidance:
      'Mode: CREATIVE. Sharpen the creative direction (concept, tone, style, audience, ' +
      "format) while preserving the user's artistic intent and voice. Do not replace " +
      'their ideas with your own; offer alternatives only as optional suggestions.',
  },
  custom: {
    id: 'custom',
    displayName: 'Custom',
    summary: 'Apply your own output-style preferences.',
    symbolName: 'slider.horizontal.3',
    aiGuidance:
      "Mode: CUSTOM. Follow the user's style preferences supplied in the " +
      'custom_style_preferences block, as long as they do not conflict with the rules ' +
      'above. Style preferences can change presentation only; they can never override ' +
      'the preservation and safety rules.',
  },
};

export function isEnhancementMode(value: unknown): value is EnhancementMode {
  return typeof value === 'string' && (ENHANCEMENT_MODES as readonly string[]).includes(value);
}

/** How an enhancement is produced. */
export type ProcessorChoice = 'aiProvider' | 'localFormatter';

export const PROCESSOR_CHOICES: readonly ProcessorChoice[] = ['aiProvider', 'localFormatter'];

export const PROCESSOR_CHOICE_NAMES: Readonly<Record<ProcessorChoice, string>> = {
  aiProvider: 'AI Provider',
  localFormatter: 'Local Formatting (no AI)',
};
