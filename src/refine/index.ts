/**
 * Public API of the prompt-refinement library, ported from HCG RePrompter (commit 0e91066).
 * RePrompter is © 2026 Hakmi Capital Group.
 * Pure TypeScript: no network, Node or DOM APIs.
 */
export type { EnhancementMode, EnhancementModeDetails, ProcessorChoice } from './enhancementMode';
export {
  ENHANCEMENT_MODES,
  MODE_DETAILS,
  PROCESSOR_CHOICES,
  PROCESSOR_CHOICE_NAMES,
  isEnhancementMode,
} from './enhancementMode';

export type {
  EnhancementReport,
  EnhancementRequest,
  EnhancementResult,
  ProcessorKind,
  ResultIdentity,
  ValidationWarning,
  ValidationWarningKind,
} from './enhancementModels';
export {
  LOCAL_FORMATTER,
  decodeProcessorKind,
  encodeProcessorKind,
  makeEnhancementReport,
  makeUUID,
  processorIsAI,
  processorLabel,
  warningId,
} from './enhancementModels';

export { TextSanitizer } from './textSanitizer';

export type { PromptUnit, PromptUnitKind } from './textSegmentation';
export { TextSegmenter, Tokenizer, characterCount } from './textSegmentation';

export type { InputLimits, InputValidationReason } from './inputValidation';
export {
  InputValidationError,
  InputValidator,
  STANDARD_INPUT_LIMITS,
  describeInputValidation,
  makeInputLimits,
} from './inputValidation';

export type { DiffResult, DiffSegment, DiffSegmentKind, DiffSummary } from './textDiff';
export { TextDiff } from './textDiff';

export type {
  AnchorStatus,
  PreservationAnchor,
  PreservationAnchorKind,
  PreservationReport,
} from './preservationChecker';
export {
  EMPTY_PRESERVATION_REPORT,
  PRESERVATION_ANCHOR_KINDS,
  PreservationChecker,
  makePreservationReport,
} from './preservationChecker';

export type { Ambiguity, ClassifiedUnit, PromptAnalysis, PromptDomain, UnitRole } from './promptAnalyzer';
export { PROMPT_DOMAINS, PromptAnalyzer, analysisTexts, makeClassifiedUnit, makePromptAnalysis } from './promptAnalyzer';

export type { LocalFormatterOutput } from './localFormatter';
export { LocalFormatter } from './localFormatter';
export { LocalEnhancer } from './localEnhancer';

export type { ContractPrompt, ContractViolation, JSONValue, ValidatedResponse } from './enhancementContract';
export {
  CONTRACT_PRODUCT_NAME,
  ContractViolationError,
  EnhancementContract,
  EnhancementResponseValidator,
  describeContractViolation,
} from './enhancementContract';

export type {
  BuildEnhancementRequestOptions,
  BuiltEnhancementRequest,
  EnhancementErrorReason,
  MessageLike,
  ParseEnhancementResponseOptions,
  ProviderErrorReason,
  ProviderResponse,
} from './providers';
export {
  ANTHROPIC_PROVIDER_ID,
  ANTHROPIC_PROVIDER_NAME,
  DEFAULT_MAX_OUTPUT_TOKENS,
  MAX_OUTPUT_TOKEN_RANGE,
  EnhancementError,
  ProviderError,
  buildEnhancementRequest,
  describeEnhancementError,
  describeProviderError,
  enhanceLocally,
  enhancementErrorCanRetry,
  parseEnhancementResponse,
  parseProviderMessage,
  providerErrorIsRetryable,
} from './providers';

export type { PromptTemplate, TemplateCategory } from './promptTemplate';
export {
  BuiltInTemplates,
  TEMPLATE_CATEGORIES,
  TEMPLATE_CATEGORY_DETAILS,
  TemplateRenderer,
  makePromptTemplate,
  templatePlaceholders,
} from './promptTemplate';

export type { ExportDocument, ExportFormat } from './promptExporter';
export {
  EXPORT_APPLICATION_NAME,
  EXPORT_APPLICATION_VERSION,
  EXPORT_FORMATS,
  EXPORT_FORMAT_DETAILS,
  PromptExporter,
  encodeExportDocument,
  iso8601,
  makeExportDocument,
  parseExportDocument,
} from './promptExporter';
