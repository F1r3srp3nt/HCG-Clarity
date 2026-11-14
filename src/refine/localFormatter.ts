/**
 * Ported from HCG RePrompter — Sources/RePrompterCore/LocalFormatter.swift (commit 0e91066)
 * © 2026 Hakmi Capital Group.
 * Behaviour change: none intended.
 */
import type { EnhancementReport, EnhancementRequest, ValidationWarning } from './enhancementModels';
import { PreservationChecker } from './preservationChecker';
import type { ClassifiedUnit, PromptAnalysis, UnitRole } from './promptAnalyzer';
import { PromptAnalyzer } from './promptAnalyzer';
import {
  characters,
  dropFirst,
  isLetter,
  isLowercase,
  isNumber,
  replaceAll,
  trimCharacters,
  trimSpaces,
} from './swiftText';
import { TextSanitizer } from './textSanitizer';
import { TextSegmenter, Tokenizer } from './textSegmentation';

export interface LocalFormatterOutput {
  text: string;
  report: EnhancementReport;
  warnings: ValidationWarning[];
}

// MARK: Change tracking

class ChangeLog {
  entries: string[] = [];
  private counters = new Map<string, number>();

  note(entry: string): void {
    if (!this.entries.includes(entry)) this.entries.push(entry);
  }

  count(key: string): void {
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  flushCounters(): void {
    const sorted = [...this.counters.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [key, value] of sorted) {
      if (value > 0) this.note(replaceAll(key, '#', String(value)));
    }
    this.counters = new Map();
  }
}

// MARK: Sentence clean-up

const fillerOpeners = [
  'hey there,', 'hi there,', 'hey,', 'hi,', 'hello,', 'ok so', 'okay so', 'so,', 'um,', 'uh,',
  'basically,', 'i was wondering if you could', 'i was wondering if you can', 'could you please',
  'can you please', 'would you please',
];
const casualReplacements: [string, string][] = [
  ['w/o', 'without'], ['w/', 'with'], ['b/c', 'because'], ['pls', 'please'], ['plz', 'please'],
  ['thx', 'thanks'], ['idk', "I don't know"],
  ['dont', "don't"], ['doesnt', "doesn't"], ['didnt', "didn't"], ['isnt', "isn't"], ['arent', "aren't"],
  ['wasnt', "wasn't"], ['werent', "weren't"], ['cant', "can't"], ['couldnt', "couldn't"],
  ['shouldnt', "shouldn't"], ['wouldnt', "wouldn't"], ['havent', "haven't"], ['hasnt', "hasn't"],
  ['im', "I'm"], ['ive', "I've"], ['youre', "you're"], ['theyre', "they're"], ['thats', "that's"],
];
const professionalReplacements: [string, string][] = [
  ['gonna', 'going to'], ['wanna', 'want to'], ['gotta', 'need to'], ['kinda', 'somewhat'],
  ['sorta', 'somewhat'], ['yeah', 'yes'], ['nope', 'no'], ['ok', 'OK'], ['asap', 'as soon as possible'],
  ['lots of', 'many'], ['a bunch of', 'several'],
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanSentenceWithLog(sentence: string, professional: boolean, changes: ChangeLog): string {
  let text = sentence.split(/[ \t]/).filter((part) => part !== '').join(' ');
  if (text !== trimSpaces(sentence)) changes.note('Normalized spacing.');

  // Spaces before punctuation.
  for (const mark of [',', '.', ';', ':', '!', '?']) {
    if (text.includes(' ' + mark + ' ') || text.endsWith(' ' + mark)) {
      text = replaceAll(text, ' ' + mark, mark);
      changes.note('Fixed spacing around punctuation.');
    }
  }

  // Filler openers.
  const lower = text.toLowerCase();
  for (const filler of fillerOpeners) {
    if (!lower.startsWith(filler)) continue;
    const remainder = trimSpaces(dropFirst(text, characters(filler).length));
    if (Tokenizer.words(remainder).length >= 2) {
      text = remainder;
      changes.note(`Removed conversational filler (“${trimCharacters(filler, ',')}”).`);
    }
    break;
  }

  // Word-level replacements.
  const words = text.split(' ');
  const replacements = professional ? casualReplacements.concat(professionalReplacements) : casualReplacements;
  let index = 0;
  while (index < words.length) {
    const word = words[index];
    const core = Tokenizer.trimPunctuation(word);
    const lowerCore = core.toLowerCase();
    // Standalone pronoun "i".
    if (core === 'i') {
      words[index] = replaceAll(word, 'i', 'I');
      changes.count('Capitalized the pronoun “I” (#×).');
    } else if (core === lowerCore) {
      const replacement = replacements.find(([from]) => from === lowerCore && !from.includes(' '));
      if (replacement) {
        // Only replace exact lowercase tokens so identifiers like `R` or `OK` stay intact.
        words[index] = replaceAll(word, core, replacement[1]);
        changes.note(`Expanded “${replacement[0]}” to “${replacement[1]}”.`);
      }
    }
    // Doubled words ("the the").
    if (index > 0) {
      const coreChars = characters(lowerCore);
      const previous = words[index - 1];
      const previousChars = characters(previous);
      if (
        coreChars.length > 1 &&
        coreChars.every(isLetter) &&
        lowerCore !== 'that' &&
        lowerCore !== 'had' &&
        Tokenizer.trimPunctuation(previous).toLowerCase() === lowerCore &&
        previousChars.length > 0 &&
        isLetter(previousChars[previousChars.length - 1])
      ) {
        words.splice(index, 1);
        changes.note(`Removed a repeated word (“${core}”).`);
        continue;
      }
    }
    index += 1;
  }
  text = words.join(' ');

  if (professional) {
    for (const [phrase, replacement] of professionalReplacements) {
      if (!phrase.includes(' ')) continue;
      const pattern = new RegExp(escapeRegExp(phrase), 'iu');
      if (pattern.test(text)) {
        text = text.replace(pattern, () => replacement);
        changes.note(`Replaced informal phrasing (“${phrase}” → “${replacement}”).`);
      }
    }
  }

  // Capitalize sentence start when the first word is plain lowercase prose.
  const firstWord = text.split(' ').find((part) => part !== '');
  if (
    firstWord !== undefined &&
    characters(firstWord).every((c) => isLetter(c) && isLowercase(c)) &&
    Tokenizer.words(text).length >= 2
  ) {
    const chars = characters(text);
    if (chars.length > 0) {
      text = chars[0].toUpperCase() + chars.slice(1).join('');
      changes.count('Capitalized the start of # sentence(s).');
    }
  }

  // Terminal punctuation for complete sentences.
  const chars = characters(text);
  const last = chars[chars.length - 1];
  if (last !== undefined && (isLetter(last) || isNumber(last) || last === ')') && Tokenizer.words(text).length >= 2) {
    const first = Tokenizer.words(text)[0] ?? '';
    const isQuestion = PromptAnalyzer.questionStarters.has(first) && !PromptAnalyzer.imperativeVerbs.has(first);
    text += isQuestion ? '?' : '.';
    changes.count('Added closing punctuation to # sentence(s).');
  }
  return text;
}

/** Cleans a single sentence without changing its meaning. */
function cleanSentence(sentence: string): string {
  return cleanSentenceWithLog(sentence, false, new ChangeLog());
}

/** Exact duplicate sentences are removed (they add nothing). Returns false when the sentence was a duplicate. */
function appendIfNew(sentence: string, seen: Set<string>, changes: ChangeLog): boolean {
  const key = characters(sentence.toLowerCase())
    .filter((c) => isLetter(c) || isNumber(c))
    .join('');
  if (key === '') return true;
  if (seen.has(key)) {
    changes.note(`Removed a duplicated sentence (“${PreservationChecker.truncate(sentence, 60)}”).`);
    return false;
  }
  seen.add(key);
  return true;
}

// MARK: Quick Improve

function quickImprove(original: string, changes: ChangeLog): string {
  const units = TextSegmenter.segment(TextSanitizer.sanitize(original));
  const output: string[] = [];
  let currentParagraph = -1;
  let paragraphSentences: string[] = [];
  const seenSentences = new Set<string>();
  let lastListParagraph = -1;

  const flushParagraph = (): void => {
    if (paragraphSentences.length > 0) {
      output.push(paragraphSentences.join(' '));
      paragraphSentences = [];
    }
  };

  for (const unit of units) {
    if (unit.paragraph !== currentParagraph) {
      flushParagraph();
      currentParagraph = unit.paragraph;
    }
    switch (unit.kind) {
      case 'codeBlock':
        flushParagraph();
        output.push(unit.text);
        break;
      case 'heading':
        flushParagraph();
        output.push('## ' + unit.text);
        break;
      case 'listItem': {
        flushParagraph();
        const cleaned = cleanSentenceWithLog(unit.text, false, changes);
        if (appendIfNew(cleaned, seenSentences, changes)) {
          // Keep list items grouped within the paragraph.
          const last = output[output.length - 1];
          if (last !== undefined && last.startsWith('- ') && lastListParagraph === unit.paragraph) {
            output[output.length - 1] = last + '\n- ' + cleaned;
          } else {
            output.push('- ' + cleaned);
          }
          lastListParagraph = unit.paragraph;
        }
        break;
      }
      case 'sentence': {
        lastListParagraph = -1;
        const cleaned = cleanSentenceWithLog(unit.text, false, changes);
        if (appendIfNew(cleaned, seenSentences, changes)) paragraphSentences.push(cleaned);
        break;
      }
    }
  }
  flushParagraph();
  changes.flushCounters();
  return output.join('\n\n');
}

// MARK: Sectioned layouts

type SectionStyle = 'bullets' | 'numbered' | 'checklist' | 'paragraph' | 'verbatim';

interface Section {
  title: string;
  items: string[];
  style: SectionStyle;
}

function section(title: string, items: string[], style: SectionStyle = 'bullets'): Section {
  return { title, items, style };
}

function render(sections: Section[], headingPrefix = '## '): string {
  return sections
    .filter((s) => s.items.length > 0)
    .map((s) => {
      let body: string;
      switch (s.style) {
        case 'bullets':
          body = s.items.map((item) => '- ' + item).join('\n');
          break;
        case 'numbered':
          body = s.items.map((item, offset) => `${offset + 1}. ` + item).join('\n');
          break;
        case 'checklist':
          body = s.items.map((item) => '- [ ] ' + item).join('\n');
          break;
        case 'paragraph':
          body = s.items.join(' ');
          break;
        case 'verbatim':
          body = s.items.join('\n\n');
          break;
      }
      return headingPrefix + s.title + '\n' + body;
    })
    .join('\n\n');
}

/** Cleans and de-duplicates the texts for a role. */
function cleaned(
  analysis: PromptAnalysis,
  roles: readonly UnitRole[],
  seen: Set<string>,
  changes: ChangeLog,
  options: { where?: (unit: ClassifiedUnit) => boolean; professional?: boolean } = {},
): string[] {
  const predicate = options.where ?? (() => true);
  const professional = options.professional ?? false;
  const result: string[] = [];
  for (const unit of analysis.units) {
    if (!roles.includes(unit.role) || unit.unit.kind === 'codeBlock' || unit.unit.kind === 'heading' || !predicate(unit)) {
      continue;
    }
    const text = cleanSentenceWithLog(unit.unit.text, professional, changes);
    if (appendIfNew(text, seen, changes)) result.push(text);
  }
  return result;
}

function headings(analysis: PromptAnalysis): string[] {
  return analysis.units.filter((unit) => unit.unit.kind === 'heading').map((unit) => unit.unit.text);
}

const OPEN_QUESTIONS = 'Open Questions (answer if you can, otherwise state your assumptions)';

function noteSections(sections: Section[], changes: ChangeLog): void {
  const titles = sections
    .filter((s) => s.items.length > 0)
    .map((s) => s.title.split(' (')[0]);
  if (titles.length > 0) {
    changes.note(`Organized the prompt into sections: ${titles.join(', ')}.`);
  }
  if (sections.some((s) => s.title.startsWith('Open Questions') && s.items.length > 0)) {
    changes.note('Added open questions for information the prompt does not provide (questions only — no new requirements).');
  }
}

function structured(analysis: PromptAnalysis, changes: ChangeLog): string {
  const seen = new Set<string>();
  const objective = cleaned(analysis, ['objective'], seen, changes);
  const context = cleaned(analysis, ['context'], seen, changes);
  const requirements = cleaned(analysis, ['requirement'], seen, changes);
  const constraints = cleaned(analysis, ['constraint'], seen, changes);
  const output = cleaned(analysis, ['output'], seen, changes);
  const headingNotes = headings(analysis);

  const sections = [
    section('Objective', objective, 'paragraph'),
    section('Context', headingNotes.map((h) => `Topic: ${h}`).concat(context)),
    section('Requirements', requirements),
    section('Constraints', constraints),
    section('Expected Output', output),
    section('Reference Material', analysis.codeBlocks, 'verbatim'),
    section(OPEN_QUESTIONS, analysis.missingInformation),
  ];
  noteSections(sections, changes);
  changes.flushCounters();
  return render(sections);
}

function professionalLayout(analysis: PromptAnalysis, changes: ChangeLog): string {
  const seen = new Set<string>();
  const opts = { professional: true };
  const objective = cleaned(analysis, ['objective'], seen, changes, opts);
  const context = cleaned(analysis, ['context'], seen, changes, opts);
  const details = cleaned(analysis, ['requirement', 'constraint'], seen, changes, opts);
  const output = cleaned(analysis, ['output'], seen, changes, opts);

  const parts: string[] = [];
  const opening = objective.concat(context).join(' ');
  if (opening !== '') parts.push(opening);
  const headingNotes = headings(analysis);
  if (headingNotes.length > 0) parts.push('Topic: ' + headingNotes.join('; '));
  if (details.length > 0) {
    parts.push('Please observe the following:\n' + details.map((d) => '- ' + d).join('\n'));
    changes.note('Grouped requirements and constraints into a single list.');
  }
  if (output.length > 0) {
    parts.push('Deliverable: ' + output.join(' '));
    changes.note('Stated the deliverable separately.');
  }
  parts.push(...analysis.codeBlocks);
  changes.flushCounters();
  return parts.join('\n\n');
}

function developer(analysis: PromptAnalysis, changes: ChangeLog): string {
  const seen = new Set<string>();
  const mentions = (unit: ClassifiedUnit, terms: string[]): boolean => {
    const lower = ' ' + unit.unit.text.toLowerCase() + ' ';
    return terms.some((term) => lower.includes(term));
  };
  const testing = (unit: ClassifiedUnit): boolean =>
    mentions(unit, [' test', 'testing', ' qa ', 'coverage', 'xctest', 'pytest', 'jest']);
  const acceptance = (unit: ClassifiedUnit): boolean =>
    mentions(unit, ['acceptance', 'criteria', 'done when', 'definition of done', 'should pass', 'must pass']);
  const allRoles: UnitRole[] = ['requirement', 'constraint', 'output', 'context'];

  const goal = cleaned(analysis, ['objective'], seen, changes);
  const acceptanceItems = cleaned(analysis, allRoles, seen, changes, { where: acceptance });
  const testingItems = cleaned(analysis, allRoles, seen, changes, { where: testing });
  const context = cleaned(analysis, ['context'], seen, changes);
  const requirements = cleaned(analysis, ['requirement'], seen, changes);
  const constraints = cleaned(analysis, ['constraint'], seen, changes);
  const output = cleaned(analysis, ['output'], seen, changes);

  const sections = [
    section('Goal', goal, 'paragraph'),
    section('Context', headings(analysis).map((h) => `Topic: ${h}`).concat(context)),
    section('Functional Requirements', requirements, 'numbered'),
    section('Constraints', constraints),
    section('Expected Output', output),
    section('Acceptance Criteria', acceptanceItems, 'checklist'),
    section('Testing Expectations', testingItems),
    section('Reference Material', analysis.codeBlocks, 'verbatim'),
    section(OPEN_QUESTIONS, analysis.missingInformation),
  ];
  noteSections(sections, changes);
  changes.flushCounters();
  return render(sections);
}

function creative(analysis: PromptAnalysis, changes: ChangeLog): string {
  const seen = new Set<string>();
  const styleTerms = PromptAnalyzer.toneTerms.concat([
    'inspired', 'like ', 'reminiscent', 'aesthetic', 'vibe', 'palette', 'colour', 'color', 'atmosphere',
  ]);
  const isStyle = (unit: ClassifiedUnit): boolean => {
    const lower = ' ' + unit.unit.text.toLowerCase() + ' ';
    return styleTerms.some((term) => lower.includes(term));
  };
  const concept = cleaned(analysis, ['objective'], seen, changes);
  const direction = cleaned(analysis, ['context', 'requirement'], seen, changes, { where: isStyle });
  const background = cleaned(analysis, ['context'], seen, changes);
  const include = cleaned(analysis, ['requirement'], seen, changes);
  const avoid = cleaned(analysis, ['constraint'], seen, changes);
  const format = cleaned(analysis, ['output'], seen, changes);

  const sections = [
    section('Concept', concept, 'paragraph'),
    section('Background', headings(analysis).map((h) => `Topic: ${h}`).concat(background)),
    section('Direction & Style', direction),
    section('Must Include', include),
    section('Boundaries', avoid),
    section('Format', format),
    section('Reference Material', analysis.codeBlocks, 'verbatim'),
    section('Open Questions (answer if you can, otherwise make a choice and say what it was)', analysis.missingInformation),
  ];
  noteSections(sections, changes);
  changes.flushCounters();
  return render(sections);
}

/**
 * Deterministic, offline prompt formatting. This is explicitly **not** AI: it
 * reorganizes and tidies the user's own words. Every unit of the original
 * prompt is placed in the output exactly once (code blocks verbatim), so no
 * requirement can be lost, and nothing mandatory is ever added — questions and
 * suggestions are clearly labelled as such.
 */
export const LocalFormatter = {
  format(request: EnhancementRequest): LocalFormatterOutput {
    const analysis = PromptAnalyzer.analyze(request.originalPrompt, request.mode);
    const changes = new ChangeLog();
    const warnings: ValidationWarning[] = [];

    let text: string;
    switch (request.mode) {
      case 'quickImprove':
        text = quickImprove(request.originalPrompt, changes);
        break;
      case 'structured':
        text = structured(analysis, changes);
        break;
      case 'professional':
        text = professionalLayout(analysis, changes);
        break;
      case 'developer':
        text = developer(analysis, changes);
        break;
      case 'creative':
        text = creative(analysis, changes);
        break;
      case 'custom':
        text = structured(analysis, changes);
        warnings.push({
          kind: 'customInstructionsIgnored',
          message:
            'Local formatting cannot interpret custom style instructions; the Structured layout was used. Use an AI provider to apply them.',
        });
        break;
    }

    const report: EnhancementReport = {
      objective: analysis.objective !== null ? cleanSentence(analysis.objective) : '',
      explicitRequirements: analysis.requirements.map(cleanSentence),
      constraints: analysis.constraints.map(cleanSentence),
      intendedOutput:
        analysis.outputExpectations.length === 0
          ? 'Not specified in the original prompt.'
          : analysis.outputExpectations.map(cleanSentence).join(' '),
      structuralChanges: changes.entries.length === 0 ? ['No structural changes were needed.'] : changes.entries,
      optionalSuggestions: analysis.ambiguities.map((a) => `${a.note} ${a.suggestion}`),
      missingInformation: analysis.missingInformation,
      assumptions: [],
      ambiguities: analysis.ambiguities.map((a) => a.note),
    };
    return { text, report, warnings };
  },

  /** Cleans a single sentence without changing its meaning. */
  cleanSentence,
  render,
};
