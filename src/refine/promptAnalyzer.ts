/**
 * Ported from HCG RePrompter — Sources/RePrompterCore/PromptAnalyzer.swift (commit 0e91066)
 * © 2026 Hakmi Capital Group.
 * Behaviour change: `PromptAnalysis` carries its derived lists (`objective`, `requirements`,
 * `constraints`, …) as fields computed once by `makePromptAnalysis`; Swift computes them on access.
 */
import type { EnhancementMode } from './enhancementMode';
import { characters, isLetter, isNumber, isSwiftInt, trimSpaces } from './swiftText';
import { TextSanitizer } from './textSanitizer';
import type { PromptUnit } from './textSegmentation';
import { TextSegmenter, Tokenizer } from './textSegmentation';

/** The role a unit of prompt text plays. */
export type UnitRole = 'objective' | 'requirement' | 'constraint' | 'output' | 'context' | 'reference';

/** Broad subject area of a prompt, used to tailor missing-information questions. */
export type PromptDomain =
  | 'software'
  | 'writing'
  | 'research'
  | 'dataAnalysis'
  | 'business'
  | 'education'
  | 'creative'
  | 'general';

export const PROMPT_DOMAINS: readonly PromptDomain[] = [
  'software', 'writing', 'research', 'dataAnalysis', 'business', 'education', 'creative', 'general',
];

export interface ClassifiedUnit {
  unit: PromptUnit;
  role: UnitRole;
  /** True when the unit also states something about output length or format. */
  mentionsOutput: boolean;
  /** True when the unit contains a limit or prohibition, even if it was chosen as the objective. */
  containsConstraint: boolean;
}

export function makeClassifiedUnit(
  unit: PromptUnit,
  role: UnitRole,
  mentionsOutput: boolean,
  containsConstraint = false,
): ClassifiedUnit {
  return { unit, role, mentionsOutput, containsConstraint: containsConstraint || role === 'constraint' };
}

/** A vague or underspecified expression found in the prompt. */
export interface Ambiguity {
  term: string;
  note: string;
  suggestion: string;
}

/**
 * Deterministic analysis of a prompt. Never invents content: every item is
 * either a verbatim unit of the original prompt or a question/observation about it.
 */
export interface PromptAnalysis {
  units: ClassifiedUnit[];
  domain: PromptDomain;
  ambiguities: Ambiguity[];
  /** Questions about information the prompt does not provide. */
  missingInformation: string[];
  wordCount: number;
  /** Text of the objective unit, or null. */
  readonly objective: string | null;
  readonly requirements: string[];
  /** Constraint units, plus the objective when it also states a constraint. */
  readonly constraints: string[];
  readonly outputExpectations: string[];
  readonly context: string[];
  readonly codeBlocks: string[];
}

export function analysisTexts(units: ClassifiedUnit[], role: UnitRole): string[] {
  return units.filter((unit) => unit.role === role).map((unit) => unit.unit.text);
}

export function makePromptAnalysis(fields: {
  units: ClassifiedUnit[];
  domain: PromptDomain;
  ambiguities: Ambiguity[];
  missingInformation: string[];
  wordCount: number;
}): PromptAnalysis {
  const { units } = fields;
  return {
    ...fields,
    objective: units.find((unit) => unit.role === 'objective')?.unit.text ?? null,
    requirements: analysisTexts(units, 'requirement'),
    constraints: units
      .filter((unit) => unit.role === 'constraint' || (unit.role === 'objective' && unit.containsConstraint))
      .map((unit) => unit.unit.text),
    outputExpectations: analysisTexts(units, 'output'),
    context: analysisTexts(units, 'context'),
    codeBlocks: units.filter((unit) => unit.unit.kind === 'codeBlock').map((unit) => unit.unit.text),
  };
}

// MARK: Vocabulary

const negationPhrases = [
  "don't", 'dont', 'do not', 'never', 'avoid', 'must not', "mustn't", 'should not', "shouldn't",
  'without', 'exclude', 'excluding', 'cannot', "can't", "won't", 'no more than', 'not ',
];
const limitPhrases = [
  'at most', 'at least', 'maximum', 'minimum', 'max ', 'min ', 'limit', 'only ', 'under ',
  'less than', 'fewer than', 'more than', 'within', 'no longer than', 'no later than', 'up to ',
  'deadline', 'budget', 'strictly', 'exactly',
];
const outputNouns: ReadonlySet<string> = new Set([
  'list', 'table', 'json', 'markdown', 'csv', 'yaml', 'xml', 'bullet', 'bullets', 'bullet-point',
  'paragraph', 'paragraphs', 'words', 'word', 'sentences', 'pages', 'page', 'slides', 'slide', 'headings',
  'outline', 'summary', 'report', 'essay', 'email', 'diagram', 'chart', 'format', 'formatted',
  'output', 'template', 'checklist', 'tldr', 'step-by-step', 'steps', 'code', 'snippet',
]);
const outputVerbs = [
  'format', 'output', 'return', 'respond', 'reply', 'present', 'structure the', 'write it as',
  'give me', 'deliver', 'provide a', 'provide the', 'answer in', 'answer with', 'keep it',
];
const requirementMarkers = [
  'must', 'should', 'need to', 'needs to', 'have to', 'has to', 'required', 'require', 'make sure',
  'ensure', 'include', 'i want', 'i need', "i'd like", 'i would like', 'we need', 'we want',
  'please', 'it should', 'it must', 'support', 'be able to',
];
const imperativeVerbs: ReadonlySet<string> = new Set([
  'add', 'analyze', 'analyse', 'answer', 'assess', 'build', 'calculate', 'check', 'clarify',
  'classify', 'compare', 'compile', 'compose', 'convert', 'create', 'debug', 'define', 'describe',
  'design', 'detect', 'develop', 'document', 'draft', 'edit', 'estimate', 'evaluate', 'explain',
  'explore', 'extract', 'find', 'fix', 'generate', 'give', 'help', 'identify', 'implement',
  'improve', 'investigate', 'list', 'make', 'map', 'migrate', 'model', 'optimize', 'optimise',
  'organize', 'outline', 'plan', 'predict', 'prepare', 'produce', 'propose', 'provide', 'recommend',
  'refactor', 'research', 'review', 'rewrite', 'show', 'simplify', 'sketch', 'solve', 'suggest',
  'summarize', 'summarise', 'teach', 'tell', 'test', 'translate', 'update', 'use', 'validate',
  'verify', 'visualize', 'write', 'brainstorm', 'proofread', 'rank', 'score', 'audit', 'set',
  'configure', 'deploy', 'port', 'rename', 'remove', 'replace', 'split', 'merge', 'parse',
  'mention', 'highlight', 'emphasize', 'emphasise', 'cover', 'discuss', 'address', 'keep', 'focus',
]);
const questionStarters: ReadonlySet<string> = new Set([
  'how', 'what', 'why', 'which', 'when', 'where', 'who', 'can', 'could', 'would', 'is', 'are',
  'should', 'do', 'does',
]);

const vagueTerms: readonly { term: string; note: string; suggestion: string }[] = [
  ['something', '“something” leaves the subject open.', 'Name the specific thing you want.'],
  ['stuff', '“stuff” is non-specific.', 'List the items you mean.'],
  ['things', '“things” is non-specific.', 'List the items you mean.'],
  ['etc', '“etc.” leaves the list open-ended.', 'Complete the list, or say whether it is exhaustive.'],
  ['and so on', '“and so on” leaves the list open-ended.', 'Complete the list, or say whether it is exhaustive.'],
  ['some', '“some” does not specify a quantity.', 'State how many or how much.'],
  ['a few', '“a few” does not specify a quantity.', 'State an exact number or range.'],
  ['several', '“several” does not specify a quantity.', 'State an exact number or range.'],
  ['a lot', '“a lot” does not specify a quantity.', 'State an exact number or range.'],
  ['various', '“various” does not specify which ones.', 'List the specific items.'],
  ['good', '“good” is subjective.', 'Describe what good means here (criteria or examples).'],
  ['nice', '“nice” is subjective.', 'Describe the qualities you want.'],
  ['better', '“better” needs a reference point.', 'Say better than what, and by which measure.'],
  ['best', '“best” needs criteria.', 'State how “best” should be judged.'],
  ['properly', '“properly” is undefined.', 'Describe the expected behaviour or standard.'],
  ['appropriate', '“appropriate” is undefined.', 'State the standard or criteria to apply.'],
  ['fast', '“fast” is not measurable as written.', 'Give a measurable target (e.g. a time or rate).'],
  ['quickly', '“quickly” is not measurable as written.', 'Give a time frame or performance target.'],
  ['soon', '“soon” has no date.', 'Give a deadline or time frame.'],
  ['simple', '“simple” is subjective.', 'Describe the level of complexity or audience you have in mind.'],
  ['easy', '“easy” is subjective.', 'Describe who should find it easy and in what way.'],
  ['modern', '“modern” is open to interpretation.', 'Name the style, standard or era you mean.'],
  ['clean', '“clean” is open to interpretation.', 'Describe the conventions or qualities you expect.'],
  ['user-friendly', '“user-friendly” is open to interpretation.', 'Describe the users and what they must be able to do.'],
  ['robust', '“robust” is open to interpretation.', 'State which failures or conditions it must handle.'],
  ['scalable', '“scalable” needs a target.', 'State the expected load or growth.'],
  ['efficient', '“efficient” needs a measure.', 'State the resource or metric that matters.'],
  ['optimal', '“optimal” needs criteria.', 'State what should be optimized.'],
  ['as needed', '“as needed” leaves the decision open.', 'State when or how much.'],
  ['if possible', '“if possible” makes the requirement optional.', 'Say whether it is required or optional.'],
  ['maybe', '“maybe” makes the intent uncertain.', 'Say whether it is wanted.'],
  ['kind of', '“kind of” is imprecise.', 'Describe exactly what you mean.'],
  ['sort of', '“sort of” is imprecise.', 'Describe exactly what you mean.'],
  ['whatever', '“whatever” leaves the choice open.', 'State a preference or say any choice is acceptable.'],
  ['high quality', '“high quality” is subjective.', 'State the quality criteria.'],
  ['professional', '“professional” can mean different registers.', 'Describe the tone and audience.'],
].map(([term, note, suggestion]) => ({ term, note, suggestion }));

const domainKeywords: Readonly<Record<Exclude<PromptDomain, 'general'>, ReadonlySet<string>>> = {
  software: new Set([
    'code', 'app', 'application', 'api', 'function', 'bug', 'swift', 'python', 'javascript',
    'typescript', 'java', 'kotlin', 'rust', 'go', 'golang', 'c#', 'c++', 'sql', 'database',
    'backend', 'frontend', 'ui', 'ux', 'server', 'deploy', 'test', 'tests', 'unit', 'refactor',
    'repository', 'repo', 'git', 'endpoint', 'framework', 'library', 'compile', 'build',
    'swiftui', 'react', 'django', 'node', 'ios', 'macos', 'android', 'docker', 'kubernetes',
    'class', 'method', 'variable', 'script', 'cli', 'software', 'implement', 'feature',
  ]),
  writing: new Set([
    'essay', 'article', 'blog', 'post', 'email', 'letter', 'copy', 'write', 'rewrite',
    'proofread', 'edit', 'paragraph', 'tone', 'headline', 'newsletter', 'draft',
  ]),
  research: new Set([
    'research', 'study', 'studies', 'literature', 'sources', 'citations', 'evidence',
    'paper', 'papers', 'hypothesis', 'methodology', 'survey', 'findings', 'cite',
  ]),
  dataAnalysis: new Set([
    'data', 'dataset', 'csv', 'spreadsheet', 'excel', 'chart', 'statistics',
    'regression', 'trend', 'trends', 'metrics', 'kpi', 'dashboard', 'analysis', 'analyze',
  ]),
  business: new Set([
    'business', 'strategy', 'market', 'customers', 'revenue', 'competitors', 'pricing',
    'stakeholders', 'investors', 'pitch', 'plan', 'roadmap', 'sales', 'marketing', 'company',
  ]),
  education: new Set([
    'teach', 'lesson', 'students', 'student', 'course', 'curriculum', 'quiz', 'exam',
    'learn', 'learning', 'explain', 'beginner', 'beginners', 'class', 'tutorial',
  ]),
  creative: new Set([
    'story', 'poem', 'song', 'lyrics', 'character', 'characters', 'novel', 'script',
    'scene', 'fiction', 'illustration', 'image', 'artwork', 'painting', 'design', 'logo',
    'mood', 'style', 'screenplay', 'plot', 'worldbuilding',
  ]),
};

/** Nouns that already imply the form of the response. */
const deliverableNouns: ReadonlySet<string> = new Set([
  'poem', 'poems', 'story', 'stories', 'essay', 'email', 'letter', 'report', 'summary', 'article', 'post',
  'song', 'lyrics', 'script', 'screenplay', 'function', 'class', 'app', 'table', 'list', 'plan', 'outline',
  'presentation', 'slides', 'image', 'logo', 'illustration', 'haiku', 'tweet', 'caption', 'memo',
  'proposal', 'itinerary', 'checklist', 'diagram', 'chart', 'code', 'snippet', 'query', 'recipe', 'quiz',
]);

const languageOrPlatformTerms: ReadonlySet<string> = new Set([
  'swift', 'swiftui', 'uikit', 'appkit', 'python', 'javascript', 'typescript', 'java', 'kotlin', 'go',
  'golang', 'rust', 'c', 'c#', 'c++', 'ruby', 'php', 'sql', 'html', 'css', 'react', 'vue', 'angular',
  'svelte', 'node', 'node.js', 'django', 'flask', 'fastapi', 'rails', 'spring', '.net', 'ios', 'macos',
  'android', 'linux', 'windows', 'web', 'docker', 'kubernetes', 'aws', 'azure', 'gcp', 'postgres',
  'postgresql', 'mysql', 'sqlite', 'mongodb', 'redis', 'bash', 'shell', 'powershell', 'terraform',
  'flutter', 'dart', 'scala', 'elixir', 'haskell', 'r', 'matlab', 'julia', 'unity', 'unreal',
]);
const audienceTerms = [
  'audience', 'reader', 'readers', 'for my', 'for our', 'for a ', 'for an ', 'beginner', 'beginners',
  'executive', 'executives', 'students', 'customers', 'clients', 'team', 'stakeholders', 'kids',
  'children', 'experts', 'engineers', 'developers', 'managers', 'investors', 'users', 'board',
];
const lengthTerms = [
  'words', 'word', 'pages', 'page', 'sentences', 'sentence', 'paragraph', 'paragraphs', 'short',
  'brief', 'concise', 'detailed', 'in-depth', 'length', 'long', 'minutes', 'slides', 'characters',
  'tl;dr', 'tldr', 'one-pager', 'summary',
];
const toneTerms = ['tone', 'style', 'mood', 'voice', 'feel', 'genre', 'register', 'formal', 'informal', 'casual', 'playful', 'serious', 'witty'];
const testTerms = ['test', 'tests', 'testing', 'unit test', 'unit tests', 'qa', 'coverage', 'tdd', 'xctest', 'pytest', 'jest'];
const acceptanceTerms = ['acceptance', 'criteria', 'done when', 'definition of done', 'success', 'succeed', 'pass', 'expected result'];

const formatLeadIns: ReadonlySet<string> = new Set(['as', 'in', 'into', 'using']);
const interjections: ReadonlySet<string> = new Set(['hey', 'hi', 'hello', 'so', 'ok', 'okay', 'um', 'uh', 'basically', 'please']);

// MARK: Analysis

function isConstraint(lower: string): boolean {
  if (negationPhrases.some((phrase) => lower.includes(' ' + phrase))) return true;
  if (lower.startsWith(' no ')) return true;
  return limitPhrases.some((phrase) => lower.includes(' ' + phrase));
}

function isOutputStatement(lower: string, words: string[]): boolean {
  if (lower.includes(' format')) return true;
  const hasVerb = outputVerbs.some((verb) => lower.includes(' ' + verb));
  for (let index = 0; index < words.length; index += 1) {
    if (!outputNouns.has(words[index])) continue;
    if (hasVerb) return true;
    // "as a table", "in JSON", "into bullet points", "under 200 words", "3 paragraphs"
    const previous = words.slice(Math.max(0, index - 2), index);
    if (previous.some((word) => formatLeadIns.has(word) || isSwiftInt(word))) return true;
  }
  return false;
}

function isRequirement(lower: string, words: string[], raw: string): boolean {
  if (requirementMarkers.some((marker) => lower.includes(' ' + marker + ' ') || lower.includes(' ' + marker + ','))) {
    return true;
  }
  const first = words[0];
  if (first !== undefined && imperativeVerbs.has(first)) return true;
  if (trimSpaces(raw).endsWith('?')) return true;
  if (first !== undefined && questionStarters.has(first) && words.length > 2) return true;
  return false;
}

function classify(unit: PromptUnit): ClassifiedUnit {
  if (unit.kind === 'codeBlock' || unit.kind === 'heading') {
    return makeClassifiedUnit(unit, 'reference', false);
  }
  const lower = ' ' + unit.text.toLowerCase() + ' ';
  const words = Tokenizer.words(unit.text);
  const mentionsOutput = isOutputStatement(lower, words);

  if (isConstraint(lower)) return makeClassifiedUnit(unit, 'constraint', mentionsOutput);
  if (mentionsOutput) return makeClassifiedUnit(unit, 'output', true);
  if (isRequirement(lower, words, unit.text)) return makeClassifiedUnit(unit, 'requirement', false);
  return makeClassifiedUnit(unit, 'context', false);
}

function isObjectiveCandidate(text: string): boolean {
  const words = Tokenizer.words(text);
  while (words.length > 1 && interjections.has(words[0])) words.shift();
  const first = words[0];
  if (first === undefined) return false;
  const lower = words.join(' ');
  return (
    imperativeVerbs.has(first) ||
    questionStarters.has(first) ||
    ['i want', 'i need', "i'd like", 'i would like', 'we need', 'we want', 'help me', 'please'].some((p) => lower.startsWith(p))
  );
}

function detectDomain(words: string[]): PromptDomain {
  let best: PromptDomain = 'general';
  let bestScore = 0;
  for (const domain of PROMPT_DOMAINS) {
    if (domain === 'general') continue;
    const keywords = domainKeywords[domain];
    const score = words.reduce((sum, word) => sum + (keywords.has(word) ? 1 : 0), 0);
    if (score > bestScore) {
      best = domain;
      bestScore = score;
    }
  }
  return bestScore >= 1 ? best : 'general';
}

function detectAmbiguities(units: PromptUnit[]): Ambiguity[] {
  const found: Ambiguity[] = [];
  const seen = new Set<string>();
  const prose = units.filter((unit) => unit.kind !== 'codeBlock');
  const joined = ' ' + prose.map((unit) => unit.text.toLowerCase()).join(' ') + ' ';
  const normalized = characters(joined)
    .map((c) => (isLetter(c) || isNumber(c) || c === '-' || c === "'" ? c : ' '))
    .join('');
  const spaced = ' ' + normalized.split(' ').filter((part) => part !== '').join(' ') + ' ';

  for (const entry of vagueTerms) {
    if (seen.has(entry.term)) continue;
    if (spaced.includes(' ' + entry.term + ' ')) {
      found.push({ term: entry.term, note: entry.note, suggestion: entry.suggestion });
      seen.add(entry.term);
    }
  }

  const first = prose.find((unit) => unit.kind !== 'heading');
  if (first) {
    const firstWord = Tokenizer.words(first.text)[0] ?? '';
    if (['it', 'this', 'that', 'they', 'these', 'those'].includes(firstWord)) {
      found.unshift({
        term: firstWord,
        note: `The prompt opens with “${firstWord}”, which has no clear referent.`,
        suggestion: `Name what “${firstWord}” refers to.`,
      });
    }
  }
  return found;
}

function missingInformation(
  lowered: string,
  words: ReadonlySet<string>,
  units: ClassifiedUnit[],
  domain: PromptDomain,
  mode: EnhancementMode,
): string[] {
  const questions: string[] = [];
  const padded = ' ' + lowered + ' ';
  const mentions = (terms: readonly string[]): boolean =>
    terms.some((term) => (term.includes(' ') ? padded.includes(term) : words.has(term)));
  const hasOutputSpec =
    units.some((unit) => unit.mentionsOutput || unit.role === 'output') ||
    [...words].some((word) => deliverableNouns.has(word));
  const substantive = units.filter((unit) => unit.unit.kind !== 'codeBlock').length;

  if (!hasOutputSpec) {
    questions.push('What form should the response take (for example a list, table, paragraphs or code)?');
  }
  const isSoftware = mode === 'developer' || domain === 'software';
  if (isSoftware) {
    if (![...words].some((word) => languageOrPlatformTerms.has(word))) {
      questions.push('Which programming language, framework or platform should be used?');
    }
    if (mode === 'developer') {
      if (!mentions(acceptanceTerms)) questions.push('How will you judge the work complete (acceptance criteria)?');
      if (!mentions(testTerms)) questions.push('What testing is expected (for example unit tests, integration tests, or none)?');
    }
  } else {
    if ((mode === 'structured' || mode === 'professional' || mode === 'creative') && !mentions(audienceTerms)) {
      questions.push('Who is the intended audience?');
    }
    if (!mentions(lengthTerms) && mode !== 'quickImprove') {
      questions.push('How long or detailed should the response be?');
    }
  }
  if (mode === 'creative' && !mentions(toneTerms)) {
    questions.push('What tone or style should the piece have?');
  }
  const firstUnitWords = units.length > 0 ? Tokenizer.words(units[0].unit.text).length : 0;
  if (substantive <= 1 && firstUnitWords < 6) {
    questions.push('Can you add context about the situation or purpose behind this request?');
  }
  return questions;
}

function analyze(text: string, mode: EnhancementMode = 'structured'): PromptAnalysis {
  const units = TextSegmenter.segment(TextSanitizer.sanitize(text));
  const classified = units.map(classify);

  // Choose the objective: the first requirement-like or question unit, otherwise the first sentence.
  const candidates: ((unit: ClassifiedUnit) => boolean)[] = [
    (unit) => unit.role === 'requirement' && isObjectiveCandidate(unit.unit.text),
    (unit) => unit.role !== 'reference' && isObjectiveCandidate(unit.unit.text),
    (unit) => unit.role === 'requirement',
    (unit) => unit.role === 'context' && unit.unit.kind !== 'heading',
  ];
  for (const predicate of candidates) {
    const index = classified.findIndex(predicate);
    if (index >= 0) {
      classified[index] = { ...classified[index], role: 'objective' };
      break;
    }
  }

  const lowered = text.toLowerCase();
  const words = Tokenizer.words(text);
  const domain = detectDomain(words);

  return makePromptAnalysis({
    units: classified,
    domain,
    ambiguities: detectAmbiguities(units),
    missingInformation: missingInformation(lowered, new Set(words), classified, domain, mode),
    wordCount: words.length,
  });
}

export const PromptAnalyzer = {
  negationPhrases,
  limitPhrases,
  outputNouns,
  outputVerbs,
  requirementMarkers,
  imperativeVerbs,
  questionStarters,
  vagueTerms,
  domainKeywords,
  deliverableNouns,
  languageOrPlatformTerms,
  audienceTerms,
  lengthTerms,
  toneTerms,
  testTerms,
  acceptanceTerms,

  analyze,
  classify,
  isConstraint,
  isOutputStatement,
  isRequirement,
  isObjectiveCandidate,
  detectDomain,
  detectAmbiguities,
  missingInformation,
};
