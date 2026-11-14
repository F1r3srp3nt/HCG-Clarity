/**
 * Ported from HCG RePrompter — Sources/RePrompterCore/PromptTemplate.swift (commit 0e91066)
 * © 2026 Hakmi Capital Group.
 * Behaviour change: `placeholders` is a function (`templatePlaceholders`) rather than a computed property.
 */
import type { EnhancementMode } from './enhancementMode';
import { makeUUID } from './enhancementModels';
import { count, replaceAll, trimSpaces, trimSpacesAndNewlines } from './swiftText';

export type TemplateCategory =
  | 'softwareDevelopment'
  | 'businessStrategy'
  | 'research'
  | 'writing'
  | 'dataAnalysis'
  | 'education'
  | 'creativeWork';

export const TEMPLATE_CATEGORIES: readonly TemplateCategory[] = [
  'softwareDevelopment', 'businessStrategy', 'research', 'writing', 'dataAnalysis', 'education', 'creativeWork',
];

export const TEMPLATE_CATEGORY_DETAILS: Readonly<Record<TemplateCategory, { displayName: string; symbolName: string }>> = {
  softwareDevelopment: { displayName: 'Software Development', symbolName: 'hammer' },
  businessStrategy: { displayName: 'Business Strategy', symbolName: 'chart.line.uptrend.xyaxis' },
  research: { displayName: 'Research', symbolName: 'magnifyingglass' },
  writing: { displayName: 'Writing', symbolName: 'pencil.line' },
  dataAnalysis: { displayName: 'Data Analysis', symbolName: 'tablecells' },
  education: { displayName: 'Education', symbolName: 'graduationcap' },
  creativeWork: { displayName: 'Creative Work', symbolName: 'sparkles' },
};

/** A reusable starting point for a prompt. Placeholders use `{{name}}`. */
export interface PromptTemplate {
  id: string;
  name: string;
  category: TemplateCategory;
  summary: string;
  body: string;
  suggestedMode: EnhancementMode;
  isBuiltIn: boolean;
  updatedAt: Date;
}

export function makePromptTemplate(
  fields: Omit<PromptTemplate, 'id' | 'isBuiltIn' | 'updatedAt'> & Partial<Pick<PromptTemplate, 'id' | 'isBuiltIn' | 'updatedAt'>>,
): PromptTemplate {
  return {
    ...fields,
    id: fields.id ?? makeUUID(),
    isBuiltIn: fields.isBuiltIn ?? false,
    updatedAt: fields.updatedAt ?? new Date(),
  };
}

export const TemplateRenderer = {
  /** Placeholder names in order of first appearance. */
  placeholders(text: string): string[] {
    const names: string[] = [];
    let remainder = text;
    for (;;) {
      const open = remainder.indexOf('{{');
      if (open < 0) break;
      const afterOpen = remainder.slice(open + 2);
      const close = afterOpen.indexOf('}}');
      if (close < 0) break;
      const name = trimSpaces(afterOpen.slice(0, close));
      if (name !== '' && count(name) <= 60 && !name.includes('{') && !names.includes(name)) names.push(name);
      remainder = afterOpen.slice(close + 2);
    }
    return names;
  },

  /**
   * Replaces `{{name}}` placeholders with the supplied values. Unfilled
   * placeholders are left in place so the user can see what is missing.
   */
  fill(text: string, values: Readonly<Record<string, string>>): string {
    let result = text;
    for (const [name, value] of Object.entries(values)) {
      if (trimSpacesAndNewlines(value) === '') continue;
      for (const variant of [`{{${name}}}`, `{{ ${name} }}`]) {
        result = replaceAll(result, variant, value);
      }
    }
    return result;
  },
};

/** Placeholder names of a template in order of first appearance. */
export function templatePlaceholders(template: PromptTemplate): string[] {
  return TemplateRenderer.placeholders(template.body);
}

const epoch = new Date(1_790_000_000 * 1000);

function builtIn(
  id: string,
  name: string,
  category: TemplateCategory,
  summary: string,
  lines: string[],
  suggestedMode: EnhancementMode,
): PromptTemplate {
  return { id, name, category, summary, body: lines.join('\n'), suggestedMode, isBuiltIn: true, updatedAt: epoch };
}

/** The initial, deliberately small template library. */
export const BuiltInTemplates = {
  epoch,
  all: [
    builtIn(
      'builtin.software.feature',
      'Feature Implementation',
      'softwareDevelopment',
      'Brief an AI on a feature you want built, with constraints and tests.',
      [
        'Implement {{feature}} in {{project or codebase}}.',
        'The code is written in {{language and framework}}.',
        'Users should be able to {{what users can do once it works}}.',
        'Do not change {{areas that must stay untouched}}.',
        'Include unit tests for the new behaviour.',
        'Explain any design decisions that are not obvious.',
      ],
      'developer',
    ),
    builtIn(
      'builtin.software.bug',
      'Bug Investigation',
      'softwareDevelopment',
      'Describe a defect so the AI can diagnose the root cause before fixing it.',
      [
        'Help me find the root cause of a bug in {{component}}.',
        'Expected behaviour: {{what should happen}}.',
        'Actual behaviour: {{what happens instead}}.',
        'Steps to reproduce: {{steps}}.',
        'Relevant error output: {{error message or log excerpt}}.',
        'Explain the likely cause before proposing a fix, and keep the fix minimal.',
      ],
      'developer',
    ),
    builtIn(
      'builtin.software.review',
      'Code Review',
      'softwareDevelopment',
      'Ask for a focused review of a change.',
      [
        'Review the following {{language}} code for correctness, security and maintainability.',
        'Focus especially on {{area of concern}}.',
        'List issues in order of severity and suggest a concrete fix for each.',
        'Do not rewrite code that has no problems.',
        '',
        '{{code}}',
      ],
      'developer',
    ),
    builtIn(
      'builtin.business.options',
      'Strategic Options Analysis',
      'businessStrategy',
      'Compare strategic options against explicit criteria.',
      [
        'Compare the following strategic options for {{organization}}: {{options}}.',
        'Our goal is {{goal}} within {{time frame}}.',
        'Evaluate each option against {{criteria}}.',
        'Present the comparison as a table, followed by a recommendation and its main risks.',
        'Base the analysis only on the information provided and state clearly where more data is needed.',
      ],
      'structured',
    ),
    builtIn(
      'builtin.research.scope',
      'Research Question Scoping',
      'research',
      'Turn a broad topic into a researchable question and plan.',
      [
        'I am researching {{topic}} for {{purpose or audience}}.',
        'Help me narrow this into one or two precise research questions.',
        'For each question, suggest the kinds of sources and evidence that would answer it.',
        'Point out terms that need definitions and any likely sources of bias.',
        'Do not invent citations; describe source types instead.',
      ],
      'structured',
    ),
    builtIn(
      'builtin.writing.email',
      'Professional Email',
      'writing',
      'Draft a clear email with the right tone for the recipient.',
      [
        'Write an email to {{recipient and relationship}} about {{subject}}.',
        'The purpose of the email is to {{desired outcome}}.',
        'Key points to include: {{key points}}.',
        'Keep it under {{word limit}} words and use a {{tone}} tone.',
      ],
      'professional',
    ),
    builtIn(
      'builtin.data.explore',
      'Dataset Exploration',
      'dataAnalysis',
      'Plan an exploratory analysis of a dataset.',
      [
        'I have a dataset of {{what the data describes}} with these columns: {{columns}}.',
        'I want to understand {{question you want answered}}.',
        'Suggest an exploratory analysis plan, including data-quality checks, summary statistics and charts.',
        'Use {{tool or language}} for any code.',
        'Flag any conclusions that the data cannot support.',
      ],
      'structured',
    ),
    builtIn(
      'builtin.education.explain',
      'Concept Explanation',
      'education',
      'Explain a concept at the right level for a specific learner.',
      [
        'Explain {{concept}} to {{learner and their current level}}.',
        'Use one concrete example from {{familiar domain}}.',
        'Check understanding with three short questions at the end, with answers listed separately.',
        'Avoid jargon unless you define it first.',
      ],
      'structured',
    ),
    builtIn(
      'builtin.creative.story',
      'Short Story Brief',
      'creativeWork',
      'Set up a short story with clear creative direction.',
      [
        'Write a short story about {{premise}}.',
        'The main character is {{character}}.',
        'The tone should be {{tone}}, in the style of {{style reference}}.',
        'It should be around {{length}} and end with {{type of ending}}.',
        'Avoid {{things to avoid}}.',
      ],
      'creative',
    ),
    builtIn(
      'builtin.creative.visual',
      'Visual Design Brief',
      'creativeWork',
      'Describe an image or design for an image-generation or design assistant.',
      [
        'Create {{type of visual}} showing {{subject}}.',
        'The mood should be {{mood}} with a {{colour palette}} colour palette.',
        'The composition should emphasise {{focal point}}.',
        'It will be used for {{intended use and format}}.',
        'Do not include {{elements to exclude}}.',
      ],
      'creative',
    ),
  ] as readonly PromptTemplate[],
};
