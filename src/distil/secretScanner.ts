// Ported from The Last Sprint — distil/Sources/TokenLabCore/SecretScanner.swift (commit 03cc61d)
// Behaviour change: ICU regexes are rewritten for ECMAScript (Unicode-aware \b emulated with lookarounds);
// `scan(ProjectDocument)` is replaced by `scanDraft` (workspace instructions and blocks only).

import type { Draft } from './models';
import type { SelectionReport } from './selectionEngine';
import { compareSwiftStrings } from './text';

/** Findings name the location and the kind of pattern only; the matched value is never echoed. */
export interface SecretFinding {
  location: string;
  kind: string;
}

// ICU's default \w (used by \b without UREGEX_UWORD): Alphabetic, Mark, Decimal_Number, Connector_Punctuation, ZWNJ, ZWJ.
const W = '[\\p{Alphabetic}\\p{M}\\p{Nd}\\p{Pc}\\u200C\\u200D]';
const B_BEFORE = `(?<!${W})`; // \b before a word character
const B_AFTER = `(?!${W})`; // \b after a word character
const ICU_SPACE = '[\\t\\n\\f\\r\\p{Z}]'; // ICU \s

const patterns: { kind: string; regex: RegExp }[] = [
  { kind: 'private key block', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u },
  { kind: '“sk-” style API key', regex: new RegExp(`${B_BEFORE}sk-[A-Za-z0-9_\\-]{20,}`, 'u') },
  { kind: 'cloud access key ID', regex: new RegExp(`${B_BEFORE}AKIA[0-9A-Z]{16}${B_AFTER}`, 'u') },
  { kind: 'source-hosting access token', regex: new RegExp(`${B_BEFORE}gh[pousr]_[A-Za-z0-9]{30,}`, 'u') },
  { kind: 'chat workspace token', regex: new RegExp(`${B_BEFORE}xox[abprs]-[A-Za-z0-9-]{10,}`, 'u') },
  { kind: '“AIza” style API key', regex: new RegExp(`${B_BEFORE}AIza[0-9A-Za-z_\\-]{35}`, 'u') },
  {
    kind: 'bearer authorization header',
    regex: new RegExp(`authorization:${ICU_SPACE}*bearer${ICU_SPACE}+[A-Za-z0-9._\\-]{20,}`, 'iu'),
  },
];

/** Warns before sharing text that appears to contain credentials. */
export const SecretScanner = {
  /** Kinds of credential-looking patterns found in `text`, in a fixed order. */
  kinds(text: string): string[] {
    if (text.length === 0) return [];
    return patterns.filter((p) => p.regex.test(text)).map((p) => p.kind);
  },

  /** Instructions and every workspace block (the Swift document scan, minus library and experiments). */
  scanDraft(draft: Draft): SecretFinding[] {
    const findings: SecretFinding[] = [];
    const check = (text: string, location: string): void => {
      for (const kind of SecretScanner.kinds(text)) findings.push({ location, kind });
    };
    check(draft.instructions, 'Workspace instructions');
    for (const block of draft.blocks) check(block.text, `Workspace block “${block.title}”`);
    const unique = new Map<string, SecretFinding>();
    for (const f of findings) unique.set(`${f.location}\u0000${f.kind}`, f);
    return [...unique.values()].sort(
      (a, b) => compareSwiftStrings(a.location, b.location) || compareSwiftStrings(a.kind, b.kind),
    );
  },

  /** The original prompt contains every non-empty block, so it covers the selected prompt too. */
  scanReport(report: SelectionReport): SecretFinding[] {
    return SecretScanner.kinds(report.originalPrompt).map((kind) => ({ location: 'prompt text', kind }));
  },
};
