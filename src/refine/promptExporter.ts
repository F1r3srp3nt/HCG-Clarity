/**
 * Ported from HCG RePrompter — Sources/RePrompterCore/PromptExporter.swift (commit 0e91066)
 * © 2026 Hakmi Capital Group.
 * Behaviour change: exports name "HCG Clarity 0.1.0" instead of "HCG RePrompter 0.1.0"; `export`
 * returns a string (UTF-8 text) instead of `Data`; JSON is `JSON.stringify` with sorted keys and
 * 2-space indent (Swift writes `"key" : value` and escapes `/` as `\/`; same keys and values).
 */
import type { EnhancementMode } from './enhancementMode';
import { isEnhancementMode, MODE_DETAILS } from './enhancementMode';
import type { EnhancementReport, ProcessorKind } from './enhancementModels';
import { decodeProcessorKind, encodeProcessorKind, makeEnhancementReport, processorLabel } from './enhancementModels';
import { prefix, trimSpaces } from './swiftText';

/** Product name and version written into exports (replaces Swift `AppInfo.name`/`AppInfo.version`). */
export const EXPORT_APPLICATION_NAME = 'HCG Clarity';
export const EXPORT_APPLICATION_VERSION = '0.1.0';

/** Export formats for a prompt and its enhancement. */
export type ExportFormat = 'plainText' | 'markdown' | 'json';

export const EXPORT_FORMATS: readonly ExportFormat[] = ['plainText', 'markdown', 'json'];

export const EXPORT_FORMAT_DETAILS: Readonly<Record<ExportFormat, { displayName: string; fileExtension: string }>> = {
  plainText: { displayName: 'Plain Text (.txt)', fileExtension: 'txt' },
  markdown: { displayName: 'Markdown (.md)', fileExtension: 'md' },
  json: { displayName: 'JSON (.json)', fileExtension: 'json' },
};

/** The data needed to export a prompt. */
export interface ExportDocument {
  title: string;
  originalPrompt: string;
  enhancedPrompt: string | null;
  mode: EnhancementMode | null;
  processor: ProcessorKind | null;
  report: EnhancementReport | null;
  exportedAt: Date;
  application: string;
}

export function makeExportDocument(fields: {
  title: string;
  originalPrompt: string;
  enhancedPrompt?: string | null;
  mode?: EnhancementMode | null;
  processor?: ProcessorKind | null;
  report?: EnhancementReport | null;
  /** Defaults to now, like the Swift initializer. */
  exportedAt?: Date;
}): ExportDocument {
  return {
    title: fields.title,
    originalPrompt: fields.originalPrompt,
    enhancedPrompt: fields.enhancedPrompt ?? null,
    mode: fields.mode ?? null,
    processor: fields.processor ?? null,
    report: fields.report ?? null,
    exportedAt: fields.exportedAt ?? new Date(),
    application: `${EXPORT_APPLICATION_NAME} ${EXPORT_APPLICATION_VERSION}`,
  };
}

/** ISO 8601 in UTC without fractional seconds, like `ISO8601DateFormatter` and `.iso8601` encoding. */
export function iso8601(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Wraps text in a code fence long enough not to collide with fences inside it. */
function fenced(text: string): string {
  let fence = '```';
  while (text.includes(fence)) fence += '`';
  return fence + 'text\n' + text + '\n' + fence;
}

function markdown(document: ExportDocument): string {
  const lines: string[] = [`# ${document.title}`, ''];
  const meta: string[] = [];
  if (document.mode !== null) meta.push(`Mode: ${MODE_DETAILS[document.mode].displayName}`);
  if (document.processor !== null) meta.push(`Processed by: ${processorLabel(document.processor)}`);
  meta.push(`Exported: ${iso8601(document.exportedAt)}`);
  lines.push('_' + meta.join(' · ') + '_');
  lines.push('');
  if (document.enhancedPrompt !== null) {
    lines.push('## Enhanced Prompt', '', fenced(document.enhancedPrompt), '');
  }
  lines.push('## Original Prompt', '', fenced(document.originalPrompt), '');
  const report = document.report;
  if (report !== null) {
    const section = (title: string, items: string[]): void => {
      if (items.length === 0) return;
      lines.push(`## ${title}`);
      lines.push('');
      lines.push(...items.map((item) => '- ' + item));
      lines.push('');
    };
    section('Changes', report.structuralChanges);
    section('Requirements', report.explicitRequirements);
    section('Constraints', report.constraints);
    section('Optional Suggestions', report.optionalSuggestions);
    section('Open Questions', report.missingInformation);
    section('Assumptions', report.assumptions);
  }
  lines.push('---');
  lines.push(`Generated with ${EXPORT_APPLICATION_NAME} ${EXPORT_APPLICATION_VERSION}`);
  return lines.join('\n') + '\n';
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) sorted[key] = sortKeys(record[key]);
    return sorted;
  }
  return value;
}

/** The Swift Codable form of an `ExportDocument` (nil optionals omitted, dates as ISO 8601). */
export function encodeExportDocument(document: ExportDocument): Record<string, unknown> {
  const encoded: Record<string, unknown> = {
    application: document.application,
    exportedAt: iso8601(document.exportedAt),
    originalPrompt: document.originalPrompt,
    title: document.title,
  };
  if (document.enhancedPrompt !== null) encoded.enhancedPrompt = document.enhancedPrompt;
  if (document.mode !== null) encoded.mode = document.mode;
  if (document.processor !== null) encoded.processor = encodeProcessorKind(document.processor);
  if (document.report !== null) encoded.report = { ...document.report };
  return encoded;
}

function stringList(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new TypeError(`Invalid “${key}” in exported report.`);
  }
  return value as string[];
}

/** Parses JSON produced by the JSON export (or by RePrompter itself) back into an `ExportDocument`. */
export function parseExportDocument(json: string): ExportDocument {
  const value = JSON.parse(json) as unknown;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected a JSON object.');
  const record = value as Record<string, unknown>;
  const requireString = (key: string): string => {
    const field = record[key];
    if (typeof field !== 'string') throw new TypeError(`Missing or invalid “${key}”.`);
    return field;
  };
  const optional = (key: string): unknown => (record[key] === undefined || record[key] === null ? null : record[key]);

  const exportedAt = new Date(requireString('exportedAt'));
  if (Number.isNaN(exportedAt.getTime())) throw new TypeError('Invalid “exportedAt”.');

  const enhancedPrompt = optional('enhancedPrompt');
  if (enhancedPrompt !== null && typeof enhancedPrompt !== 'string') throw new TypeError('Invalid “enhancedPrompt”.');
  const mode = optional('mode');
  if (mode !== null && !isEnhancementMode(mode)) throw new TypeError('Invalid “mode”.');
  const processor = optional('processor');
  const report = optional('report');
  let decodedReport: EnhancementReport | null = null;
  if (report !== null) {
    if (typeof report !== 'object' || Array.isArray(report)) throw new TypeError('Invalid “report”.');
    const r = report as Record<string, unknown>;
    const text = (key: string): string => {
      if (typeof r[key] !== 'string') throw new TypeError(`Invalid “${key}” in exported report.`);
      return r[key] as string;
    };
    decodedReport = makeEnhancementReport({
      objective: text('objective'),
      explicitRequirements: stringList(r.explicitRequirements, 'explicitRequirements'),
      constraints: stringList(r.constraints, 'constraints'),
      intendedOutput: text('intendedOutput'),
      structuralChanges: stringList(r.structuralChanges, 'structuralChanges'),
      optionalSuggestions: stringList(r.optionalSuggestions, 'optionalSuggestions'),
      missingInformation: stringList(r.missingInformation, 'missingInformation'),
      assumptions: stringList(r.assumptions, 'assumptions'),
      ambiguities: stringList(r.ambiguities, 'ambiguities'),
    });
  }
  return {
    title: requireString('title'),
    originalPrompt: requireString('originalPrompt'),
    enhancedPrompt: enhancedPrompt as string | null,
    mode: mode as EnhancementMode | null,
    processor: processor === null ? null : decodeProcessorKind(processor),
    report: decodedReport,
    exportedAt,
    application: requireString('application'),
  };
}

/** Characters Swift's `suggestedFileName` replaces: / \ : * ? " < > |, control/format characters and newlines. */
const FORBIDDEN_FILE_NAME_CHARACTERS = /[/\\:*?"<>|\p{Cc}\p{Cf}\u0085\u2028\u2029]/gu;

export const PromptExporter = {
  /** Returns the exported file contents as text (encode as UTF-8 to write). */
  export(document: ExportDocument, format: ExportFormat): string {
    switch (format) {
      case 'plainText':
        return document.enhancedPrompt ?? document.originalPrompt;
      case 'markdown':
        return markdown(document);
      case 'json':
        return JSON.stringify(sortKeys(encodeExportDocument(document)), null, 2);
    }
  },

  markdown,
  fenced,

  /** A filesystem-safe file name derived from a title. */
  suggestedFileName(title: string, format: ExportFormat): string {
    let base = trimSpaces(title.replace(FORBIDDEN_FILE_NAME_CHARACTERS, '-'));
    while (base.startsWith('.')) base = base.slice(1);
    if (base === '') base = 'Prompt';
    return prefix(base, 80) + '.' + EXPORT_FORMAT_DETAILS[format].fileExtension;
  },
};
