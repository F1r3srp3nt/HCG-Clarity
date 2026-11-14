/**
 * Ported from HCG RePrompter — Sources/RePrompterCore/EnhancementModels.swift (commit 0e91066)
 * © 2026 Hakmi Capital Group.
 * Behaviour change: `ProcessorKind` is a discriminated union (`kind: 'ai' | 'localFormatter'`);
 * its Swift Codable form is produced by `encodeProcessorKind`/`decodeProcessorKind`.
 */
import type { EnhancementMode } from './enhancementMode';
import type { PreservationReport } from './preservationChecker';

/** A user's request to enhance a prompt. */
export interface EnhancementRequest {
  originalPrompt: string;
  mode: EnhancementMode;
  /** Only used by `custom` mode. */
  customInstructions?: string;
}

/** Structured explanation of what an enhancement did (JSON keys match the Swift Codable form). */
export interface EnhancementReport {
  objective: string;
  explicitRequirements: string[];
  constraints: string[];
  intendedOutput: string;
  structuralChanges: string[];
  optionalSuggestions: string[];
  missingInformation: string[];
  assumptions: string[];
  ambiguities: string[];
}

export function makeEnhancementReport(fields: Partial<EnhancementReport> = {}): EnhancementReport {
  return {
    objective: fields.objective ?? '',
    explicitRequirements: fields.explicitRequirements ?? [],
    constraints: fields.constraints ?? [],
    intendedOutput: fields.intendedOutput ?? '',
    structuralChanges: fields.structuralChanges ?? [],
    optionalSuggestions: fields.optionalSuggestions ?? [],
    missingInformation: fields.missingInformation ?? [],
    assumptions: fields.assumptions ?? [],
    ambiguities: fields.ambiguities ?? [],
  };
}

/** Identifies what produced an enhancement. */
export type ProcessorKind =
  | { kind: 'ai'; providerID: string; providerName: string; model: string }
  | { kind: 'localFormatter' };

export const LOCAL_FORMATTER: ProcessorKind = { kind: 'localFormatter' };

export function processorIsAI(processor: ProcessorKind): boolean {
  return processor.kind === 'ai';
}

export function processorLabel(processor: ProcessorKind): string {
  return processor.kind === 'ai' ? `${processor.providerName} · ${processor.model}` : 'Local formatting (no AI)';
}

/** Swift synthesized Codable form: `{"ai":{"providerID":…,"providerName":…,"model":…}}` or `{"localFormatter":{}}`. */
export function encodeProcessorKind(processor: ProcessorKind): Record<string, Record<string, string>> {
  if (processor.kind === 'ai') {
    return { ai: { model: processor.model, providerID: processor.providerID, providerName: processor.providerName } };
  }
  return { localFormatter: {} };
}

export function decodeProcessorKind(value: unknown): ProcessorKind {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 1 && keys[0] === 'localFormatter') return { kind: 'localFormatter' };
    if (keys.length === 1 && keys[0] === 'ai') {
      const ai = record.ai as Record<string, unknown> | null;
      if (ai && typeof ai.providerID === 'string' && typeof ai.providerName === 'string' && typeof ai.model === 'string') {
        return { kind: 'ai', providerID: ai.providerID, providerName: ai.providerName, model: ai.model };
      }
    }
  }
  throw new TypeError('Invalid processor value.');
}

export type ValidationWarningKind =
  | 'possiblyDroppedContent'
  | 'possiblyDroppedConstraint'
  | 'unchanged'
  | 'lengthChange'
  | 'customInstructionsIgnored'
  | 'truncatedReport'
  | 'providerNote';

/** A non-fatal issue discovered while validating an enhancement. */
export interface ValidationWarning {
  kind: ValidationWarningKind;
  message: string;
}

/** Swift `ValidationWarning.id`. */
export function warningId(warning: ValidationWarning): string {
  return warning.kind + ':' + warning.message;
}

/** The complete, validated output of an enhancement. */
export interface EnhancementResult {
  id: string;
  enhancedPrompt: string;
  report: EnhancementReport;
  processor: ProcessorKind;
  mode: EnhancementMode;
  preservation: PreservationReport;
  warnings: ValidationWarning[];
  createdAt: Date;
}

/** Options for the identity fields Swift fills with `UUID()` and `Date()` defaults. */
export interface ResultIdentity {
  id?: string;
  createdAt?: Date;
}

/** An uppercase UUID string like Swift's `UUID().uuidString`. */
export function makeUUID(): string {
  const cryptoLike = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoLike && typeof cryptoLike.randomUUID === 'function') return cryptoLike.randomUUID().toUpperCase();
  const hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16));
  hex[12] = '4';
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`.toUpperCase();
}
