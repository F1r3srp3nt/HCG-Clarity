// Ported from HCG RePrompter — Tests/RePrompterTests/CoreTests.swift `Fixtures` (commit 0e91066)
// © 2026 Hakmi Capital Group.

export const developerPrompt =
  'hey, i need a function that parses CSV files in Swift. it should handle quoted fields and ' +
  'return an array of dictionaries. Do not use any third-party libraries. Performance should be fast ' +
  'for files up to 50 MB. Return the code in a single file named CSVParser.swift.';

export const mixedPrompt = [
  '# Quarterly update',
  '',
  'Write an email to the board about our Q3 results. Revenue grew 12% to $4.2M.',
  '- Mention the new office in Oslo',
  '- Keep it under 200 words',
  '- Never mention the pending lawsuit',
  '',
  '```',
  'let total = revenue * 1.12',
  '```',
].join('\n');

export const corpus: string[] = [
  developerPrompt,
  mixedPrompt,
  'Explain photosynthesis to a 10-year-old. Use one analogy and keep it short.',
  'write a poem about the sea, something melancholic, avoid rhymes about love etc',
  "Compare PostgreSQL and SQLite for a macOS app. Output a table. Don't recommend MongoDB.",
  'Can you help me plan a 3-day trip to Bergen in May? Budget is 5000 NOK.',
  'it doesnt work. fix it',
  'Summarize the attached report in 5 bullet points for executives. Include risks.',
];

/** `ResponseValidatorTests.json(_:extra:)`. */
export function contractJSON(enhanced = 'Rewritten: Write a haiku about 5 cats.', extra = ''): string {
  return (
    `{"enhanced_prompt": ${JSON.stringify(enhanced)}, "objective": "Haiku", "intended_output": "A haiku",\n` +
    ` "explicit_requirements": ["about cats"], "constraints": [], "structural_changes": ["Clarified"],\n` +
    ` "optional_suggestions": [], "missing_information": [], "assumptions": [], "ambiguities": []${extra}}`
  );
}
