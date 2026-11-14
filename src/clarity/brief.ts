/**
 * The Clarity brief: one Markdown document with the refined instructions, the distilled excerpts
 * (verbatim, each with its source reference), AI notes (labelled as derived, with verified and
 * unverified references shown as such) and a source list with checksums.
 */
import type { SelectionReport } from '../distil';
import { excerptRef, type ClarityProject, type Distillation, type PromptDoc, type Revision } from './model';
import { keptExcerpts } from './distil';

export interface BriefInputs {
  project: ClarityProject;
  prompt: PromptDoc | null;
  revision: Revision | null;
  distillation: Distillation | null;
  report: SelectionReport | null;
  generatedAt: Date;
}

/** A fence longer than any backtick run in the text, so excerpts are reproduced exactly. */
function fence(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  const f = '`'.repeat(longest + 1);
  return `${f}text\n${text}\n${f}`;
}

export function buildClarityBrief(i: BriefInputs): string {
  const out: string[] = [];
  out.push(`# ${i.prompt?.title || i.project.title}`, '');
  out.push(`_HCG Clarity brief · project “${i.project.title}” · generated ${i.generatedAt.toISOString()}_`, '');
  out.push('> Sections marked **Verbatim** are exact text from your sources. Sections marked **AI-derived** were written by a model and must be checked against the cited excerpts.', '');

  if (i.revision) {
    out.push('## Instructions', '');
    out.push(`_Revision: ${i.revision.kind}, ${i.revision.createdAt}_`, '');
    out.push(fence(i.revision.text), '');
  }

  const used = new Set<string>();
  if (i.distillation && i.report) {
    const kept = keptExcerpts(i.distillation, i.report);
    out.push(`## Distilled excerpts (Verbatim) — ${kept.length} of ${i.distillation.excerpts.length}`, '');
    out.push(`_${i.distillation.title}: ${i.report.keptCount} kept, ${i.report.selectedTokens} of ${i.report.originalTokens} estimated tokens._`, '');
    for (const e of kept) {
      used.add(e.sourceId);
      out.push(`### ${e.title}`, '', `Source: **${excerptRef(e)}**`, '', fence(e.text), '');
    }
    const ai = i.distillation.aiNotes;
    if (ai && ai.notes.length) {
      const byId = new Map(i.distillation.excerpts.map((e) => [e.id, e]));
      out.push('## Notes (AI-derived)', '', `_Written by ${ai.model} on ${ai.createdAt}. Check each note against its references._`, '');
      for (const n of ai.notes) {
        out.push(`- **${n.heading}** — ${n.text}`);
        if (!n.citations.length) out.push('  - ⚠ No source reference: treat as unsupported.');
        for (const c of n.citations) {
          const e = byId.get(c.excerptId);
          const where = e ? excerptRef(e) : `unknown excerpt ${c.excerptId}`;
          out.push(`  - ${c.verified ? 'Reference' : '⚠ Unverified reference'}: ${where} — “${c.quote.replace(/\s+/g, ' ')}”`);
        }
      }
      out.push('');
      if (ai.gaps.length) {
        out.push('### Gaps reported', '', ...ai.gaps.map((g) => `- ${g}`), '');
      }
    }
  }

  const sources = i.project.sources.filter((s) => used.has(s.id));
  if (sources.length) {
    out.push('## Sources', '', '| Source | Type | SHA-256 |', '|---|---|---|');
    for (const s of sources) {
      const type = s.extraction ? `${s.mime} — text extracted with ${s.extraction.method}` : s.mime;
      out.push(`| ${s.name.replace(/\|/g, '\\|')} | ${type} | \`${s.sha256}\` |`);
    }
    if (sources.some((s) => s.extraction)) out.push('', '_Line numbers of PDF and Word sources refer to the extracted text; page numbers refer to the PDF. The checksum is of the original file._');
    out.push('');
  }
  out.push('---', 'Generated with HCG Clarity');
  return out.join('\n') + '\n';
}
